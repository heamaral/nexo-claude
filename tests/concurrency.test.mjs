import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { once } from 'node:events';
import { fork, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { fixture, command, seed, claim } from './helpers.mjs';
import { Store } from '../plugins/nexo/runtime/store.mjs';
import { startServer } from '../plugins/nexo/runtime/server.mjs';

const snapshotPath = (root) => path.join(root, '.nexo/project.sqlite');
const staged = (root) =>
  fs.readdirSync(path.join(root, '.nexo/local')).filter((n) => n.startsWith('snapshot-v2-'));
async function until(check, timeout = 6000) {
  const end = Date.now() + timeout;
  while (!check()) {
    assert.ok(Date.now() < end, 'Condition timed out');
    await delay(20);
  }
}
async function owner(root, mode = '') {
  const child = fork(path.resolve('tests/fixtures/writer.mjs'), [root, mode], {
    silent: true,
    windowsHide: true,
  });
  const outcome = await Promise.race([
    once(child, 'message').then(() => 'ready'),
    once(child, 'exit').then(([code]) => {
      throw new Error('Writer exited early: ' + code);
    }),
  ]);
  assert.equal(outcome, 'ready');
  return child;
}

test('directory writer ownership survives old mtimes and releases after an actual process crash', async () => {
  const f = fixture();
  let child;
  try {
    seed(f.store);
    const lease = f.store.claim(claim());
    assert.throws(
      () => new Store(f.root),
      (e) => e.code === 'WRITER_BUSY',
    );
    const ancient = new Date(0);
    fs.utimesSync(path.join(f.root, '.nexo/local/writer.sqlite'), ancient, ancient);
    assert.throws(
      () => new Store(f.root),
      (e) => e.code === 'WRITER_BUSY',
    );
    f.store.close();
    child = await owner(f.root, 'outbox');
    assert.throws(
      () => new Store(f.root),
      (e) => e.code === 'WRITER_BUSY',
    );
    const died = once(child, 'exit');
    child.kill('SIGKILL');
    await died;
    child = undefined;
    const recovered = new Store(f.root);
    try {
      assert.equal(recovered.get('outbox').data.title, 'Committed before crash');
      assert.equal(
        recovered.db.prepare('SELECT COUNT(*) n FROM events WHERE exported=0').get().n,
        0,
      );
      assert.equal(recovered.heartbeat(lease.token).token, lease.token);
      assert.equal(recovered.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    } finally {
      recovered.close();
    }
  } finally {
    if (child) {
      const died = once(child, 'exit');
      child.kill('SIGKILL');
      await died;
    }
    f.close();
  }
});

test('snapshot requests coalesce, flush through their own generation and do not follow heartbeats', async () => {
  const f = fixture();
  const rename = fs.promises.rename;
  try {
    seed(f.store);
    const lease = f.store.claim(claim());
    await f.store.snapshot();
    const before = f.store.snapshots.state();
    for (let i = 0; i < 50; i++) f.store.heartbeat(lease.token, 'Activity ' + i);
    assert.equal(f.store.snapshots.state().generation, before.generation);
    await f.store.snapshot();
    assert.equal(f.store.snapshots.state().publications, before.publications);
    let failures = 0;
    fs.promises.rename = async (from, to) => {
      if (to === snapshotPath(f.root) && failures++ < 3)
        throw Object.assign(new Error('Fixture sharing violation'), { code: 'EPERM' });
      return rename(from, to);
    };
    command(f.store, 'delivery', 'delivery', { description: 'First generation' }, 'update');
    const first = Array.from({ length: 20 }, () => f.store.snapshot());
    await until(() => f.store.snapshots.state().status === 'retrying');
    // File retry yields the event loop. A newer generation is captured separately.
    command(f.store, 'delivery', 'delivery', { description: 'Second generation' }, 'update');
    const next = Array.from({ length: 20 }, () => f.store.snapshot());
    await Promise.all([...first, ...next]);
    assert.equal(f.store.snapshots.state().publications - before.publications, 2);
    assert.equal(f.store.snapshots.state().dirty, false);
    assert.equal(f.store.snapshots.state().lastError, null);
    assert.equal(staged(f.root).length, 0);
    const db = new DatabaseSync(snapshotPath(f.root), { readOnly: true });
    try {
      assert.equal(
        JSON.parse(db.prepare("SELECT data FROM entities WHERE id='delivery'").get().data)
          .description,
        'Second generation',
      );
      assert.equal(db.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
    } finally {
      db.close();
    }
    assert.ok(!fs.readFileSync(snapshotPath(f.root)).includes(Buffer.from(lease.token)));
  } finally {
    fs.promises.rename = rename;
    f.close();
  }
});

test('persistent sharing violations have a deadline and never unlink the published snapshot', async () => {
  const f = fixture();
  const rename = fs.promises.rename;
  try {
    seed(f.store);
    const lease = f.store.claim(claim());
    await f.store.snapshot();
    const original = fs.readFileSync(snapshotPath(f.root));
    command(f.store, 'delivery', 'delivery', { description: 'Blocked publication' }, 'update');
    let attempts = 0;
    fs.promises.rename = async () => {
      attempts++;
      throw Object.assign(new Error('Fixture busy handle'), { code: 'EPERM' });
    };
    const started = Date.now();
    const result = Promise.allSettled(Array.from({ length: 12 }, () => f.store.snapshot()));
    await until(() => f.store.snapshots.state().status === 'retrying');
    assert.ok(f.store.heartbeat(lease.token));
    assert.deepEqual(fs.readFileSync(snapshotPath(f.root)), original);
    const completed = await result;
    assert.ok(
      completed.every((r) => r.status === 'rejected' && r.reason.code === 'SNAPSHOT_PENDING'),
    );
    assert.ok(Date.now() - started >= 2900 && Date.now() - started < 6000);
    assert.ok(attempts > 1 && attempts < 25);
    assert.equal(staged(f.root).length, 0);
    assert.equal(f.store.snapshots.state().dirty, true);
    assert.deepEqual(fs.readFileSync(snapshotPath(f.root)), original);
    fs.promises.rename = rename;
    await f.store.snapshot();
    assert.equal(f.store.snapshots.state().lastError, null);
  } finally {
    fs.promises.rename = rename;
    f.close();
  }
});

test('manual flush repairs a derived binary replaced or removed outside the daemon', async () => {
  const f = fixture();
  try {
    seed(f.store);
    await f.store.snapshot();
    fs.rmSync(snapshotPath(f.root));
    await f.store.snapshot();
    fs.writeFileSync(snapshotPath(f.root), 'A binary conflict from Git');
    await f.store.snapshot();
    const db = new DatabaseSync(snapshotPath(f.root), { readOnly: true });
    try {
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      assert.equal(db.prepare('SELECT COUNT(*) n FROM entities').get().n, 6);
    } finally {
      db.close();
    }
    assert.equal(f.store.snapshots.state().dirty, false);
  } finally {
    f.close();
  }
});

test('a startup owner is never stolen by age; process death releases the mutex and abandoned guard', async () => {
  const f = fixture();
  f.store.close();
  let holder, client;
  const file = path.join(f.root, '.nexo/local/server.json');
  try {
    holder = await owner(f.root, 'startup');
    client = spawn(
      process.execPath,
      [path.resolve('plugins/nexo/runtime/cli.mjs'), 'board', '--no-open', '--project', f.root],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '';
    client.stdout.on('data', (c) => {
      output += c;
    });
    client.stderr.on('data', (c) => {
      error += c;
    });
    const finished = once(client, 'exit');
    await delay(500);
    assert.equal(fs.existsSync(file), false);
    const died = once(holder, 'exit');
    holder.kill('SIGKILL');
    await died;
    holder = undefined;
    assert.equal((await finished)[0], 0, error);
    client = undefined;
    assert.ok(new URL(JSON.parse(output).url));
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(registry.writerProtocol, 2);
    assert.equal(fs.existsSync(path.join(f.root, '.nexo/local/startup.lock')), false);
  } finally {
    for (const child of [holder, client].filter(Boolean)) {
      const died = once(child, 'exit');
      child.kill('SIGKILL');
      await died;
    }
    if (fs.existsSync(file)) {
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      await fetch(`http://127.0.0.1:${r.port}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + r.token },
        body: '{}',
      });
      await until(() => !fs.existsSync(file));
    }
    f.close();
  }
});

test('a failed publication preserves the old file, keeps agents/commands healthy and recovers automatically', async () => {
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  const rename = fs.promises.rename;
  const headers = {
    Authorization: 'Bearer ' + s.registry.token,
    'Content-Type': 'application/json',
  };
  const post = (route, body) =>
    fetch(s.origin + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
  try {
    seed(s.store);
    const lease = s.store.claim(claim());
    await s.store.snapshot();
    const oldFile = fs.readFileSync(snapshotPath(f.root));
    fs.promises.rename = async (from, to) => {
      if (to === snapshotPath(f.root))
        throw Object.assign(new Error('Fixture disk I/O failure'), { code: 'EIO' });
      return rename(from, to);
    };
    command(s.store, 'delivery', 'delivery', { description: 'Needs export' }, 'update');
    const result = await post('snapshot', {});
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error, 'SNAPSHOT_PENDING');
    assert.deepEqual(fs.readFileSync(snapshotPath(f.root)), oldFile);
    assert.equal(staged(f.root).length, 0);
    let state = await (await fetch(s.origin + '/api/state', { headers })).json();
    assert.equal(state.healthError, null);
    assert.equal(state.snapshot.lastError.code, 'EIO');
    assert.equal(
      (await post('heartbeat', { token: lease.token, activity: 'Still working' })).status,
      200,
    );
    assert.equal(
      (
        await post('command', {
          commandId: crypto.randomUUID(),
          actor: 'test',
          kind: 'task',
          id: 'new-task',
          op: 'create',
          expectedVersion: 0,
          data: { deliveryId: 'delivery', title: 'Created during export failure' },
        })
      ).status,
      200,
    );
    fs.promises.rename = rename;
    await until(() => !s.store.snapshots.state().dirty);
    state = await (await fetch(s.origin + '/api/state', { headers })).json();
    assert.equal(state.snapshot.lastError, null);
    assert.ok(state.entities.some((e) => e.id === 'new-task'));
    assert.equal(state.agents.length, 1);
  } finally {
    fs.promises.rename = rename;
    await s.close();
    f.close();
  }
});

test('an unexported committed event is retried before reconciliation or idempotent replay', async () => {
  const f = fixture();
  const rename = fs.renameSync;
  const input = {
    commandId: crypto.randomUUID(),
    actor: 'test',
    kind: 'delivery',
    id: 'outbox',
    op: 'create',
    expectedVersion: 0,
    data: { title: 'Preserved' },
  };
  try {
    fs.renameSync = (from, to) => {
      if (to.includes('events'))
        throw Object.assign(new Error('Sharing violation'), { code: 'EPERM' });
      return rename(from, to);
    };
    assert.throws(() => f.store.execute(input), /Sharing violation/);
    assert.equal(f.store.get('outbox').version, 1);
    assert.throws(() => f.store.sync(), /Sharing violation/);
    assert.equal(f.store.get('outbox').version, 1);
    fs.renameSync = rename;
    assert.equal(f.store.execute(input).duplicate, true);
    assert.equal(f.store.get('outbox').version, 1);
    assert.equal(f.store.events().length, 1);
    assert.equal(
      fs.readdirSync(path.join(f.root, '.nexo/events')).filter((n) => n.endsWith('.json')).length,
      1,
    );
  } finally {
    fs.renameSync = rename;
    f.close();
  }
});

test('shutdown drains HTTP and releases ownership even when the snapshot cannot be published', async () => {
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root);
  const rename = fs.promises.rename;
  try {
    seed(s.store);
    const lease = s.store.claim(claim());
    await s.store.snapshot();
    command(s.store, 'delivery', 'delivery', { description: 'Pending at shutdown' }, 'update');
    fs.promises.rename = async () => {
      throw Object.assign(new Error('Fixture I/O error'), { code: 'EIO' });
    };
    await Promise.all([s.close(), s.close()]);
    assert.equal(s.store.closed, true);
    assert.equal(fs.existsSync(path.join(f.root, '.nexo/local/server.json')), false);
    fs.promises.rename = rename;
    const recovered = new Store(f.root);
    try {
      assert.equal(recovered.get('delivery').data.description, 'Pending at shutdown');
      assert.equal(recovered.heartbeat(lease.token).token, lease.token);
      await recovered.snapshot();
    } finally {
      recovered.close();
    }
  } finally {
    fs.promises.rename = rename;
    await s.close();
    f.close();
  }
});

test('a streaming mutation is explicitly rejected if shutdown starts before its body is complete', async () => {
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  try {
    command(s.store, 'delivery', 'before', { title: 'Accepted before drain' });
    const body = JSON.stringify({
      commandId: crypto.randomUUID(),
      actor: 'test',
      kind: 'delivery',
      id: 'late',
      op: 'create',
      expectedVersion: 0,
      data: { title: 'Must be rejected' },
    });
    const seen = once(s.server, 'request');
    let req;
    const response = new Promise((resolve, reject) => {
      req = http.request(
        s.origin + '/api/command',
        {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + s.registry.token,
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          let value = '';
          res.on('data', (c) => {
            value += c;
          });
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(value) }));
        },
      );
      req.on('error', reject);
      req.write(body.slice(0, 20));
    });
    await seen;
    const closed = s.close();
    req.end(body.slice(20));
    const result = await response;
    assert.equal(result.status, 503);
    assert.equal(result.body.error, 'SERVER_DRAINING');
    await closed;
    const recovered = new Store(f.root);
    try {
      assert.ok(recovered.get('before'));
      assert.equal(recovered.get('late'), undefined);
    } finally {
      recovered.close();
    }
  } finally {
    await s.close();
    f.close();
  }
});

test(
  'Windows sharing violation: an actual open handle delays replacement without blocking agents',
  { skip: process.platform !== 'win32' },
  async () => {
    const f = fixture();
    let reader;
    try {
      seed(f.store);
      const lease = f.store.claim(claim());
      await f.store.snapshot();
      const oldFile = fs.readFileSync(snapshotPath(f.root));
      reader = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$stream = [System.IO.File]::Open($env:NEXO_SNAPSHOT_FIXTURE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); [Console]::WriteLine("locked"); [Console]::ReadLine() | Out-Null; $stream.Dispose()',
        ],
        {
          env: { ...process.env, NEXO_SNAPSHOT_FIXTURE: snapshotPath(f.root) },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      let output = '';
      reader.stdout.on('data', (c) => {
        output += c;
      });
      await until(() => output.includes('locked'));
      command(f.store, 'delivery', 'delivery', { description: 'Windows handle test' }, 'update');
      const publishing = f.store.snapshot();
      await until(() => f.store.snapshots.state().status === 'retrying');
      assert.deepEqual(fs.readFileSync(snapshotPath(f.root)), oldFile);
      assert.ok(f.store.heartbeat(lease.token));
      const exited = once(reader, 'exit');
      reader.stdin.end('\n');
      await exited;
      reader = undefined;
      await publishing;
      assert.equal(f.store.snapshots.state().lastError, null);
      assert.equal(staged(f.root).length, 0);
    } finally {
      if (reader) {
        const died = once(reader, 'exit');
        reader.kill('SIGKILL');
        await died;
      }
      if (f.store.snapshots.busy) await f.store.snapshot().catch(() => {});
      f.close();
    }
  },
);
