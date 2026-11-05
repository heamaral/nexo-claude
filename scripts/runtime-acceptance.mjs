// Opt-in network trial. All project state and runtime files are isolated fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import os from 'node:os';

const temp = fs.realpathSync.native(
  fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-runtime-acceptance-')),
);
const plugin = path.resolve('plugins/nexo'),
  data = path.join(temp, 'runtime cache'),
  project = path.join(temp, 'project with spaces');
fs.mkdirSync(project);
const utilities =
  process.platform === 'win32'
    ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')
    : path.join(temp, 'system utilities');
if (process.platform !== 'win32') {
  fs.mkdirSync(utilities);
  for (const name of ['uname', 'dirname'])
    fs.symlinkSync('/usr/bin/' + name, path.join(utilities, name));
}
const env = {
  ...process.env,
  PATH: utilities,
  Path: utilities,
  CLAUDE_PLUGIN_ROOT: plugin,
  CLAUDE_PLUGIN_DATA: data,
  CLAUDE_PROJECT_DIR: project,
  NEXO_PROJECT_ROOT: project,
  NEXO_WORKSPACE: project,
  NEXO_NODE_PATH: '',
};
const launcher = path.join(plugin, 'bootstrap/nexo');
let client, lease;
async function connect(custom = env) {
  const c = new Client({ name: 'nexo-clean-path-acceptance', version: '1' });
  const transport = new StdioClientTransport({
    command: launcher,
    args: ['--data', data, 'mcp'],
    cwd: project,
    env: custom,
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (c) => process.stderr.write(c));
  await c.connect(transport);
  return c;
}
async function tools(c) {
  const deadline = Date.now() + 95000;
  for (;;) {
    const list = await c.listTools();
    if (list.tools.some((t) => t.name === 'claim')) return;
    const state = JSON.parse(
      (await c.callTool({ name: 'runtime_status', arguments: {} })).content[0].text,
    );
    if (state.status === 'error') throw new Error(state.error);
    if (Date.now() > deadline) throw new Error('Setup timed out');
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}
try {
  assert.ok(
    spawnSync('node', ['--version'], { env, windowsHide: true }).error,
    'Node unexpectedly exists on the fixture PATH',
  );
  const began = Date.now();
  client = await connect();
  const connectedMs = Date.now() - began;
  assert.ok(connectedMs < 5000, 'Cold runtime preparation blocked MCP initialization');
  await tools(client);
  const runtime = await call('runtime_status');
  assert.equal(runtime.status, 'ready');
  assert.ok(runtime.path.startsWith(data + path.sep));
  await call('init', { directoryMode: 'directory', name: 'Managed runtime acceptance' });
  await call('command', {
    commandId: crypto.randomUUID(),
    actor: 'acceptance',
    kind: 'delivery',
    id: 'delivery',
    op: 'create',
    expectedVersion: 0,
    data: { title: 'Managed runtime delivery' },
  });
  await call('command', {
    commandId: crypto.randomUUID(),
    actor: 'acceptance',
    kind: 'task',
    id: 'task',
    op: 'create',
    expectedVersion: 0,
    data: { deliveryId: 'delivery', title: 'Keep lease across MCP restart' },
  });
  lease = await call('claim', {
    taskId: 'task',
    agentId: 'managed-agent',
    sessionId: 'managed-session',
    name: 'Managed agent',
    scopes: ['src'],
    ttlSeconds: 600,
  });
  await client.close();
  client = undefined;
  client = await connect({
    ...env,
    HTTPS_PROXY: 'http://127.0.0.1:1',
    HTTP_PROXY: 'http://127.0.0.1:1',
  });
  await tools(client);
  await call('heartbeat', { token: lease.token, activity: 'Verified after offline MCP restart' });
  await call('release', { token: lease.token });
  lease = undefined;
  const state = await call('state');
  assert.ok(state.entities.some((e) => e.id === 'task'));
  await call('snapshot');
  // Exercise the actual native Claude launcher with the same restricted PATH.
  // Preseed its isolated inline-plugin cache with the verified production runtime.
  const profile = path.join(temp, 'isolated Claude profile');
  const inlineData = path.join(profile, 'plugins/data/nexo-inline');
  fs.mkdirSync(inlineData, { recursive: true });
  fs.cpSync(path.join(data, 'runtimes'), path.join(inlineData, 'runtimes'), { recursive: true });
  // The pinned package uses this filename on Unix too; its postinstall places
  // the platform-native executable over the same cross-platform placeholder.
  const claude = path.resolve('node_modules/@anthropic-ai/claude-code/bin/claude.exe');
  const claudeEnv = { ...env };
  delete claudeEnv.CLAUDE_PLUGIN_DATA;
  const health = spawnSync(claude, ['--plugin-dir', plugin, 'mcp', 'list'], {
    env: {
      ...claudeEnv,
      CLAUDE_CONFIG_DIR: profile,
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1',
    },
    cwd: project,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  assert.equal(health.status, 0, String(health.error ?? health.stderr));
  assert.match(health.stdout, /plugin:nexo:nexo:[\s\S]*Connected/, health.stdout);
  assert.ok(
    fs.existsSync(path.join(inlineData, 'launchers')),
    'Claude did not export its plugin data directory',
  );
  console.log(
    JSON.stringify({
      globalNodeOnPath: false,
      manualNodeConfiguration: false,
      coldMcpConnectedMs: connectedMs,
      managedNode: runtime.version,
      platform: runtime.platform,
      offlineReuse: true,
      originalLeaseAcceptedAfterRestart: true,
      nativeClaudeConnectedWithoutNode: true,
    }),
  );
} finally {
  if (client && lease) {
    try {
      await call('release', { token: lease.token });
    } catch {}
  }
  await client?.close();
  if (fs.existsSync(path.join(project, '.nexo/local/server.json'))) {
    const stopped = spawnSync(launcher, ['--data', data, 'stop', '--project', project], {
      env,
      cwd: project,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    if (stopped.status !== 0) console.error(stopped.stderr);
    for (let i = 0; i < 100 && fs.existsSync(path.join(project, '.nexo/local/server.json')); i++)
      await new Promise((r) => setTimeout(r, 50));
  }
  if (
    path.dirname(temp) !== fs.realpathSync.native(os.tmpdir()) ||
    !path.basename(temp).startsWith('nexo-runtime-acceptance-')
  )
    throw new Error('Unsafe acceptance cleanup');
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 });
}
