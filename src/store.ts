import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  Agent,
  Claim,
  Command,
  Entity,
  Event,
  Kind,
  NexoError,
  assert,
  claimSchema,
  commandSchema,
  deliverySchema,
  taskSchema,
  teamSchema,
} from './model.js';
import { atomicWrite, loadConfig, localDir, safeEventsDir } from './project.js';
import { acquireWriter } from './locks.js';
import { Snapshots } from './snapshots.js';

const schema = `PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT PRIMARY KEY,version INTEGER NOT NULL,data TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS entity_kind ON entities(kind);
CREATE INDEX IF NOT EXISTS entity_parent ON entities(json_extract(data,'$.parentId')) WHERE kind='task';
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,command_id TEXT NOT NULL,event TEXT NOT NULL,exported INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS event_command ON events(command_id);
CREATE INDEX IF NOT EXISTS event_outbox ON events(exported) WHERE exported=0;
CREATE TABLE IF NOT EXISTS conflicts(event_id TEXT PRIMARY KEY,reason TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS resolutions(event_id TEXT PRIMARY KEY);
CREATE TABLE IF NOT EXISTS agents(agent_id TEXT PRIMARY KEY,task_id TEXT NOT NULL,token TEXT UNIQUE NOT NULL,fence INTEGER NOT NULL,data TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS agent_task ON agents(task_id,expires_at);
CREATE TABLE IF NOT EXISTS fences(task_id TEXT PRIMARY KEY,value INTEGER NOT NULL);
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(id UNINDEXED,title,description,tokenize='unicode61');`;
const hash = (e: Omit<Event, 'hash'>) =>
  crypto.createHash('sha256').update(JSON.stringify(e)).digest('hex');
const parse = (r: any): Entity => ({
  kind: r.kind,
  id: r.id,
  version: r.version,
  data: JSON.parse(r.data),
  updatedAt: r.updated_at,
});
const schemaFor = (kind: Kind) =>
  kind === 'delivery' ? deliverySchema : kind === 'task' ? taskSchema : teamSchema;

export class Store {
  db!: DatabaseSync;
  config;
  dir: string;
  eventsDir: string;
  revision = 0;
  onChange = (_durable: boolean) => {};
  snapshots!: Snapshots;
  private releaseWriter: () => void;
  closed = false;
  private directoryStamp = '';
  private fileCache = new Map<string, { stamp: string; event: Event }>();
  constructor(public root: string) {
    this.config = loadConfig(root);
    this.dir = localDir(root);
    this.eventsDir = safeEventsDir(root);
    this.releaseWriter = acquireWriter(root);
    try {
      this.db = new DatabaseSync(path.join(this.dir, 'state.sqlite'), { timeout: 5000 });
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.db.exec(schema);
      const version = this.db.prepare('SELECT value FROM meta WHERE key=?').get('schema');
      assert(
        !version || version.value === '1',
        'SCHEMA_VERSION',
        'Unsupported database version. Update Nexo.',
      );
      this.db.prepare('INSERT OR IGNORE INTO meta VALUES(?,?)').run('schema', '1');
      this.snapshots = new Snapshots(path.join(root, '.nexo', 'project.sqlite'), () =>
        this.stageSnapshot(),
      );
      // Recover a committed outbox before importing files changed by Git.
      this.exportEvents();
      this.sync();
      if (!this.db.prepare('SELECT value FROM meta WHERE key=?').get('frontier')) {
        const events = this.events(),
          frontier = new Set(events.map((e) => e.id));
        for (const e of events) for (const p of e.parents) frontier.delete(p);
        this.db
          .prepare('INSERT INTO meta VALUES(?,?)')
          .run('frontier', JSON.stringify([...frontier].sort()));
      }
    } catch (e) {
      try {
        this.db?.close();
      } finally {
        this.releaseWriter();
      }
      throw e;
    }
  }
  close() {
    if (!this.closed) {
      this.snapshots.stop();
      this.db.close();
      this.closed = true;
      this.releaseWriter();
    }
  }
  get(id: string): Entity | undefined {
    const r = this.db.prepare('SELECT * FROM entities WHERE id=?').get(id);
    return r ? parse(r) : undefined;
  }
  all(kind?: Kind): Entity[] {
    return (
      kind
        ? this.db.prepare('SELECT * FROM entities WHERE kind=? ORDER BY id').all(kind)
        : this.db.prepare('SELECT * FROM entities ORDER BY id').all()
    ).map(parse);
  }
  events(): Event[] {
    return this.db
      .prepare('SELECT event FROM events ORDER BY id')
      .all()
      .map((r) => JSON.parse(r.event as string));
  }
  conflicts() {
    return this.db
      .prepare('SELECT * FROM conflicts WHERE event_id NOT IN (SELECT event_id FROM resolutions)')
      .all();
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.db.exec('COMMIT');
      return value;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  changed(durable = true) {
    this.revision++;
    if (durable) this.snapshots.markDirty();
    this.onChange(durable);
  }
  validate(command: Command): Entity {
    const current = this.get(command.id);
    assert(
      command.op === 'create' ? !current : current,
      'NOT_FOUND',
      command.op === 'create' ? 'ID already exists' : 'Entity not found',
    );
    assert(
      (current?.version ?? 0) === command.expectedVersion,
      'VERSION_CONFLICT',
      'Version changed. Read state and replan.',
    );
    assert(
      !current || current.kind === command.kind,
      'KIND_MISMATCH',
      'Entity kind does not match',
    );
    const input = { ...(current?.data ?? {}), ...command.data, id: command.id };
    const data: any = schemaFor(command.kind).parse(input);
    if (current && command.kind !== 'delivery') {
      assert(
        data.deliveryId === current.data.deliveryId,
        'IMMUTABLE_SCOPE',
        'Do not move cards or teams between deliveries',
      );
    }
    if (command.kind === 'delivery') {
      assert(
        current?.data.status !== 'accepted',
        'ACCEPTED_DELIVERY',
        'Accepted deliveries are immutable. Create a new delivery.',
      );
      assert(
        command.op === 'accept' || data.status !== 'accepted',
        'ACCEPT_REQUIRED',
        'Use accept to accept the delivery',
      );
      if (data.revisionOf) {
        const previous = this.get(data.revisionOf);
        assert(
          previous?.kind === 'delivery',
          'INVALID_REVISION',
          'Previous delivery does not exist',
        );
      }
      const tasks = this.all('task').filter((t) => t.data.deliveryId === data.id);
      for (const t of tasks)
        assert(
          data.workflow.some((s: any) => s.id === t.data.stageId),
          'STAGE_IN_USE',
          'A stage in use cannot be removed',
        );
      if (current) {
        for (const t of tasks) {
          const old = current.data.workflow.find((s: any) => s.id === t.data.stageId);
          const next = data.workflow.find((s: any) => s.id === t.data.stageId);
          assert(
            old?.phase === next?.phase,
            'STAGE_IN_USE',
            'Do not change the meaning of a stage in use; create another stage',
          );
        }
      }
      if (command.op === 'accept') {
        assert(
          tasks.length &&
            tasks.every(
              (t) => data.workflow.find((s: any) => s.id === t.data.stageId)?.phase === 'done',
            ),
          'INCOMPLETE_DELIVERY',
          'All cards must be completed',
        );
        assert(data.result?.trim(), 'RESULT_REQUIRED', 'Record the delivery result');
        assert(
          !this.agents().some((a) => tasks.some((t) => t.id === a.taskId) && a.state === 'working'),
          'ACTIVE_AGENTS',
          'Release the agents before accepting',
        );
        data.status = 'accepted';
      }
    } else {
      const delivery = this.get(data.deliveryId);
      assert(delivery?.kind === 'delivery', 'INVALID_DELIVERY', 'Delivery not found');
      assert(
        delivery.data.status !== 'accepted',
        'ACCEPTED_DELIVERY',
        'Accepted deliveries are immutable',
      );
      assert(command.op !== 'accept', 'INVALID_OPERATION', 'Use update for cards and teams');
      if (command.kind === 'task') {
        assert(
          delivery.data.workflow.some((s: any) => s.id === data.stageId),
          'INVALID_STAGE',
          'Stage does not exist in the delivery',
        );
        if (data.teamId) {
          const team = this.get(data.teamId);
          assert(
            team?.kind === 'team' && team.data.deliveryId === data.deliveryId,
            'INVALID_TEAM',
            'Team does not belong to the delivery',
          );
        }
        if (data.parentId) {
          const parent = this.get(data.parentId);
          assert(
            parent?.kind === 'task' && parent.data.deliveryId === data.deliveryId,
            'INVALID_PARENT',
            'Parent card does not belong to the delivery',
          );
          assert(
            this.get(parent.data.deliveryId)?.data.workflow.find(
              (s: any) => s.id === parent.data.stageId,
            )?.phase !== 'done',
            'PARENT_DONE',
            'Reopen the parent before changing its composition',
          );
        }
        assert(
          new Set(data.dependencies).size === data.dependencies.length,
          'DUPLICATE_DEPENDENCY',
          'Duplicate dependencies',
        );
        for (const dep of data.dependencies)
          assert(this.get(dep)?.kind === 'task', 'INVALID_DEPENDENCY', 'Dependency does not exist');
        const tasks = new Map<string, any>([[data.id, data]]);
        const taskData = (id: string) => {
          if (!tasks.has(id)) tasks.set(id, this.get(id)?.data);
          return tasks.get(id);
        };
        const childData = (id: string) => {
          const list = this.db
            .prepare(
              "SELECT * FROM entities WHERE kind='task' AND json_extract(data,'$.parentId')=?",
            )
            .all(id)
            .map(parse)
            .filter((t) => t.id !== data.id)
            .map((t) => t.data);
          if (data.parentId === id) list.push(data);
          return list;
        };
        // New root IDs cannot be referenced yet. Stage-only updates cannot introduce cycles.
        const graphChanged = current
          ? current.data.parentId !== data.parentId ||
            JSON.stringify(current.data.dependencies) !== JSON.stringify(data.dependencies)
          : !!data.parentId;
        if (graphChanged) {
          assertAcyclic(
            data.id,
            (node) => (taskData(node)?.parentId ? [taskData(node).parentId] : []),
            'Cycle in hierarchy or dependencies',
          );
          assertAcyclic(
            data.id,
            (node) => taskData(node)?.dependencies ?? [],
            'Cycle in hierarchy or dependencies',
          );
          assertAcyclic(
            data.id,
            (node) => [
              ...(taskData(node)?.dependencies ?? []),
              ...childData(node).map((t) => t.id),
            ],
            'Dependency blocks its own hierarchy',
          );
        }
        const isDone = (t: any) => {
          const d = this.get(t.deliveryId);
          return d?.data.workflow.find((s: any) => s.id === t.stageId)?.phase === 'done';
        };
        const phase = delivery.data.workflow.find((s: any) => s.id === data.stageId).phase;
        if (phase === 'done' || phase === 'active') {
          assert(
            !data.blocker,
            'BLOCKED',
            'Resolve the blocker before starting or completing work',
          );
          assert(
            data.dependencies.every((dep: string) => isDone(taskData(dep))),
            'DEPENDENCIES_PENDING',
            'Dependencies must be completed',
          );
        }
        if (phase === 'done') {
          assert(
            childData(data.id).every(isDone),
            'CHILDREN_PENDING',
            'Subtasks must be completed',
          );
          assert(
            data.result.trim() && data.evidence.length,
            'EVIDENCE_REQUIRED',
            'Completion requires a result and evidence',
          );
          const gates = delivery.data.workflow.filter((s: any) => s.gate);
          if (gates.length)
            assert(
              data.evidence.some((e: any) => e.commit),
              'COMMIT_REQUIRED',
              'A gated delivery requires evidence linked to the validated commit',
            );
        }
        // Reopening a prerequisite would invalidate completed dependents or ancestors.
        if (current && isDone(current.data) && phase !== 'done') {
          assert(
            !this.all('task')
              .map((t) => (t.id === data.id ? data : t.data))
              .some(
                (t) => isDone(t) && (t.dependencies.includes(data.id) || t.id === data.parentId),
              ),
            'COMPLETED_DEPENDENT',
            'Reopen completed dependents before this card',
          );
        }
      }
    }
    return {
      kind: command.kind,
      id: data.id,
      version: (current?.version ?? 0) + 1,
      data,
      updatedAt: new Date().toISOString(),
    };
  }
  private apply(event: Event) {
    const entity = this.validate(event.command);
    entity.updatedAt = event.at;
    this.db
      .prepare(
        'INSERT INTO entities VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,data=excluded.data,updated_at=excluded.updated_at',
      )
      .run(entity.kind, entity.id, entity.version, JSON.stringify(entity.data), event.at);
    const rowid = this.db.prepare('SELECT rowid FROM entities WHERE id=?').get(entity.id)!.rowid;
    this.db.prepare('DELETE FROM search WHERE rowid=?').run(rowid);
    this.db
      .prepare('INSERT INTO search(rowid,id,title,description) VALUES(?,?,?,?)')
      .run(rowid, entity.id, entity.data.title, entity.data.description);
    return entity;
  }
  execute(raw: unknown) {
    const command = commandSchema.parse(raw);
    this.sync(false);
    assert(
      !this.conflicts().length,
      'MERGE_CONFLICT',
      'Divergent events require resolution. Run doctor.',
    );
    const duplicate = this.db
      .prepare('SELECT event FROM events WHERE command_id=?')
      .get(command.commandId);
    if (duplicate) {
      const original = JSON.parse(duplicate.event as string) as Event;
      const { leaseToken: _, ...clean } = command;
      assert(
        JSON.stringify(original.command) === JSON.stringify(clean),
        'IDEMPOTENCY_MISMATCH',
        'commandId reused with different content',
      );
      this.exportEvents();
      return { entity: this.get(command.id), eventId: original.id, duplicate: true };
    }
    const result = this.transaction(() => {
      const claims = this.agents().filter(
        (a) => a.taskId === command.id && a.role === 'executor' && a.state === 'working',
      );
      if (command.kind === 'task' && claims.length)
        assert(
          command.leaseToken === claims[0].token,
          'LEASE_REQUIRED',
          'An active card requires its current lease',
        );
      if (command.leaseToken)
        assert(
          this.agents().some(
            (a) =>
              a.token === command.leaseToken && a.taskId === command.id && a.state === 'working',
          ),
          'STALE_LEASE',
          'Lease expired or replaced',
        );
      if (command.kind === 'task') {
        const current = this.get(command.id);
        const d = current ? this.get(current.data.deliveryId) : undefined;
        if (d?.data.workflow.find((s: any) => s.id === command.data.stageId)?.phase === 'done')
          assert(
            !this.agents().some(
              (a) =>
                a.taskId === command.id && a.state === 'working' && a.token !== command.leaseToken,
            ),
            'ACTIVE_COLLABORATORS',
            'Wait for collaborators to release the card',
          );
      }
      if (
        command.kind === 'task' &&
        this.db.prepare('SELECT value FROM fences WHERE task_id=?').get(command.id)
      ) {
        const task = this.get(command.id);
        const delivery = task ? this.get(task.data.deliveryId) : undefined;
        if (
          delivery?.data.workflow.find((s: any) => s.id === command.data.stageId)?.phase === 'done'
        )
          assert(
            command.leaseToken,
            'LEASE_REQUIRED',
            'A previously claimed card requires a valid lease for completion',
          );
      }
      const { leaseToken: _, ...clean } = command;
      const parents = JSON.parse(
        String(
          this.db.prepare('SELECT value FROM meta WHERE key=?').get('frontier')?.value ?? '[]',
        ),
      );
      const body = {
        schema: 1 as const,
        projectId: this.config.id,
        id: crypto.randomUUID(),
        parents,
        at: new Date().toISOString(),
        command: clean,
      };
      const event: Event = { ...body, hash: hash(body) };
      const entity = this.apply(event);
      this.db
        .prepare('INSERT INTO events(id,command_id,event) VALUES(?,?,?)')
        .run(event.id, command.commandId, JSON.stringify(event));
      this.db
        .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('frontier', JSON.stringify([event.id]));
      if (command.kind === 'task') {
        const d = this.get(entity.data.deliveryId);
        if (d?.data.workflow.find((s: any) => s.id === entity.data.stageId)?.phase === 'done')
          this.db.prepare('DELETE FROM agents WHERE task_id=?').run(command.id);
      }
      return { entity, eventId: event.id, duplicate: false };
    });
    this.changed();
    this.exportEvents();
    return result;
  }
  exportEvents() {
    let wrote = false;
    for (const row of this.db.prepare('SELECT event FROM events WHERE exported=0').all()) {
      const event = JSON.parse(row.event as string) as Event;
      const name = event.id + '.json',
        file = path.join(this.eventsDir, name);
      if (!fs.existsSync(file)) {
        atomicWrite(file, JSON.stringify(event, null, 2) + '\n');
        const stat = fs.lstatSync(file);
        this.fileCache.set(name, {
          stamp: stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size,
          event,
        });
      }
      this.db.prepare('UPDATE events SET exported=1 WHERE id=?').run(event.id);
      wrote = true;
    }
    if (wrote) this.directoryStamp = String(fs.statSync(this.eventsDir).mtimeMs);
  }
  sync(force = true) {
    // A committed outbox must be recovered before Git reconciliation. Otherwise a
    // failed export could be mistaken for a deliberate branch-event removal.
    this.exportEvents();
    const directoryStamp = String(fs.statSync(this.eventsDir).mtimeMs);
    if (!force && directoryStamp === this.directoryStamp) return false;
    const existing = new Map(this.events().map((e) => [e.id, e]));
    const known = new Map<string, Event>();
    let dirty = false;
    for (const name of fs.readdirSync(this.eventsDir)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) continue;
      const file = path.join(this.eventsDir, name),
        stat = fs.lstatSync(file);
      assert(
        stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024,
        'INVALID_EVENT',
        'Invalid event file',
      );
      const stamp = stat.mtimeMs + ':' + stat.ctimeMs + ':' + stat.size,
        cached = this.fileCache.get(name);
      const event =
        cached?.stamp === stamp
          ? cached.event
          : (JSON.parse(fs.readFileSync(file, 'utf8')) as Event);
      const { hash: sum, ...body } = event;
      assert(
        event.id + '.json' === name &&
          event.schema === 1 &&
          event.projectId === this.config.id &&
          Array.isArray(event.parents) &&
          event.parents.every((p) => typeof p === 'string') &&
          hash(body) === sum,
        'INVALID_EVENT',
        'Invalid event integrity or project',
      );
      commandSchema.parse(event.command);
      if (existing.has(event.id))
        assert(
          existing.get(event.id)?.hash === event.hash,
          'EVENT_CHANGED',
          'An immutable event was changed',
        );
      else dirty = true;
      known.set(event.id, event);
      this.fileCache.set(name, { stamp, event });
    }
    if (known.size !== existing.size) dirty = true;
    this.directoryStamp = directoryStamp;
    if (!dirty) return false;
    // Replay in deterministic causal order. Concurrent updates to one version become explicit conflicts.
    const pending = new Map(known),
      ordered: Event[] = [],
      seen = new Set<string>();
    while (pending.size) {
      const ready = [...pending.values()]
        .filter((e) => e.parents.every((p) => seen.has(p)))
        .sort((a, b) => a.id.localeCompare(b.id));
      assert(
        ready.length,
        'MISSING_EVENTS',
        'Missing parent events or a cycle. Restore the files before continuing.',
      );
      for (const e of ready) {
        ordered.push(e);
        seen.add(e.id);
        pending.delete(e.id);
      }
    }
    this.transaction(() => {
      this.db.exec(
        'DELETE FROM agents;DELETE FROM entities;DELETE FROM search;DELETE FROM events;DELETE FROM conflicts;',
      );
      const failed = new Set<string>(),
        commands = new Map<string, string>();
      for (const event of ordered) {
        try {
          assert(
            !event.parents.some((id) => failed.has(id)),
            'CAUSAL_CONFLICT',
            'Event depends on a conflicting change',
          );
          const serialized = JSON.stringify(event.command),
            previous = commands.get(event.command.commandId);
          assert(
            previous === undefined || previous === serialized,
            'IDEMPOTENCY_MISMATCH',
            'commandId repeated with different content',
          );
          if (previous === undefined) {
            this.apply(event);
            commands.set(event.command.commandId, serialized);
          }
        } catch (e) {
          failed.add(event.id);
          this.db
            .prepare('INSERT INTO conflicts VALUES(?,?)')
            .run(event.id, e instanceof Error ? e.message : String(e));
        }
        this.db
          .prepare('INSERT INTO events(id,command_id,event,exported) VALUES(?,?,?,1)')
          .run(event.id, event.command.commandId, JSON.stringify(event));
      }
      // A Git import invalidates leases, as their file/commit basis may have changed.
      this.db.exec('DELETE FROM agents;');
      const frontier = new Set(ordered.map((e) => e.id));
      for (const e of ordered) for (const p of e.parents) frontier.delete(p);
      this.db
        .prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
        .run('frontier', JSON.stringify([...frontier].sort()));
    });
    this.changed();
    return true;
  }
  resolve(eventIds: string[]) {
    // Acknowledgement never silently applies the losing patch. Re-plan it as a new versioned command.
    const file = path.join(this.root, '.nexo', 'resolutions.json');
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    const valid = new Set(
      this.db
        .prepare('SELECT event_id FROM conflicts')
        .all()
        .map((r) => r.event_id),
    );
    assert(
      eventIds.every((id) => valid.has(id)),
      'INVALID_RESOLUTION',
      'Event is not in conflict',
    );
    atomicWrite(
      file,
      JSON.stringify([...new Set([...previous, ...eventIds])].sort(), null, 2) + '\n',
    );
    this.readResolutions();
  }
  readResolutions() {
    const file = path.join(this.root, '.nexo', 'resolutions.json');
    if (fs.existsSync(file)) {
      const ids = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert(
        Array.isArray(ids) &&
          ids.every((id) => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id)),
        'INVALID_RESOLUTION',
        'Invalid resolutions',
      );
      const previous = this.db
        .prepare('SELECT event_id FROM resolutions ORDER BY event_id')
        .all()
        .map((r) => r.event_id);
      const next = [...new Set(ids)].sort();
      if (JSON.stringify(previous) === JSON.stringify(next)) return;
      this.transaction(() => {
        this.db.exec('DELETE FROM resolutions');
        for (const id of ids)
          this.db.prepare('INSERT OR IGNORE INTO resolutions VALUES(?)').run(id);
      });
      this.changed();
    }
  }
  snapshot() {
    return this.snapshots.flush();
  }
  private stageSnapshot() {
    this.exportEvents();
    const temp = path.join(this.dir, 'snapshot-v2-' + crypto.randomUUID() + '.sqlite');
    const target = new DatabaseSync(temp);
    let reading = false;
    try {
      // Hold one consistent read view across all copied tables, even if a legacy
      // process that predates the ownership mutex is still attached to SQLite.
      this.db.exec('BEGIN');
      reading = true;
      target.exec('PRAGMA synchronous=FULL;');
      target.exec(schema);
      target.exec('BEGIN');
      target.prepare('INSERT INTO meta VALUES(?,?)').run('schema', '1');
      for (const e of this.all()) {
        target
          .prepare('INSERT INTO entities VALUES(?,?,?,?,?)')
          .run(e.kind, e.id, e.version, JSON.stringify(e.data), e.updatedAt);
        target
          .prepare('INSERT INTO search(id,title,description) VALUES(?,?,?)')
          .run(e.id, e.data.title, e.data.description);
      }
      for (const e of this.events())
        target
          .prepare('INSERT INTO events(id,command_id,event,exported) VALUES(?,?,?,1)')
          .run(e.id, e.command.commandId, JSON.stringify(e));
      for (const c of this.db.prepare('SELECT * FROM conflicts').all())
        target.prepare('INSERT INTO conflicts VALUES(?,?)').run(c.event_id, c.reason);
      for (const c of this.db.prepare('SELECT * FROM resolutions').all())
        target.prepare('INSERT INTO resolutions VALUES(?)').run(c.event_id);
      target.exec('COMMIT;PRAGMA optimize;');
      assert(
        target.prepare('PRAGMA quick_check').get()?.quick_check === 'ok',
        'SNAPSHOT_INVALID',
        'Snapshot integrity check failed',
      );
    } catch (e) {
      target.close();
      try {
        fs.rmSync(temp, { force: true });
      } catch {}
      throw e;
    } finally {
      if (reading) this.db.exec('ROLLBACK');
    }
    target.close();
    // Closed, standalone SQLite file. No WAL, leases, credentials or machine paths are copied.
    try {
      const fd = fs.openSync(temp, 'r+');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return temp;
    } catch (e) {
      try {
        fs.rmSync(temp, { force: true });
      } catch {}
      throw e;
    }
  }
  agents(): Agent[] {
    const now = Date.now();
    return this.db
      .prepare('SELECT data,token,fence,expires_at FROM agents ORDER BY agent_id')
      .all()
      .map((r) => ({
        ...JSON.parse(r.data as string),
        token: r.token,
        fence: r.fence,
        expiresAt: r.expires_at,
        state: Number(r.expires_at) > now ? 'working' : 'lost_contact',
      }));
  }
  claim(raw: unknown) {
    const claim = claimSchema.parse(raw);
    this.sync(false);
    assert(!this.conflicts().length, 'MERGE_CONFLICT', 'Resolve conflicts before starting work');
    const agent = this.transaction(() => {
      const task = this.get(claim.taskId);
      assert(task?.kind === 'task', 'INVALID_TASK', 'Card not found');
      const delivery = this.get(task.data.deliveryId)!;
      assert(delivery.data.status !== 'accepted', 'ACCEPTED_DELIVERY', 'Accepted delivery');
      assert(!task.data.blocker, 'BLOCKED', 'Card blocked');
      assert(
        task.data.dependencies.every((id: string) => {
          const d = this.get(id)!;
          return (
            this.get(d.data.deliveryId)?.data.workflow.find((s: any) => s.id === d.data.stageId)
              ?.phase === 'done'
          );
        }),
        'DEPENDENCIES_PENDING',
        'Pending dependencies',
      );
      assert(
        delivery.data.workflow.find((s: any) => s.id === task.data.stageId)?.phase !== 'done',
        'ALREADY_DONE',
        'Card completed',
      );
      assert(
        !this.agents().some((a) => a.agentId === claim.agentId && a.state === 'working'),
        'AGENT_ACTIVE',
        'Agent already registered; use heartbeat',
      );
      const active = this.agents().filter((a) => a.state === 'working');
      assert(active.length < this.config.maxAgents, 'CAPACITY', 'Project capacity reached');
      if (claim.teamId) {
        const team = this.get(claim.teamId);
        assert(
          team?.kind === 'team' && team.data.deliveryId === task.data.deliveryId,
          'INVALID_TEAM',
          'Invalid team',
        );
        assert(
          !task.data.teamId || task.data.teamId === claim.teamId,
          'INVALID_TEAM',
          'Team is not responsible for this card',
        );
        assert(
          active.filter((a) => a.teamId === claim.teamId).length < team.data.maxAgents,
          'CAPACITY',
          'Team capacity reached',
        );
        const teams = new Set(
          active
            .filter((a) => this.get(a.taskId)?.data.deliveryId === task.data.deliveryId)
            .map((a) => a.teamId)
            .filter(Boolean),
        );
        teams.add(claim.teamId);
        assert(
          teams.size <= this.config.maxTeamsPerDelivery,
          'CAPACITY',
          'Parallel team limit reached',
        );
      }
      assert(
        claim.role !== 'executor' ||
          !active.some((a) => a.taskId === claim.taskId && a.role === 'executor'),
        'TASK_CLAIMED',
        'Another executor already owns this card',
      );
      const scopes = claim.scopes.map(normalizeScope);
      claim.scopes = scopes;
      if (claim.role !== 'reviewer')
        for (const a of active.filter((a) => a.role !== 'reviewer'))
          assert(
            !scopes.some((s) => a.scopes.some((t) => overlap(s, t))),
            'SCOPE_CONFLICT',
            'Write scope owned by ' + a.name,
          );
      const fence =
        Number(
          this.db.prepare('SELECT value FROM fences WHERE task_id=?').get(claim.taskId)?.value ?? 0,
        ) + 1;
      this.db
        .prepare(
          'INSERT INTO fences VALUES(?,?) ON CONFLICT(task_id) DO UPDATE SET value=excluded.value',
        )
        .run(claim.taskId, fence);
      const agent: Agent = {
        ...claim,
        token: crypto.randomBytes(32).toString('base64url'),
        fence,
        startedAt: Date.now(),
        expiresAt: Date.now() + claim.ttlSeconds * 1000,
        state: 'working',
      };
      this.db
        .prepare('INSERT OR REPLACE INTO agents VALUES(?,?,?,?,?,?)')
        .run(
          agent.agentId,
          agent.taskId,
          agent.token,
          fence,
          JSON.stringify(agent),
          agent.expiresAt,
        );
      return agent;
    });
    try {
      const task = this.get(claim.taskId)!,
        delivery = this.get(task.data.deliveryId)!;
      if (delivery.data.workflow.find((s: any) => s.id === task.data.stageId)?.phase === 'queued') {
        const active =
          (claim.role === 'reviewer'
            ? delivery.data.workflow.find((s: any) => s.phase === 'review')
            : undefined) ?? delivery.data.workflow.find((s: any) => s.phase === 'active');
        if (active)
          this.execute({
            commandId: crypto.randomUUID(),
            actor: claim.agentId,
            op: 'update',
            kind: 'task',
            id: task.id,
            expectedVersion: task.version,
            data: { stageId: active.id },
            leaseToken: agent.token,
          });
      }
      if (delivery.data.status === 'planned')
        this.execute({
          commandId: crypto.randomUUID(),
          actor: claim.agentId,
          op: 'update',
          kind: 'delivery',
          id: delivery.id,
          expectedVersion: delivery.version,
          data: { status: 'active' },
        });
    } catch (e) {
      this.release(agent.token);
      throw e;
    }
    this.changed(false);
    return agent;
  }
  heartbeat(token: string, activity?: string) {
    return this.transaction(() => {
      const agent = this.agents().find((a) => a.token === token);
      assert(agent?.state === 'working', 'STALE_LEASE', 'Lease expired or replaced');
      if (activity) agent.activity = activity.slice(0, 500);
      agent.expiresAt = Date.now() + agent.ttlSeconds * 1000;
      this.db
        .prepare('UPDATE agents SET data=?,expires_at=? WHERE token=?')
        .run(JSON.stringify(agent), agent.expiresAt, token);
      this.changed(false);
      return agent;
    });
  }
  release(token: string) {
    this.db.prepare('DELETE FROM agents WHERE token=?').run(token);
    this.changed(false);
    return { released: true };
  }
  releaseSession(sessionId: string) {
    for (const a of this.agents()) if (a.sessionId === sessionId) this.release(a.token);
  }
  state() {
    this.readResolutions();
    return {
      schemaVersion: 1,
      project: this.config,
      revision: this.revision,
      entities: this.all(),
      agents: this.agents().map(({ token, ...a }) => a),
      conflicts: this.conflicts(),
      eventCount: Number(this.db.prepare('SELECT COUNT(*) n FROM events').get()?.n ?? 0),
    };
  }
  search(query: string) {
    assert(query.length <= 200, 'INVALID_SEARCH', 'Search query is too long', 400);
    const words = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    if (!words.length) return [];
    const q = words.map((w) => '"' + w + '"*').join(' AND ');
    return this.db
      .prepare('SELECT id FROM search WHERE search MATCH ? ORDER BY rank LIMIT 50')
      .all(q)
      .map((r) => this.get(r.id as string));
  }
}
function normalizeScope(scope: string) {
  const s = scope.replaceAll('\\', '/').replace(/\/$/, '');
  assert(
    s === '.' ||
      (!s.startsWith('/') && !s.includes(':') && !s.split('/').includes('..') && !s.includes('*')),
    'INVALID_SCOPE',
    'Use explicit relative paths without .. or globs',
    400,
  );
  return s;
}
function overlap(a: string, b: string) {
  return a === '.' || b === '.' || a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
function assertAcyclic(start: string, next: (id: string) => string[], message: string) {
  const states = new Map<string, number>(),
    stack: [string, boolean][] = [[start, false]];
  while (stack.length) {
    const [node, leave] = stack.pop()!;
    if (leave) {
      states.set(node, 2);
      continue;
    }
    assert(states.get(node) !== 1, 'CYCLE', message);
    if (states.get(node) === 2) continue;
    states.set(node, 1);
    stack.push([node, true]);
    for (const child of next(node)) stack.push([child, false]);
  }
}
