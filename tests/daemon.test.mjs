import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fixture } from './helpers.mjs';

test('parallel clients start one detached service and shutdown leaves no registry', async () => {
  const f = fixture();
  f.store.close();
  const file = path.join(f.root, '.nexo/local/server.json');
  try {
    const cli = path.resolve('plugins/nexo/runtime/cli.mjs');
    const run = () =>
      new Promise((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--disable-warning=ExperimentalWarning', cli, 'board', '--no-open', '--project', f.root],
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
    const results = await Promise.all([run(), run(), run(), run()]);
    assert.equal(new Set(results.map((r) => new URL(r.url).origin)).size, 1);
    const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await fetch(`http://127.0.0.1:${registry.port}/api/shutdown`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + registry.token },
      body: '{}',
    });
    assert.equal(r.status, 200);
    for (let i = 0; i < 100 && fs.existsSync(file); i++)
      await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(fs.existsSync(file), false);
  } finally {
    f.close();
  }
});
