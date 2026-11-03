import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fixture, seed, claim } from './helpers.mjs';
import { VERSION, compareVersions } from '../src/version.ts';

const run = (root) =>
  new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        path.resolve('plugins/nexo/runtime/cli.mjs'),
        'board',
        '--no-open',
        '--project',
        root,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '',
      error = '';
    child.stdout.on('data', (c) => (output += c));
    child.stderr.on('data', (c) => (error += c));
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve(JSON.parse(output)) : reject(new Error(error)),
    );
  });
async function fakeDaemon(root, version) {
  const instance = crypto.randomUUID(),
    file = path.join(root, '.nexo/local/server.json');
  let shutdowns = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/health') res.end(JSON.stringify({ instance, version }));
    else if (req.url === '/api/ticket')
      res.end(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}/#ticket=fixture` }));
    else if (req.url === '/api/shutdown') {
      shutdowns++;
      res.end('{}');
      setImmediate(() =>
        server.close(() => {
          if (
            fs.existsSync(file) &&
            JSON.parse(fs.readFileSync(file, 'utf8')).instance === instance
          )
            fs.rmSync(file);
        }),
      );
    } else {
      res.statusCode = 404;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const registry = {
    version: 1,
    pid: process.pid,
    instance,
    port: server.address().port,
    root,
    token: 'fixture-secret',
  };
  fs.writeFileSync(file, JSON.stringify(registry));
  return { server, registry, file, shutdowns: () => shutdowns };
}
test('upgrade replaces an older daemon once, preserving project data and active leases', async () => {
  const f = fixture();
  seed(f.store);
  const lease = f.store.claim(claim());
  f.store.close();
  const old = await fakeDaemon(f.root, '1.0.0-rc.1');
  try {
    await Promise.all([run(f.root), run(f.root), run(f.root)]);
    const registry = JSON.parse(fs.readFileSync(old.file, 'utf8'));
    assert.notEqual(registry.instance, old.registry.instance);
    assert.equal(old.shutdowns(), 1);
    const headers = { Authorization: 'Bearer ' + registry.token };
    const origin = `http://127.0.0.1:${registry.port}`;
    const state = await (await fetch(origin + '/api/state', { headers })).json();
    assert.ok(state.entities.some((e) => e.id === 'tokens'));
    assert.ok(state.agents.some((a) => a.agentId === 'agent-a' && a.state === 'working'));
    const heartbeat = await fetch(origin + '/api/heartbeat', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: lease.token }),
    });
    assert.equal(heartbeat.status, 200);
    const health = await (await fetch(origin + '/api/health')).json();
    assert.equal(health.version, VERSION);
    await fetch(origin + '/api/shutdown', { method: 'POST', headers, body: '{}' });
    for (let i = 0; i < 100 && fs.existsSync(old.file); i++)
      await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.existsSync(old.file), false);
  } finally {
    await new Promise((resolve) => old.server.close(() => resolve()));
    f.close();
  }
});
test('an older client reuses a newer daemon instead of causing a downgrade loop', async () => {
  const f = fixture();
  f.store.close();
  const newer = await fakeDaemon(f.root, '1.0.0-rc.99');
  try {
    const result = await run(f.root);
    assert.equal(new URL(result.url).port, String(newer.registry.port));
    assert.equal(newer.shutdowns(), 0);
  } finally {
    await new Promise((resolve) => newer.server.close(resolve));
    f.close();
  }
});
test('runtime ordering respects prerelease numbers and stable releases', () => {
  assert.ok(compareVersions('1.0.0-rc.10', '1.0.0-rc.2') > 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.99') > 0);
  assert.ok(compareVersions('2.0.0-rc.1', '1.9.9') > 0);
  assert.equal(compareVersions(VERSION, VERSION), 0);
  assert.throws(() => compareVersions('unknown', VERSION));
});
