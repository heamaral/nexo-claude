import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { fixture, seed, claim, command } from './helpers.mjs';
import { readHookInput } from '../plugins/nexo/runtime/hooks.mjs';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
import { findProject } from '../plugins/nexo/runtime/project.mjs';

function config(f, fields) {
  fs.writeFileSync(
    path.join(f.root, '.nexo/coordination.json'),
    JSON.stringify({ schema: 1, ...fields }),
  );
}
test('durable evidence rejects unsupported credential fields before creating an event', () => {
  const f = fixture();
  try {
    seed(f.store);
    const count = f.store.events().length;
    assert.throws(
      () =>
        command(
          f.store,
          'task',
          'tokens',
          { evidence: [{ label: 'Evidence', leaseToken: 'must-stay-ephemeral' }] },
          'update',
        ),
      /unsupported fields/,
    );
    assert.equal(f.store.events().length, count);
    assert.ok(!JSON.stringify(f.store.events()).includes('must-stay-ephemeral'));
  } finally {
    f.close();
  }
});
const create = (key, data) => ({
  commandId: crypto.randomUUID(),
  actor: 'importer',
  kind: 'task',
  id: key,
  expectedVersion: 0,
  op: 'create',
  data: { deliveryId: 'delivery', title: key, ...data },
});

test('representative 291-card workload: focused context is bounded, pagination complete and presence leaves durable revisions unchanged', () => {
  const f = fixture();
  try {
    seed(f.store);
    for (let offset = 0; offset < 288; offset += 80) {
      const commands = Array.from({ length: Math.min(80, 288 - offset) }, (_, i) =>
        create(`work-${String(offset + i).padStart(4, '0')}`, {
          description: 'Representative project detail. '.repeat(100),
          aliases: ['vento', 'wind'],
          checkpoint: {
            goal: 'Test context',
            remaining: ['Integrate'],
            references: ['src/wind.ts'],
            nextStep: 'Verify',
          },
        }),
      );
      f.store.coordination.batch({ jobId: 'page-' + offset, preview: false, commands });
    }
    assert.equal(f.store.all('task').length, 291);
    const full = Buffer.byteLength(JSON.stringify(f.store.state()));
    const focused = f.store.coordination.query({ view: 'task', id: 'tokens' });
    assert.ok(Buffer.byteLength(JSON.stringify(focused)) < full / 20);
    const seen = new Set();
    let cursor;
    do {
      const page = f.store.coordination.query({
        view: 'delivery',
        id: 'delivery',
        kind: 'task',
        limit: 31,
        cursor,
      });
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < 24000);
      for (const v of page.items) {
        assert.ok(!seen.has(v.id));
        seen.add(v.id);
      }
      cursor = page.nextCursor;
    } while (cursor);
    assert.equal(seen.size, 291);
    const before = f.store.durableRevision,
      a = f.store.claim(claim());
    const after = f.store.durableRevision;
    assert.ok(after > before);
    assert.equal(f.store.claim(claim()).token, a.token);
    f.store.heartbeat(a.token);
    assert.equal(f.store.durableRevision, after);
    const delta = f.store.coordination.query({ view: 'changes', sinceRevision: before });
    assert.ok(delta.entities.every((e) => ['tokens', 'delivery'].includes(e.id)));
    assert.ok(!JSON.stringify(delta).includes(a.token));
    assert.ok(
      f.store.coordination.query({ view: 'search', query: 'src/wind.ts', limit: 2 }).items.length,
    );
    assert.equal(
      f.store.coordination.query({ view: 'summary', maxBytes: 2048 }).budgetExceeded,
      undefined,
    );
  } finally {
    f.close();
  }
});

test('batch preview and failed batches leave no entities, events, exports or revisions; replay jobs are safe', () => {
  const f = fixture();
  try {
    seed(f.store);
    const revision = f.store.revision,
      events = f.store.events().length,
      files = fs.readdirSync(f.store.eventsDir);
    const commands = [
      create('parent'),
      create('child', {
        parentId: 'parent',
        source: { adapter: 'q9', id: 'q9-child', status: 'Ready' },
      }),
    ];
    f.store.coordination.batch({ jobId: 'import', commands });
    assert.equal(f.store.get('parent'), undefined);
    assert.equal(f.store.events().length, events);
    assert.equal(f.store.revision, revision);
    assert.deepEqual(fs.readdirSync(f.store.eventsDir), files);
    assert.throws(
      () =>
        f.store.coordination.batch({
          jobId: 'bad',
          preview: false,
          commands: [...commands, create('oops', { parentId: 'missing' })],
        }),
      /Parent card/,
    );
    assert.equal(f.store.get('parent'), undefined);
    const result = f.store.coordination.batch({ jobId: 'import', preview: false, commands });
    assert.equal(result.count, 2);
    assert.equal(
      f.store.coordination.batch({ jobId: 'import', preview: false, commands }).duplicate,
      true,
    );
    assert.throws(
      () =>
        f.store.coordination.batch({
          jobId: 'import',
          preview: false,
          commands: [create('other')],
        }),
      /reused/,
    );
    assert.equal(f.store.get('child').data.source.status, 'Ready');
  } finally {
    f.close();
  }
});

test('resource locks, waiting reasons, checkpoints, immutable execution export and opt-in usage', () => {
  const f = fixture();
  try {
    seed(f.store);
    config(f, { telemetry: true, resources: [{ id: 'unity', capacity: 1 }] });
    const a = f.store.claim(
      claim('tokens', { resources: ['unity'], model: 'test-model', effort: 'high' }),
    );
    assert.throws(
      () =>
        f.store.claim(
          claim('form', {
            agentId: 'b',
            teamId: 'frontend',
            scopes: ['src/ui'],
            resources: ['unity'],
          }),
        ),
      /Resource unity/,
    );
    const usage = {
      id: 'usage-1',
      executionId: a.executionId,
      input: 100,
      cacheRead: 50,
      output: 20,
      source: 'provider',
    };
    f.store.coordination.usage(usage);
    assert.equal(f.store.coordination.usage(usage).duplicate, true);
    f.store.coordination.usage({ ...usage, id: 'estimate-1', source: 'estimate', input: 60 });
    assert.equal(f.store.coordination.diagnostics().telemetry.bySource[0].input, 100);
    f.store.release(a.token);
    assert.equal(f.store.coordination.executions('tokens')[0].status, 'released');
    f.store.coordination.exportExecutions();
    const output = fs.readFileSync(
      path.join(f.root, '.nexo/executions', a.executionId + '.json'),
      'utf8',
    );
    assert.ok(!output.includes(a.token));
    assert.ok(!output.includes(a.sessionId));
    assert.ok(!output.includes(f.root));
    command(
      f.store,
      'task',
      'tokens',
      {
        waiting: {
          reason: 'user-test',
          owner: 'User',
          nextAction: 'Run editor acceptance',
          since: new Date().toISOString(),
        },
        checkpoint: {
          goal: 'Recover',
          remaining: ['Acceptance'],
          decisions: ['Preserve fidelity'],
          rejected: ['Unverified constants'],
          references: ['src/wind.ts'],
          nextStep: 'Run editor',
        },
      },
      'update',
    );
    assert.throws(() => f.store.claim(claim()), /waiting reason/);
    assert.equal(f.store.coordination.schedule().tasks.find((t) => t.id === 'tokens').ready, false);
    command(f.store, 'task', 'tokens', { waiting: null }, 'update');
    const next = f.store.claim(claim());
    assert.ok(next.fence > a.fence);
    assert.throws(() => f.store.heartbeat(a.token), /expired or replaced/);
    assert.throws(() => f.store.claim(claim('form', { scopes: ['other'] })), /another execution/);
  } finally {
    f.close();
  }
});

test('manifest reconciliation never changes source or cards and preserves stable identities', () => {
  const f = fixture();
  try {
    seed(f.store);
    command(
      f.store,
      'task',
      'tokens',
      { source: { adapter: 'q9', id: 'stable-token', status: 'Todo' } },
      'update',
    );
    config(f, {
      adapters: [{ id: 'q9', path: 'manifest.json', stageMap: { Done: 'done', Todo: 'backlog' } }],
    });
    const text = JSON.stringify({
      tasks: [
        { id: 'stable-token', status: 'Done' },
        { id: 'missing', status: 'Todo' },
      ],
    });
    fs.writeFileSync(path.join(f.root, 'manifest.json'), text);
    const version = f.store.get('tokens').version,
      report = f.store.coordination.reconcile('q9');
    assert.equal(report.differences.length, 2);
    assert.equal(report.differences[0].expectedVersion, version);
    assert.equal(f.store.get('tokens').version, version);
    assert.equal(fs.readFileSync(path.join(f.root, 'manifest.json'), 'utf8'), text);
  } finally {
    f.close();
  }
});

test('large image and shell hook payloads are projected in chunks without retaining output', async () => {
  const payload = JSON.stringify({
    session_id: 'session',
    agent_id: 'agent',
    hook_event_name: 'PostToolUse',
    cwd: 'C:/prójèct',
    tool_use_id: 'call-1',
    tool_input: { file_path: 'src/vento.ts', command: 'x'.repeat(1024 * 1024) },
    tool_response: { image: 'x'.repeat(4 * 1024 * 1024) },
  });
  const bytes = Buffer.from(payload),
    chunks = Array.from({ length: Math.ceil(bytes.length / 1021) }, (_, i) =>
      bytes.subarray(i * 1021, (i + 1) * 1021),
    );
  const value = await readHookInput(Readable.from(chunks));
  assert.equal(value.cwd, 'C:/prójèct');
  assert.equal(value.tool_input.file_path, 'src/vento.ts');
  assert.equal(value.tool_response, undefined);
  assert.ok(JSON.stringify(value).length < 500);
  await assert.rejects(readHookInput(Readable.from(['{"cwd":"unfinished'])), /Incomplete/);
});

test('trusted checks reject forged and stale evidence; successful runs attest the exact integrated commit', async () => {
  const f = fixture();
  try {
    seed(f.store);
    const git = (args) =>
      execFileSync('git', args, {
        cwd: f.root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Nexo Fixture']);
    const a = f.store.claim(claim());
    const delivery = f.store.get('delivery');
    command(
      f.store,
      'delivery',
      'delivery',
      {
        workflow: delivery.data.workflow.map((s) =>
          s.id === 'review' ? { ...s, checks: ['acceptance'] } : s,
        ),
      },
      'update',
    );
    config(f, {
      repositories: [{ id: 'main', path: '.', integratedRef: 'HEAD' }],
      checks: [
        {
          id: 'acceptance',
          repoId: 'main',
          artifact: '.nexo/local/checks/acceptance.json',
          executable: process.execPath,
          args: ['-e', 'process.exit(0)'],
        },
      ],
    });
    git(['add', '.']);
    git(['commit', '-m', 'Fixture source']);
    const evidence = await f.store.coordination.runCheck({
      taskId: 'tokens',
      token: a.token,
      checkId: 'acceptance',
    });
    assert.equal(evidence.status, 'PASS');
    assert.equal((await f.store.coordination.verifyEvidence(evidence)).status, 'PASS');
    await assert.rejects(
      f.store.coordination.verifyEvidence({ ...evidence, runId: 'forged' }),
      /did not run/,
    );
    const completion = {
      commandId: crypto.randomUUID(),
      actor: a.agentId,
      op: 'update',
      kind: 'task',
      id: 'tokens',
      expectedVersion: f.store.get('tokens').version,
      leaseToken: a.token,
      data: { stageId: 'done', result: 'Verified integration', evidence: [evidence] },
    };
    assert.throws(() => f.store.execute(completion), /asynchronously/);
    await f.store.coordination.prepareCommands([completion]);
    assert.throws(
      () =>
        f.store.execute({ ...completion, data: { ...completion.data, result: 'Changed intent' } }),
      /asynchronously/,
    );
    f.store.execute(completion);
    fs.writeFileSync(path.join(f.root, 'new-source.txt'), 'new');
    git(['add', '.']);
    git(['commit', '-m', 'Changed integration']);
    await assert.rejects(f.store.coordination.verifyEvidence(evidence), /integrated ref/);
    await f.store.coordination.prepareCommands([completion]);
    assert.equal(
      f.store.execute(completion).duplicate,
      true,
      'already committed commands remain idempotent after source moves',
    );
  } finally {
    f.close();
  }
});

test('post-tool failures never authorize writes; repeated rejected pre-tools remain rejected; Stop preserves ownership', async () => {
  const f = fixture();
  seed(f.store);
  f.store.close();
  const server = await startServer(f.root, { registry: false });
  const post = async (body) =>
    fetch(server.origin + '/api/hook', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + server.registry.token },
      body: JSON.stringify(body),
    });
  try {
    const body = {
      sessionId: 'session-a',
      agentId: 'agent-a',
      event: 'PreToolUse',
      toolUseId: 'same',
      toolName: 'Write',
      filePath: 'src/api/file.ts',
      workspace: f.root,
    };
    assert.equal((await post(body)).status, 409);
    assert.equal((await post(body)).status, 409);
    assert.equal((await post({ ...body, event: 'PostToolUseFailure' })).status, 200);
    const a = server.store.claim(claim());
    assert.equal((await post({ ...body, event: 'Stop' })).status, 200);
    assert.equal(server.store.agents()[0].token, a.token);
    assert.equal((await post({ ...body, event: 'SessionEnd' })).status, 200);
    assert.equal(server.store.agents().length, 0);
  } finally {
    await server.close();
    f.close();
  }
});

test('registered worktrees use one coordinator, isolate file scopes and reject stale links', async () => {
  const f = fixture();
  try {
    seed(f.store);
    const git = (args) =>
      execFileSync('git', args, {
        cwd: f.root,
        encoding: 'utf8',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    git(['init']);
    git(['config', 'user.email', 'fixture@example.invalid']);
    git(['config', 'user.name', 'Fixture']);
    fs.appendFileSync(path.join(f.root, '.gitignore'), '\n.worktrees/\n');
    git(['add', '.']);
    git(['commit', '-m', 'Source']);
    const checkout = path.join(f.root, '.worktrees/a');
    git(['worktree', 'add', '-b', 'worker-a', checkout]);
    const w = await f.store.coordination.registerWorkspace({
      id: 'worker-a',
      path: checkout,
      mode: 'isolated',
      expectedProjectId: f.store.config.id,
    });
    assert.equal(w.canonicalRoot, f.root);
    assert.equal(findProject(checkout), f.root);
    f.store.claim(claim('tokens', { scopes: ['src/shared'] }));
    f.store.claim(
      claim('form', {
        agentId: 'b',
        teamId: 'frontend',
        scopes: ['src/shared'],
        workspaceId: 'worker-a',
      }),
    );
    command(f.store, 'task', 'third', {
      deliveryId: 'delivery',
      teamId: 'frontend',
      title: 'Third',
    });
    await f.store.coordination.registerWorkspace({
      id: 'alias',
      path: checkout,
      mode: 'isolated',
      expectedProjectId: f.store.config.id,
    });
    assert.throws(
      () =>
        f.store.claim(
          claim('third', {
            agentId: 'c',
            teamId: 'frontend',
            scopes: ['src/shared/file.ts'],
            workspaceId: 'alias',
          }),
        ),
      /Write scope owned/,
    );
    await assert.rejects(
      f.store.coordination.registerWorkspace({
        id: 'worker-a',
        path: f.root,
        mode: 'shared',
        expectedProjectId: f.store.config.id,
      }),
      /Release active workspace claims/,
    );
    assert.equal(f.store.coordination.workspace('worker-a').path, checkout);
    const privateGit = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
      cwd: checkout,
      encoding: 'utf8',
      windowsHide: true,
    }).trim();
    fs.writeFileSync(
      path.join(privateGit, 'nexo-coordinator.json'),
      JSON.stringify({ schema: 1, root: f.root, projectId: crypto.randomUUID() }),
    );
    assert.throws(() => findProject(checkout), /changed identity/);
  } finally {
    f.close();
  }
});
