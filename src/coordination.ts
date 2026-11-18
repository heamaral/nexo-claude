import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { Store } from './store.js';
import { Agent, Entity, NexoError, assert, commandSchema, id } from './model.js';
import { atomicWrite, gitDirectory } from './project.js';

export const coordinationTables = `
CREATE TABLE IF NOT EXISTS executions(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS executions_task ON executions(task_id);
CREATE TABLE IF NOT EXISTS import_jobs(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_samples(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspaces(id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS hook_seen(id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS check_runs(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS coordination_metrics(key TEXT PRIMARY KEY, count INTEGER NOT NULL, bytes INTEGER NOT NULL, latency_ms REAL NOT NULL);
`;
const digest = (v: string | Buffer) => crypto.createHash('sha256').update(v).digest('hex');
const executeFile = promisify(execFile);
async function gitRead(cwd: string, args: string[]) {
  const { stdout } = await executeFile('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout.trim();
}
const executionSummarySchema = z
  .object({
    schema: z.literal(1),
    projectId: z.string().uuid(),
    id,
    deliveryId: id,
    taskId: id,
    parentExecutionId: id.optional(),
    model: z.string().max(100).optional(),
    effort: z.string().max(20).optional(),
    startedAt: z.number().int().nonnegative(),
    finishedAt: z.number().int().nonnegative().optional(),
    status: z.enum(['released', 'completed', 'lost_contact']),
  })
  .strict();
const configSchema = z
  .object({
    schema: z.literal(1),
    telemetry: z.boolean().default(false),
    resources: z
      .array(
        z
          .object({
            id,
            capacity: z.number().int().min(1).max(128),
            owner: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    repositories: z
      .array(
        z
          .object({
            id,
            path: z.string().min(1).max(1000),
            integratedRef: z
              .string()
              .regex(/^[a-zA-Z0-9_./-]+$/)
              .default('HEAD'),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    checks: z
      .array(
        z
          .object({
            id,
            repoId: id,
            artifact: z.string().min(1).max(1000),
            executable: z.string().min(1).max(1000).optional(),
            args: z.array(z.string().max(2000)).max(100).default([]),
            timeoutSeconds: z.number().int().min(1).max(600).default(120),
            resourceId: id.optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    adapters: z
      .array(
        z
          .object({
            id,
            path: z.string().min(1).max(1000),
            stageMap: z.record(z.string(), z.string()).default({}),
          })
          .strict(),
      )
      .max(30)
      .default([]),
    externalWrites: z
      .array(z.object({ resourceId: id, path: z.string().min(1).max(1000) }).strict())
      .max(30)
      .default([]),
  })
  .strict();
export const querySchema = z
  .object({
    view: z
      .enum([
        'summary',
        'task',
        'delivery',
        'assignment',
        'search',
        'changes',
        'diagnostics',
        'executions',
        'export',
      ])
      .default('summary'),
    id: z.string().max(200).optional(),
    sessionId: z.string().max(200).optional(),
    query: z.string().max(200).optional(),
    kind: z.enum(['delivery', 'task', 'team']).optional(),
    stageId: id.optional(),
    deliveryId: id.optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().min(1).max(100).default(30),
    fields: z
      .array(
        z.enum([
          'description',
          'criteria',
          'evidence',
          'checkpoint',
          'result',
          'dependencies',
          'source',
        ]),
      )
      .max(7)
      .default([]),
    sinceRevision: z.number().int().nonnegative().optional(),
    instance: z.string().max(100).optional(),
    maxBytes: z.number().int().min(2048).max(65536).default(24000),
    section: z
      .enum([
        'ancestors',
        'children',
        'dependencies',
        'criteria',
        'evidence',
        'references',
        'decisions',
        'remaining',
      ])
      .optional(),
  })
  .strict();
export type Query = z.infer<typeof querySchema>;
export const batchSchema = z
  .object({
    jobId: id,
    preview: z.boolean().default(true),
    commands: z.array(commandSchema).min(1).max(100),
  })
  .strict();
export const workspaceSchema = z
  .object({
    id,
    path: z.string().min(1).max(1000),
    mode: z.enum(['shared', 'isolated']),
    coordination: z.enum(['shared', 'independent']).default('shared'),
    expectedProjectId: z.string().uuid(),
  })
  .strict();
export const usageSchema = z
  .object({
    id,
    executionId: id,
    input: z.number().int().nonnegative().max(1e10).default(0),
    cacheRead: z.number().int().nonnegative().max(1e10).default(0),
    cacheWrite: z.number().int().nonnegative().max(1e10).default(0),
    output: z.number().int().nonnegative().max(1e10).default(0),
    source: z.enum(['provider', 'estimate']),
    category: z.enum(['work', 'coordination', 'recovery']).default('work'),
    latencyMs: z.number().nonnegative().max(86400000).optional(),
    responseBytes: z.number().int().nonnegative().max(1e9).optional(),
  })
  .strict();
export const runCheckSchema = z
  .object({ checkId: id, taskId: id, token: z.string().min(1).max(200) })
  .strict();

/** All operational records remain in ignored local SQLite. Only closed, sanitized
 * execution summaries are exported explicitly. No prompts, tokens or tool outputs. */
export class Coordination {
  private verification = new Map<string, any>();
  private runningChecks = new Map<string, number>();
  private prepared = new Map<
    string,
    { hash: string; at: number; policy: string; evidence: Set<string> }
  >();
  constructor(public store: Store) {}
  config() {
    const file = path.join(this.store.root, '.nexo', 'coordination.json');
    if (!fs.existsSync(file)) return configSchema.parse({ schema: 1 });
    assert(
      !fs.lstatSync(file).isSymbolicLink(),
      'SYMLINK_DENIED',
      'Coordination config cannot be a symlink',
    );
    assert(fs.statSync(file).size <= 262144, 'CONFIG_LIMIT', 'Coordination config exceeds 256 KiB');
    const cfg = configSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
    for (const key of ['resources', 'repositories', 'checks', 'adapters'] as const)
      assert(
        new Set(cfg[key].map((v) => v.id)).size === cfg[key].length,
        'DUPLICATE_ID',
        `Duplicate ${key} IDs`,
      );
    return cfg;
  }
  publicAgent(a: Agent) {
    const { token: _, sessionId: __, ...safe } = a;
    return safe;
  }
  phase(t: Entity) {
    return this.store
      .get(t.data.deliveryId)
      ?.data.workflow.find((s: any) => s.id === t.data.stageId)?.phase;
  }
  compact(e: Entity, fields: string[] = []) {
    const d = e.data;
    const data: any = { title: d.title };
    for (const k of [
      'deliveryId',
      'parentId',
      'teamId',
      'stageId',
      'status',
      'blocker',
      'waiting',
      'resources',
    ])
      if (d[k] !== undefined) data[k] = d[k];
    for (const k of fields) if (d[k] !== undefined) data[k] = d[k];
    if (e.kind === 'task') {
      data.phase = this.phase(e);
      data.dependencyCount = d.dependencies.length;
    }
    if (e.kind === 'delivery') data.workflow = d.workflow;
    if (e.kind === 'team') {
      data.engine = d.engine;
      data.maxAgents = d.maxAgents;
    }
    return { id: e.id, kind: e.kind, version: e.version, updatedAt: e.updatedAt, data };
  }
  query(raw: unknown) {
    const q = querySchema.parse(raw),
      value = this.queryValue(q);
    if (q.view !== 'export' && Buffer.byteLength(JSON.stringify(value)) > q.maxBytes)
      return {
        apiVersion: 2,
        revision: this.store.revision,
        durableRevision: this.store.durableRevision,
        budgetExceeded: true,
        resetRequired: q.view === 'changes',
        nextAction:
          'Narrow the delivery, task, fields or page. Explicit export is available for a full record.',
      };
    return value;
  }
  private queryValue(raw: unknown) {
    const q = querySchema.parse(raw),
      s = this.store;
    const base = {
      schemaVersion: 1,
      apiVersion: 2,
      revision: s.revision,
      durableRevision: s.durableRevision,
    };
    if (q.view === 'changes') {
      const since = q.sinceRevision ?? 0;
      const reset = since < s.changeFloor || since > s.durableRevision;
      return {
        ...base,
        resetRequired: reset,
        entities: reset
          ? []
          : [...s.changeLog.entries()]
              .filter(([, r]) => r > since)
              .map(([key]) => s.get(key))
              .filter(Boolean),
        agents: s.agents().map((a) => this.publicAgent(a)),
      };
    }
    if (q.view === 'export')
      return { ...s.state(), apiVersion: 2, durableRevision: s.durableRevision };
    if (q.view === 'diagnostics') return { ...base, ...this.diagnostics() };
    if (q.view === 'assignment') {
      assert(q.id || q.sessionId, 'IDENTITY_REQUIRED', 'Supply agent ID or session ID', 400);
      const agents = s
        .agents()
        .filter(
          (a) => (!q.id || a.agentId === q.id) && (!q.sessionId || a.sessionId === q.sessionId),
        );
      return {
        ...base,
        agents: agents.map((a) => this.publicAgent(a)),
        tasks: agents
          .map((a) => s.get(a.taskId))
          .filter(Boolean)
          .map((e) => this.compact(e!, ['criteria', 'checkpoint'])),
        recovery:
          'Renew a working lease. An expired lease requires a new claim and fence. Tokens are returned only by claim.',
      };
    }
    if (q.view === 'executions') return this.page(this.executions(q.id), q, base);
    if (q.view === 'task') {
      const e = s.get(q.id ?? '');
      assert(e?.kind === 'task', 'NOT_FOUND', 'Task not found', 404);
      const ancestors: Entity[] = [];
      let p = e.data.parentId;
      while (p) {
        const parent = s.get(p);
        if (!parent) break;
        ancestors.push(parent);
        p = parent.data.parentId;
      }
      if (q.section) {
        const values: any[] =
          q.section === 'ancestors'
            ? ancestors
            : q.section === 'children'
              ? s.all('task').filter((v) => v.data.parentId === e.id)
              : q.section === 'dependencies'
                ? e.data.dependencies.map((key: string) => s.get(key)).filter(Boolean)
                : ['references', 'decisions', 'remaining'].includes(q.section)
                  ? (e.data.checkpoint?.[q.section] ?? [])
                  : (e.data[q.section] ?? []);
        return this.page(
          values.map((v, index) => ({
            id: String(index).padStart(8, '0'),
            value: v?.kind ? this.compact(v, q.fields) : v,
          })),
          q,
          { ...base, taskId: e.id, version: e.version, section: q.section },
        );
      }
      const result: any = {
        ...base,
        task: this.compact(e, ['criteria', 'dependencies', 'checkpoint', 'evidence', ...q.fields]),
        ancestors: ancestors.map((v) => this.compact(v)),
        dependencies: e.data.dependencies
          .map((key: string) => s.get(key))
          .filter(Boolean)
          .map((v: Entity) => this.compact(v)),
        children: s
          .all('task')
          .filter((v) => v.data.parentId === e.id)
          .map((v) => this.compact(v)),
        agents: s
          .agents()
          .filter((a) => a.taskId === e.id)
          .map((a) => this.publicAgent(a)),
        checks: this.checks(e),
        nextAction: this.readiness(e),
      };
      // Never silently truncate acceptance criteria or prerequisite relationships.
      if (Buffer.byteLength(JSON.stringify(result)) > q.maxBytes)
        return {
          ...base,
          task: this.compact(e),
          oversized: true,
          nextAction:
            'Request task sections with section=criteria|children|dependencies|evidence|ancestors|references and nextCursor; use export for a full record.',
        };
      return result;
    }
    if (q.view === 'summary') {
      const tasks = s.all('task'),
        counts: Record<string, number> = {};
      for (const t of tasks) {
        const phase = this.phase(t) ?? 'unknown';
        counts[phase] = (counts[phase] ?? 0) + 1;
      }
      return this.page(
        s.all('delivery').map((e) => this.compact(e)),
        q,
        {
          ...base,
          project: s.config,
          counts,
          agents: s.agents().length,
          conflicts: s.conflicts().length,
          snapshot: s.snapshots.state(),
          guidance:
            'Use task for worker context, delivery for planning, assignment to recover ownership. Full export is explicit.',
        },
      );
    }
    let list = s.all(q.kind);
    if (q.view === 'search') {
      const needle = (q.query ?? '').toLocaleLowerCase();
      const matched = new Set(s.search(q.query ?? '').map((e) => e!.id));
      list = list.filter(
        (e) =>
          matched.has(e.id) ||
          [
            e.id,
            ...(e.data.aliases ?? []),
            ...(e.data.evidence?.map((v: any) => [v.artifact, v.url, v.checkId].join(' ')) ?? []),
            ...(e.data.checkpoint?.references ?? []),
          ].some((v: string) => v?.toLocaleLowerCase().includes(needle)),
      );
    }
    const deliveryId = q.deliveryId ?? (q.view === 'delivery' ? q.id : undefined);
    if (deliveryId)
      list = list.filter((e) => e.id === deliveryId || e.data.deliveryId === deliveryId);
    if (q.stageId) list = list.filter((e) => e.data.stageId === q.stageId);
    return this.page(
      list.map((e) => this.compact(e, q.fields)),
      q,
      base,
    );
  }
  page(items: any[], q: Query, base: any, preserveOrder = false) {
    const sorted = preserveOrder
      ? items
      : items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const candidates = preserveOrder
      ? sorted.slice(q.cursor ? sorted.findIndex((v) => v.id === q.cursor) + 1 : 0)
      : sorted.filter((v) => !q.cursor || v.id > q.cursor);
    const selected: any[] = [];
    let oversizedId: string | undefined;
    for (const v of candidates.slice(0, q.limit)) {
      if (
        Buffer.byteLength(JSON.stringify({ ...base, items: [...selected, v] })) >
        q.maxBytes - 512
      ) {
        if (!selected.length) oversizedId = v.id;
        break;
      }
      selected.push(v);
    }
    return {
      ...base,
      items: selected,
      total: sorted.length,
      nextCursor:
        selected.length < candidates.length ? (selected.at(-1)?.id ?? q.cursor ?? null) : null,
      oversizedId,
      complete: selected.length === candidates.length,
      guidance: oversizedId
        ? 'This record exceeds the budget. Request fewer fields or explicit export.'
        : undefined,
    };
  }
  readiness(t: Entity) {
    const dependencies = t.data.dependencies.filter((key: string) => {
      const dep = this.store.get(key);
      return !dep || this.phase(dep) !== 'done';
    });
    const owners = this.store.agents().filter((a) => a.state === 'working' && a.taskId === t.id);
    const resources = this.resourceStatus(t.data.resources ?? []);
    const childrenPending = this.store
      .all('task')
      .filter((v) => v.data.parentId === t.id && this.phase(v) !== 'done')
      .map((v) => v.id);
    return {
      ready:
        this.phase(t) !== 'done' &&
        !t.data.blocker &&
        !t.data.waiting &&
        !dependencies.length &&
        !owners.length &&
        !childrenPending.length &&
        resources.every((r) => r.available > 0 && !r.owner),
      dependencies,
      childrenPending,
      blocker: t.data.blocker ?? null,
      waiting: t.data.waiting ?? null,
      owners: owners.map((a) => a.agentId),
      resources,
      ageSeconds: Math.max(
        0,
        Math.floor((Date.now() - Date.parse(t.data.waiting?.since ?? t.updatedAt)) / 1000),
      ),
    };
  }
  schedule(deliveryId?: string) {
    const tasks = this.store
      .all('task')
      .filter((t) => !deliveryId || t.data.deliveryId === deliveryId);
    const reverse = new Map<string, string[]>();
    for (const t of tasks)
      for (const dep of t.data.dependencies) reverse.set(dep, [...(reverse.get(dep) ?? []), t.id]);
    const reach = (key: string) => {
      const seen = new Set<string>(),
        todo = [...(reverse.get(key) ?? [])];
      while (todo.length) {
        const next = todo.pop()!;
        if (seen.has(next)) continue;
        seen.add(next);
        todo.push(...(reverse.get(next) ?? []));
      }
      return seen.size;
    };
    const ranked = tasks
      .map((t) => ({
        id: t.id,
        title: t.data.title,
        version: t.version,
        ...this.readiness(t),
        downstream: reach(t.id),
      }))
      .sort(
        (a, b) =>
          Number(b.ready) - Number(a.ready) ||
          b.downstream - a.downstream ||
          a.id.localeCompare(b.id),
      );
    return {
      advisory: true,
      dispatch:
        'Claim explicitly after selecting a ready task and registered workspace. No agents are launched by this API.',
      capacity: {
        project: this.store.config.maxAgents,
        active: this.store.agents().filter((a) => a.state === 'working').length,
        maxTeamsPerDelivery: this.store.config.maxTeamsPerDelivery,
        nativeCapacity:
          'Configured in Claude separately; Nexo limits are additional, not a replacement.',
      },
      tasks: ranked,
    };
  }
  resourceStatus(ids: string[]) {
    const cfg = this.config(),
      active = this.store.agents().filter((a) => a.state === 'working');
    return ids.map((key) => {
      const resource = cfg.resources.find((r) => r.id === key);
      const used = active.filter((a) => a.resources?.includes(key)).length;
      return {
        id: key,
        capacity: resource?.capacity ?? 0,
        used,
        available: Math.max(0, (resource?.capacity ?? 0) - used),
        owner: resource?.owner ?? null,
      };
    });
  }
  validateClaim(a: Agent | any) {
    const task = this.store.get(a.taskId)!;
    assert(
      !task.data.waiting,
      'WAITING',
      'Clear the waiting reason with a versioned command before claiming',
    );
    a.resources = [...new Set([...(task.data.resources ?? []), ...(a.resources ?? [])])];
    for (const r of this.resourceStatus(a.resources))
      if (r.available < 1 || r.owner)
        throw new NexoError('RESOURCE_BUSY', `Resource ${r.id} is unavailable`, 409, r);
    if (a.workspaceId) {
      const w = this.workspace(a.workspaceId);
      assert(
        w && fs.existsSync(w.path),
        'WORKSPACE_MISSING',
        'Register a valid workspace before claiming',
      );
      assert(
        w.coordination !== 'independent',
        'INDEPENDENT_COORDINATOR',
        'Use the independent workspace coordinator for this claim',
      );
    }
  }
  begin(a: Agent) {
    const prior = this.store.db.prepare('SELECT id FROM executions WHERE id=?').get(a.executionId!);
    assert(!prior, 'EXECUTION_EXISTS', 'Use a new executionId for a new lease');
    assert(
      !fs.existsSync(path.join(this.store.root, '.nexo', 'executions', a.executionId! + '.json')),
      'EXECUTION_EXISTS',
      'This execution ID already belongs to exported project history',
    );
    if (a.parentExecutionId)
      assert(
        this.store.db.prepare('SELECT id FROM executions WHERE id=?').get(a.parentExecutionId),
        'PARENT_EXECUTION_MISSING',
        'Parent execution does not exist',
      );
    const data = {
      id: a.executionId,
      taskId: a.taskId,
      deliveryId: this.store.get(a.taskId)!.data.deliveryId,
      parentExecutionId: a.parentExecutionId,
      agentId: a.agentId,
      model: a.model,
      effort: a.effort,
      fence: a.fence,
      workspaceId: a.workspaceId,
      startedAt: a.startedAt,
      status: 'working',
      resources: a.resources,
      lastActivity: a.activity,
    };
    this.store.db
      .prepare('INSERT INTO executions VALUES(?,?,?)')
      .run(data.id!, a.taskId, JSON.stringify(data));
  }
  finish(a: Agent, status = 'released') {
    if (!a.executionId) return;
    const row = this.store.db.prepare('SELECT data FROM executions WHERE id=?').get(a.executionId);
    if (!row) return;
    const data = {
      ...JSON.parse(String(row.data)),
      status: a.state === 'lost_contact' ? 'lost_contact' : status,
      finishedAt: Date.now(),
      result: this.store.get(a.taskId)?.data.result || undefined,
    };
    this.store.db
      .prepare('UPDATE executions SET data=? WHERE id=?')
      .run(JSON.stringify(data), a.executionId);
  }
  executions(taskId?: string) {
    const local = (
      taskId
        ? this.store.db.prepare('SELECT data FROM executions WHERE task_id=?').all(taskId)
        : this.store.db.prepare('SELECT data FROM executions').all()
    )
      .map((r) => JSON.parse(String(r.data)))
      .map((e) => {
        if (
          e.status === 'working' &&
          !this.store.agents().some((a) => a.executionId === e.id && a.state === 'working')
        )
          return { ...e, status: 'lost_contact' };
        return e;
      });
    const folder = path.join(this.store.root, '.nexo', 'executions');
    if (!fs.existsSync(folder)) return local;
    assert(
      !fs.lstatSync(folder).isSymbolicLink(),
      'SYMLINK_DENIED',
      'Execution history cannot be a symlink',
    );
    const records = new Map(local.map((e) => [e.id, e]));
    const names = fs
      .readdirSync(folder)
      .filter((name) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}\.json$/.test(name));
    assert(
      names.length <= 10000,
      'HISTORY_LIMIT',
      'Execution history exceeds 10,000 summary files',
    );
    for (const name of names) {
      const file = path.join(folder, name);
      assert(
        !fs.lstatSync(file).isSymbolicLink() && fs.statSync(file).size <= 16384,
        'HISTORY_LIMIT',
        'Invalid execution summary',
      );
      const e = executionSummarySchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
      assert(
        e.projectId === this.store.config.id && name === e.id + '.json',
        'PROJECT_MISMATCH',
        'Execution summary identity mismatch',
      );
      if ((!taskId || e.taskId === taskId) && !records.has(e.id))
        records.set(e.id, { ...e, historical: true });
    }
    return [...records.values()];
  }
  exportExecutions() {
    const folder = path.join(this.store.root, '.nexo', 'executions');
    assert(
      !fs.existsSync(folder) || !fs.lstatSync(folder).isSymbolicLink(),
      'SYMLINK_DENIED',
      'Execution folder cannot be a symlink',
    );
    fs.mkdirSync(folder, { recursive: true });
    let count = 0;
    for (const e of this.executions().filter((e) => e.status !== 'working')) {
      // No session IDs, tokens, scopes, activity text, machine paths or live heartbeats.
      const safe = {
        schema: 1,
        projectId: this.store.config.id,
        id: e.id,
        deliveryId: e.deliveryId,
        taskId: e.taskId,
        parentExecutionId: e.parentExecutionId,
        model: e.model,
        effort: e.effort,
        startedAt: e.startedAt,
        finishedAt: e.finishedAt,
        status: e.status,
      };
      const file = path.join(folder, e.id + '.json');
      if (!fs.existsSync(file)) {
        atomicWrite(file, JSON.stringify(safe, null, 2) + '\n');
        count++;
      }
    }
    return { exported: count, directory: '.nexo/executions', containsLiveState: false };
  }
  workspace(key: string): any {
    const row = this.store.db.prepare('SELECT data FROM workspaces WHERE id=?').get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  async registerWorkspace(raw: unknown) {
    const v = workspaceSchema.parse(raw);
    assert(
      v.expectedProjectId === this.store.config.id,
      'PROJECT_MISMATCH',
      'Choose the intended coordinator project identity',
    );
    const absolute = fs.realpathSync.native(path.resolve(this.store.root, v.path));
    const prior = this.workspace(v.id);
    if (prior && this.store.agents().some((a) => a.state === 'working' && a.workspaceId === v.id))
      assert(
        prior.path === absolute &&
          prior.mode === v.mode &&
          (prior.coordination ?? 'shared') === v.coordination,
        'WORKSPACE_ACTIVE',
        'Release active workspace claims before changing its path or coordination mode',
      );
    const common = async (cwd: string) =>
      fs.realpathSync.native(
        path.resolve(cwd, await gitRead(cwd, ['rev-parse', '--git-common-dir'])),
      );
    const [checkoutCommon, coordinatorCommon] = await Promise.all([
      common(absolute),
      common(this.store.root),
    ]);
    assert(
      checkoutCommon === coordinatorCommon,
      'REPOSITORY_MISMATCH',
      'Workspace is not a worktree of this repository',
    );
    const localConfig = path.join(absolute, '.nexo', 'project.json');
    if (absolute !== this.store.root && fs.existsSync(localConfig)) {
      const other = JSON.parse(fs.readFileSync(localConfig, 'utf8'));
      assert(
        v.coordination === 'independent' || other.id === this.store.config.id,
        'SPLIT_BOARD',
        'This worktree has a separate project identity. Choose independent coordination explicitly or use the canonical coordinator.',
      );
    }
    assert(
      v.mode !== 'shared' || absolute === this.store.root,
      'WORKSPACE_MODE',
      'Use mode=isolated for a separate Git worktree',
    );
    if (v.coordination === 'independent')
      assert(
        fs.existsSync(localConfig) &&
          JSON.parse(fs.readFileSync(localConfig, 'utf8')).id !== this.store.config.id,
        'INDEPENDENT_BOARD_REQUIRED',
        'Initialize an independent board with a distinct project identity first. Existing history is never overwritten automatically.',
      );
    const data = {
      ...v,
      path: absolute,
      canonicalRoot: this.store.root,
      branch: await gitRead(absolute, ['rev-parse', '--abbrev-ref', 'HEAD']),
      baseCommit: await gitRead(absolute, ['rev-parse', 'HEAD']),
      registeredAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        'INSERT INTO workspaces VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(v.id, JSON.stringify(data));
    if (absolute !== this.store.root && v.coordination === 'shared') {
      const gitDir = gitDirectory(absolute)!;
      atomicWrite(
        path.join(gitDir, 'nexo-coordinator.json'),
        JSON.stringify({
          schema: 1,
          root: this.store.root,
          projectId: this.store.config.id,
          workspaceId: v.id,
        }),
      );
    }
    if (absolute !== this.store.root && v.coordination === 'independent') {
      const link = path.join(gitDirectory(absolute)!, 'nexo-coordinator.json');
      if (fs.existsSync(link)) {
        const prior = JSON.parse(fs.readFileSync(link, 'utf8'));
        assert(
          prior.projectId === this.store.config.id,
          'COORDINATOR_MISMATCH',
          'Explicitly unlink the other coordinator first',
        );
        fs.unlinkSync(link);
      }
    }
    return data;
  }
  allowedExternal(a: Agent, absolute: string) {
    return this.config().externalWrites.some((r) => {
      const configured = path.resolve(this.store.root, r.path);
      const relative = path.relative(configured, absolute);
      return (
        a.resources?.includes(r.resourceId) &&
        (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)))
      );
    });
  }
  checks(t: Entity) {
    return (t.data.evidence ?? [])
      .filter((e: any) => e.checkId)
      .map((e: any) => {
        return {
          checkId: e.checkId,
          ...(this.verification.get(this.evidenceKey(e)) ?? {
            status: 'UNVERIFIED',
            reason: 'Refresh verification to inspect current source',
          }),
        };
      });
  }
  private evidenceKey(e: any) {
    return digest(
      JSON.stringify([e.repoId, e.checkId, e.commit, e.runId, e.fingerprint, e.scope, e.status]),
    );
  }
  async refreshChecks(taskId?: string) {
    const records = new Map<string, any>();
    for (const task of this.store.all('task').filter((t) => !taskId || t.id === taskId))
      for (const e of task.data.evidence ?? []) if (e.checkId) records.set(this.evidenceKey(e), e);
    const queue = [...records.values()];
    await Promise.all(
      Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length) {
          const e = queue.shift();
          try {
            const value = await this.verifyEvidence(e);
            this.verification.set(this.evidenceKey(e), {
              ...value,
              verifiedAt: new Date().toISOString(),
            });
          } catch (error) {
            this.verification.set(this.evidenceKey(e), {
              status: 'STALE',
              reason: (error as Error).message,
              verifiedAt: new Date().toISOString(),
            });
          }
        }
      }),
    );
  }
  async verifyEvidence(e: any) {
    const cfg = this.config(),
      check = cfg.checks.find((c) => c.id === e.checkId),
      repo = cfg.repositories.find((r) => r.id === e.repoId);
    assert(
      check && repo && check.repoId === repo.id,
      'CHECK_NOT_CONFIGURED',
      'Check and repository must be explicitly configured in .nexo/coordination.json',
    );
    assert(
      e.scope === 'integrated' && e.status === 'PASS' && e.commit && e.runId && e.fingerprint,
      'CHECK_NOT_PASS',
      'Integrated PASS evidence with commit, runId and fingerprint required',
    );
    const root = fs.realpathSync.native(path.resolve(this.store.root, repo.path));
    const git = (args: string[]) => gitRead(root, args);
    assert(
      /^[a-f0-9]{40,64}$/.test(e.commit),
      'FULL_COMMIT_REQUIRED',
      'Verified checks require a full commit ID',
    );
    assert(
      (await git(['rev-parse', '--verify', `${e.commit}^{commit}`])) === e.commit,
      'COMMIT_MISSING',
      'Commit does not exist in the configured repository',
    );
    assert(
      (await git(['rev-parse', '--verify', `${repo.integratedRef}^{commit}`])) === e.commit,
      'STALE_CHECK',
      'Evidence does not match the current integrated ref',
    );
    assert(
      !(await git(['status', '--porcelain', '--untracked-files=no'])),
      'DIRTY_INTEGRATION',
      'Integrated repository has tracked changes',
    );
    const artifact = path.resolve(root, check.artifact),
      relative = path.relative(root, artifact);
    assert(
      relative && !relative.startsWith('..') && !path.isAbsolute(relative),
      'ARTIFACT_SCOPE',
      'Configured artifact must be inside its repository',
    );
    const real = fs.realpathSync.native(artifact);
    assert(
      real === artifact && fs.statSync(real).size <= 1048576,
      'ARTIFACT_SCOPE',
      'Artifact must be a regular, bounded file without symlink traversal',
    );
    const bytes = fs.readFileSync(real);
    assert(digest(bytes) === e.fingerprint, 'FINGERPRINT_MISMATCH', 'Check artifact changed');
    assert(
      this.store.db
        .prepare('SELECT id FROM check_runs WHERE id=? AND fingerprint=?')
        .get(e.runId, e.fingerprint),
      'UNATTESTED_CHECK',
      'This coordinator did not run this check. Run the explicitly configured trusted adapter; a self-reported PASS is insufficient.',
    );
    const result = JSON.parse(bytes.toString('utf8'));
    assert(
      result.repoId === e.repoId &&
        result.commit === e.commit &&
        result.checkId === e.checkId &&
        result.runId === e.runId &&
        result.status === 'PASS' &&
        result.adapterFingerprint === digest(JSON.stringify(check)),
      'CHECK_MISMATCH',
      'Artifact identity/result does not match evidence',
    );
    return { status: 'PASS', commit: e.commit, runId: e.runId, fingerprint: e.fingerprint };
  }
  async runCheck(raw: unknown) {
    const input = runCheckSchema.parse(raw),
      cfg = this.config(),
      check = cfg.checks.find((v) => v.id === input.checkId);
    assert(check, 'CHECK_NOT_CONFIGURED', 'Configure the check before running it');
    const slots: [string, number][] = [[`check:${check.repoId}:${check.id}`, 1]];
    if (check.resourceId)
      slots.push([
        `resource:${check.resourceId}`,
        cfg.resources.find((v) => v.id === check.resourceId)?.capacity ?? 0,
      ]);
    for (const [key, capacity] of slots)
      assert(
        (this.runningChecks.get(key) ?? 0) < capacity,
        'CHECK_BUSY',
        'A check already occupies this configured check/resource slot',
      );
    for (const [key] of slots) this.runningChecks.set(key, (this.runningChecks.get(key) ?? 0) + 1);
    try {
      return await this.performCheck(input);
    } finally {
      for (const [key] of slots) {
        const n = (this.runningChecks.get(key) ?? 1) - 1;
        if (n) this.runningChecks.set(key, n);
        else this.runningChecks.delete(key);
      }
    }
  }
  private async performCheck(raw: unknown) {
    const input = runCheckSchema.parse(raw),
      cfg = this.config();
    const check = cfg.checks.find((c) => c.id === input.checkId),
      repo = cfg.repositories.find((r) => r.id === check?.repoId);
    assert(
      check?.executable && repo,
      'CHECK_NOT_CONFIGURED',
      'Configure a trusted executable and fixed arguments before running checks. Gate prose is never executed.',
    );
    const actor = this.store
      .agents()
      .find((a) => a.token === input.token && a.taskId === input.taskId && a.state === 'working');
    assert(actor, 'STALE_LEASE', 'Active task ownership is required');
    if (check.resourceId)
      assert(
        actor.resources?.includes(check.resourceId),
        'RESOURCE_REQUIRED',
        'Claim the check resource before running',
      );
    const root = fs.realpathSync.native(path.resolve(this.store.root, repo.path));
    const git = (args: string[]) => gitRead(root, args);
    const commit = await git(['rev-parse', '--verify', `${repo.integratedRef}^{commit}`]);
    assert(
      !(await git(['status', '--porcelain', '--untracked-files=no'])),
      'DIRTY_INTEGRATION',
      'Commit tracked changes before integrated checks',
    );
    const artifact = path.resolve(root, check.artifact),
      relative = path.relative(root, artifact).replaceAll('\\', '/');
    assert(
      relative.startsWith('.nexo/local/checks/') && !relative.split('/').includes('..'),
      'ARTIFACT_SCOPE',
      'Trusted check results must be written under .nexo/local/checks/',
    );
    const folder = path.dirname(artifact);
    for (let p = folder; p !== path.dirname(p); p = path.dirname(p))
      if (fs.existsSync(p))
        assert(
          !fs.lstatSync(p).isSymbolicLink(),
          'SYMLINK_DENIED',
          'Check artifact ancestors cannot be symlinks',
        );
    fs.mkdirSync(folder, { recursive: true });
    assert(
      fs.realpathSync.native(folder) === folder &&
        (!fs.existsSync(artifact) || !fs.lstatSync(artifact).isSymbolicLink()),
      'SYMLINK_DENIED',
      'Check artifacts cannot traverse symlinks',
    );
    const runId = crypto.randomUUID(),
      startedAt = Date.now();
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(check.executable!, check.args, {
        cwd: root,
        windowsHide: true,
        stdio: 'ignore',
        shell: false,
      });
      const timeout = setTimeout(() => {
        child.kill();
      }, check.timeoutSeconds * 1000);
      const renew = setInterval(() => {
        try {
          this.store.heartbeat(input.token, `Verifying ${check.id}`);
        } catch {
          child.kill();
        }
      }, 15000);
      child.once('error', (error) => {
        clearTimeout(timeout);
        clearInterval(renew);
        reject(error);
      });
      child.once('exit', (value) => {
        clearTimeout(timeout);
        clearInterval(renew);
        resolve(value);
      });
    });
    const stillOwned = this.store
      .agents()
      .some((a) => a.token === input.token && a.state === 'working');
    const same =
      commit === (await git(['rev-parse', '--verify', `${repo.integratedRef}^{commit}`])) &&
      !(await git(['status', '--porcelain', '--untracked-files=no']));
    const status = !stillOwned || !same ? 'STALE' : code === 0 ? 'PASS' : 'FAIL';
    const record = {
      schema: 1,
      repoId: repo.id,
      commit,
      checkId: check.id,
      runId,
      status,
      startedAt,
      finishedAt: Date.now(),
      exitCode: code,
      adapterFingerprint: digest(JSON.stringify(check)),
    };
    const bytes = JSON.stringify(record, null, 2) + '\n';
    atomicWrite(artifact, bytes);
    const fingerprint = digest(bytes);
    this.store.db.prepare('INSERT INTO check_runs VALUES(?,?)').run(runId, fingerprint);
    return {
      label: `Trusted check ${check.id}`,
      repoId: repo.id,
      commit,
      checkId: check.id,
      runId,
      status,
      fingerprint,
      scope: 'integrated',
      artifact: relative,
    };
  }
  async prepareCommands(raw: unknown[]) {
    const commands = raw
      .map((v) => commandSchema.parse(v))
      .filter(
        (c) => !this.store.db.prepare('SELECT id FROM events WHERE command_id=?').get(c.commandId),
      );
    if (!commands.length) return;
    const policy = digest(JSON.stringify(this.config()));
    const deliveries = new Map(this.store.all('delivery').map((e) => [e.id, e.data]));
    const tasks = new Map(this.store.all('task').map((e) => [e.id, e.data]));
    for (const c of commands) {
      if (c.kind === 'delivery') deliveries.set(c.id, { ...deliveries.get(c.id), ...c.data });
      if (c.kind === 'task') tasks.set(c.id, { ...tasks.get(c.id), ...c.data });
    }
    const evidence = new Map<string, any>();
    for (const c of commands) {
      const candidates =
        c.kind === 'task'
          ? [tasks.get(c.id)]
          : c.kind === 'delivery' && c.op === 'accept'
            ? [...tasks.values()].filter((t) => t.deliveryId === c.id)
            : [];
      for (const t of candidates) {
        const d = deliveries.get(t?.deliveryId);
        if (
          !d ||
          d.workflow?.find((s: any) => s.id === t.stageId)?.phase !== 'done' ||
          t.workType === 'research'
        )
          continue;
        for (const key of [
          ...new Set<string>((d.workflow ?? []).flatMap((s: any) => s.checks ?? [])),
        ]) {
          const e = t.evidence?.find((v: any) => v.checkId === key);
          assert(e, 'CHECK_REQUIRED', `Missing evidence for ${key}`);
          evidence.set(this.evidenceKey(e), e);
        }
      }
    }
    for (const e of evidence.values()) await this.verifyEvidence(e);
    assert(
      policy === digest(JSON.stringify(this.config())),
      'CHECK_POLICY_CHANGED',
      'Check policy changed during verification; retry',
    );
    for (const c of commands)
      this.prepared.set(c.commandId, {
        hash: digest(JSON.stringify(c)),
        at: Date.now(),
        policy,
        evidence: new Set(evidence.keys()),
      });
    for (const [key, v] of this.prepared) if (v.at < Date.now() - 30000) this.prepared.delete(key);
  }
  verifyCompletion(t: Entity, raw: unknown) {
    if (t.data.workType === 'research') {
      assert(
        t.data.evidence.some((e: any) => e.scope === 'research'),
        'RESEARCH_EVIDENCE_REQUIRED',
        'Research tasks require explicitly labeled research evidence',
      );
      return;
    }
    const delivery = this.store.get(t.data.deliveryId)!;
    const required: string[] = [
      ...new Set<string>(delivery.data.workflow.flatMap((s: any) => s.checks ?? [])),
    ];
    for (const key of required) {
      const evidence = t.data.evidence.find((e: any) => e.checkId === key);
      assert(evidence, 'CHECK_REQUIRED', `Missing evidence for ${key}`);
      const command = commandSchema.parse(raw),
        prepared = this.prepared.get(command.commandId);
      assert(
        prepared &&
          prepared.hash === digest(JSON.stringify(command)) &&
          prepared.at > Date.now() - 30000 &&
          prepared.policy === digest(JSON.stringify(this.config())) &&
          prepared.evidence.has(this.evidenceKey(evidence)),
        'CHECK_PREFLIGHT_REQUIRED',
        'Verify this exact command and policy asynchronously before completion',
      );
    }
  }
  batch(raw: unknown) {
    const b = batchSchema.parse(raw),
      fingerprint = digest(JSON.stringify(b.commands));
    const previous = this.store.db.prepare('SELECT * FROM import_jobs WHERE id=?').get(b.jobId);
    if (previous) {
      assert(
        previous.fingerprint === fingerprint,
        'IDEMPOTENCY_MISMATCH',
        'Import job ID reused with different commands',
      );
      return { ...JSON.parse(String(previous.result)), duplicate: true };
    }
    const result = this.store.executeBatch(b.commands, b.preview);
    const summary = {
      jobId: b.jobId,
      preview: b.preview,
      fingerprint,
      count: result.length,
      entities: result.map((v) => ({ id: v.entity!.id, version: v.entity!.version })),
      nextStep: b.preview
        ? 'Review the preview and resubmit the same commands with preview=false.'
        : 'Continue the next bounded batch with a different jobId.',
    };
    if (!b.preview)
      this.store.db
        .prepare('INSERT INTO import_jobs VALUES(?,?,?)')
        .run(b.jobId, fingerprint, JSON.stringify(summary));
    return summary;
  }
  reconcile(adapterId: string) {
    const adapter = this.config().adapters.find((v) => v.id === adapterId);
    assert(adapter, 'ADAPTER_MISSING', 'Configure this manifest adapter explicitly');
    const file = path.resolve(this.store.root, adapter.path),
      relative = path.relative(this.store.root, file);
    assert(
      !relative.startsWith('..') &&
        !path.isAbsolute(relative) &&
        fs.realpathSync.native(file) === file &&
        fs.statSync(file).size <= 10485760,
      'ADAPTER_SCOPE',
      'Manifest must be a bounded file inside this project without symlinks',
    );
    const bytes = fs.readFileSync(file),
      raw = JSON.parse(bytes.toString('utf8'));
    const tasks = z
      .array(
        z.object({ id: z.string().min(1).max(200), status: z.string().max(100) }).passthrough(),
      )
      .max(10000)
      .parse(Array.isArray(raw) ? raw : raw.tasks);
    assert(
      new Set(tasks.map((t) => t.id)).size === tasks.length,
      'DUPLICATE_SOURCE_ID',
      'Manifest has duplicate task IDs',
    );
    const records = this.store.all('task').filter((t) => t.data.source?.adapter === adapterId);
    const differences = tasks.flatMap((source) => {
      const matches = records.filter((t) => t.data.source.id === source.id);
      const t = matches[0];
      const target = adapter.stageMap[source.status];
      return !t || matches.length > 1 || !target || t.data.stageId !== target
        ? [
            {
              sourceId: source.id,
              sourceStatus: source.status,
              taskId: t?.id,
              expectedVersion: t?.version,
              targetStage: target ?? null,
              reason: !t
                ? 'missing-card'
                : matches.length > 1
                  ? 'ambiguous-source'
                  : !target
                    ? 'unmapped-status'
                    : 'stage-mismatch',
            },
          ]
        : [];
    });
    return {
      adapterId,
      fingerprint: digest(bytes),
      authority:
        'Manifest defines source checks; Nexo owns coordination. This report never writes either source.',
      differences,
      missingFromManifest: records
        .filter((t) => !tasks.some((v) => v.id === t.data.source.id))
        .map((t) => t.id),
      nextStep:
        'Review differences. Apply explicitly approved versioned commands through batch preview; no automatic overwrites.',
    };
  }
  usage(raw: unknown) {
    const sample = usageSchema.parse(raw);
    assert(
      this.config().telemetry,
      'TELEMETRY_DISABLED',
      'Opt in with telemetry=true in coordination.json',
    );
    assert(
      this.store.db.prepare('SELECT id FROM executions WHERE id=?').get(sample.executionId),
      'EXECUTION_MISSING',
      'Unknown execution',
    );
    const value = JSON.stringify(sample),
      prior = this.store.db.prepare('SELECT data FROM usage_samples WHERE id=?').get(sample.id);
    assert(
      !prior || prior.data === value,
      'IDEMPOTENCY_MISMATCH',
      'Usage ID reused with different content',
    );
    this.store.db.prepare('INSERT OR IGNORE INTO usage_samples VALUES(?,?)').run(sample.id, value);
    return { recorded: true, duplicate: !!prior, localOnly: true };
  }
  observe(key: string, bytes: number, latency: number) {
    this.store.db
      .prepare(
        'INSERT INTO coordination_metrics VALUES(?,1,?,?) ON CONFLICT(key) DO UPDATE SET count=count+1,bytes=bytes+excluded.bytes,latency_ms=latency_ms+excluded.latency_ms',
      )
      .run(key.slice(0, 120), bytes, latency);
  }
  clearTelemetry() {
    this.store.transaction(() => {
      this.store.db.exec('DELETE FROM usage_samples; DELETE FROM coordination_metrics;');
    });
    return { cleared: true, localOnly: true };
  }
  diagnostics() {
    const s = this.store,
      cfg = this.config();
    const workspaces = s.db
      .prepare('SELECT data FROM workspaces')
      .all()
      .map((r) => JSON.parse(String(r.data)));
    const usage = cfg.telemetry
      ? s.db
          .prepare('SELECT data FROM usage_samples')
          .all()
          .map((r) => JSON.parse(String(r.data)))
      : [];
    const totals = usage.reduce(
      (a, v) => {
        for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) a[key] += v[key];
        a.samples++;
        a.estimates += Number(v.source === 'estimate');
        return a;
      },
      { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, samples: 0, estimates: 0 },
    );
    const bySource = ['provider', 'estimate'].map((source) => ({
      source,
      ...usage
        .filter((v) => v.source === source)
        .reduce(
          (a, v) => {
            for (const key of ['input', 'cacheRead', 'cacheWrite', 'output']) a[key] += v[key];
            return a;
          },
          { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        ),
    }));
    const groups = new Map<string, any>();
    for (const sample of usage) {
      const e = this.executions().find((v) => v.id === sample.executionId);
      const key = [
        e?.deliveryId,
        sample.executionId,
        e?.model ?? 'unknown',
        sample.category,
        sample.source,
      ].join(':');
      const g = groups.get(key) ?? {
        deliveryId: e?.deliveryId,
        executionId: sample.executionId,
        model: e?.model,
        effort: e?.effort,
        category: sample.category,
        source: sample.source,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        responseBytes: 0,
        latencyMs: 0,
        samples: 0,
      };
      for (const field of [
        'input',
        'cacheRead',
        'cacheWrite',
        'output',
        'responseBytes',
        'latencyMs',
      ])
        g[field] += sample[field] ?? 0;
      g.samples++;
      groups.set(key, g);
    }
    const tasks = s.all('task'),
      checks = tasks.flatMap((t) =>
        this.checks(t).map((check: any) => ({ taskId: t.id, ...check })),
      );
    return {
      canonicalRoot: s.root,
      projectId: s.config.id,
      snapshot: s.snapshots.state(),
      conflicts: s.conflicts().length,
      workspaces: workspaces.map((w) => ({ ...w, missing: !fs.existsSync(w.path) })),
      staleAssignments: s
        .agents()
        .filter((a) => a.state !== 'working')
        .map((a) => this.publicAgent(a)),
      resources: this.resourceStatus(cfg.resources.map((r) => r.id)),
      checks,
      waiting: tasks.filter((t) => t.data.waiting).map((t) => ({ id: t.id, ...this.readiness(t) })),
      acceptance: s.all('delivery').map((d) => {
        const children = tasks.filter((t) => t.data.deliveryId === d.id);
        const pending = children.filter((t) => this.phase(t) !== 'done').length;
        return {
          id: d.id,
          pending,
          ready:
            children.length > 0 &&
            pending === 0 &&
            !checks.some((c) => children.some((t) => t.id === c.taskId) && c.status !== 'PASS'),
        };
      }),
      telemetry: {
        enabled: cfg.telemetry,
        localOnly: true,
        totals,
        bySource,
        groups: [...groups.values()],
        billing: 'No cost inferred. Provider usage and estimates remain labeled separately.',
      },
      coordinationMetrics: cfg.telemetry
        ? s.db.prepare('SELECT * FROM coordination_metrics ORDER BY key').all()
        : [],
      modelGuidance:
        'Use focused context and explicit checkpoints first. Choose models per task complexity; no automatic model downgrade.',
    };
  }
  deduplicateHook(key: string) {
    const hash = digest(key);
    const now = Date.now();
    this.store.db.prepare('DELETE FROM hook_seen WHERE at<?').run(now - 3600000);
    return (
      Number(
        this.store.db.prepare('INSERT OR IGNORE INTO hook_seen VALUES(?,?)').run(hash, now).changes,
      ) === 0
    );
  }
}
