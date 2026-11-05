import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export function isolatedRuntimeFixture() {
  const temp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-runtime-test-')));
  const plugin = path.resolve('plugins/nexo');
  const data = path.join(temp, 'private runtime cache');
  const project = path.join(temp, 'project with spaces');
  fs.mkdirSync(project);
  const minimalPath =
    process.platform === 'win32'
      ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
      : path.join(temp, 'system utilities');
  if (process.platform !== 'win32') {
    fs.mkdirSync(minimalPath);
    for (const name of ['uname', 'dirname'])
      fs.symlinkSync('/usr/bin/' + name, path.join(minimalPath, name));
  }
  const env = {
    ...process.env,
    PATH: minimalPath,
    Path: minimalPath,
    CLAUDE_PLUGIN_ROOT: plugin,
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PROJECT_DIR: project,
    NEXO_PROJECT_ROOT: project,
    NEXO_WORKSPACE: project,
    NEXO_NODE_PATH: '',
    NODE_OPTIONS: '--require=' + path.join(temp, 'global-options-must-not-run.cjs'),
  };
  fs.writeFileSync(
    path.join(temp, 'global-options-must-not-run.cjs'),
    `require('node:fs').writeFileSync(${JSON.stringify(path.join(temp, 'injected-options-ran'))}, 'bad');`,
  );
  const launcher = path.join(plugin, 'bootstrap/nexo');
  const command = (args, customEnv = env) =>
    spawnSync(launcher, ['--data', data, ...args], {
      cwd: project,
      env: customEnv,
      windowsHide: true,
      encoding: 'utf8',
      timeout: 100000,
      maxBuffer: 2 << 20,
    });
  return {
    temp,
    plugin,
    data,
    project,
    env,
    launcher,
    command,
    cleanup() {
      if (
        path.dirname(temp) !== fs.realpathSync.native(os.tmpdir()) ||
        !path.basename(temp).startsWith('nexo-runtime-test-')
      )
        throw new Error('Unsafe runtime test cleanup');
      fs.rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 });
    },
  };
}
export async function runtimeClient(f, env = f.env) {
  let stderr = '';
  const transport = new StdioClientTransport({
    command: f.launcher,
    args: ['--data', f.data, 'mcp'],
    cwd: f.project,
    env,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (c) => {
    stderr += c;
  });
  const client = new Client({ name: 'nexo-native-test', version: '1' });
  try {
    await client.connect(transport);
  } catch (e) {
    throw new Error(String(e) + '\n' + stderr);
  }
  return { client, errors: () => stderr };
}
export async function discover(client, timeout = 90000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const list = await client.listTools();
    if (list.tools.some((t) => t.name === 'claim')) return list;
    const status = await client.callTool({ name: 'runtime_status', arguments: {} });
    const state = JSON.parse(status.content[0].text);
    if (state.status === 'error') throw new Error(state.error);
    if (Date.now() >= deadline) throw new Error('Native runtime tools did not become available');
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('native plugin starts without Node on PATH and reuses a verified offline runtime', async () => {
  const f = isolatedRuntimeFixture();
  let connection;
  try {
    assert.ok(
      spawnSync('node', ['--version'], { env: f.env, windowsHide: true }).error,
      'fixture PATH unexpectedly contains Node',
    );
    // Trust a fixture manifest and preseed it with the exact test-runner binary.
    // This tests offline bootstrap behavior without requiring network in core tests.
    const plugin = path.join(f.temp, 'plugin with spaces');
    fs.mkdirSync(path.join(plugin, 'bootstrap'), { recursive: true });
    fs.cpSync(path.join(f.plugin, 'runtime'), path.join(plugin, 'runtime'), { recursive: true });
    const manifest = JSON.parse(
      fs.readFileSync(path.join(f.plugin, 'bootstrap/runtime-manifest.json')),
    );
    const status = f.command(['runtime-status']);
    assert.equal(status.status, 0, status.stderr);
    const platform = JSON.parse(status.stdout).platform;
    const nodeBytes = fs.readFileSync(process.execPath);
    const hash = crypto.createHash('sha256').update(nodeBytes).digest('hex');
    manifest.artifacts[platform].binarySha256 = hash;
    manifest.artifacts[platform].binarySize = nodeBytes.length;
    fs.writeFileSync(
      path.join(plugin, 'bootstrap/runtime-manifest.json'),
      JSON.stringify(manifest),
    );
    const generation = path.join(
      f.data,
      'runtimes',
      `node-${manifest.version}-${platform}-${hash.slice(0, 16)}-offline-fixture`,
    );
    fs.mkdirSync(generation, { recursive: true });
    const privateNode = path.join(generation, process.platform === 'win32' ? 'node.exe' : 'node');
    fs.copyFileSync(process.execPath, privateNode);
    fs.chmodSync(privateNode, 0o700);
    fs.writeFileSync(
      path.join(generation, 'LICENSE'),
      'Developer test-runner binary fixture. See the original Node distribution license.',
    );
    const env = {
      ...f.env,
      CLAUDE_PLUGIN_ROOT: plugin,
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1',
    };
    connection = await runtimeClient(f, env);
    const tools = await discover(connection.client, 15000);
    assert.ok(tools.tools.some((t) => t.name === 'runtime_status'));
    const state = JSON.parse(
      (await connection.client.callTool({ name: 'runtime_status', arguments: {} })).content[0].text,
    );
    assert.equal(state.status, 'ready');
    assert.equal(state.path, privateNode);
    const invalid = await connection.client.callTool({
      name: 'command',
      arguments: { op: 'remove-everything' },
    });
    assert.equal(invalid.isError, true);
    assert.equal(
      fs.existsSync(path.join(f.temp, 'injected-options-ran')),
      false,
      'global NODE_OPTIONS leaked into the private runtime',
    );
    await connection.client.close();
    connection = undefined;
    const result = f.command(['setup'], env);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).path, privateNode);
  } finally {
    await connection?.client.close();
    f.cleanup();
  }
});

test('uninitialized-project hooks do not need Node or an installed runtime', () => {
  const f = isolatedRuntimeFixture();
  try {
    const result = spawnSync(f.launcher, ['--data', f.data, 'hook'], {
      env: f.env,
      cwd: f.project,
      input: JSON.stringify({ cwd: f.project, hook_event_name: 'PreToolUse', tool_name: 'Write' }),
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '');
    assert.equal(fs.existsSync(path.join(f.data, 'runtimes')), false);
    const manifest = JSON.parse(fs.readFileSync(path.join(f.plugin, '.claude-plugin/plugin.json')));
    assert.equal(
      manifest.userConfig?.node_path,
      undefined,
      'installation still asks for a Node path',
    );
  } finally {
    f.cleanup();
  }
});
