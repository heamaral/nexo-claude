import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fixture } from './helpers.mjs';
test('bundled MCP speaks official protocol and validates tool input', async () => {
  const f = fixture();
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--disable-warning=ExperimentalWarning', path.resolve('plugins/nexo/runtime/mcp.mjs')],
    cwd: f.root,
    env: { ...process.env, CLAUDE_PROJECT_DIR: f.root },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'nexo-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((t) => t.name === 'board_open'));
    assert.ok(tools.tools.some((t) => t.name === 'claim'));
    const invalid = await client.callTool({
      name: 'command',
      arguments: { op: 'remove-everything' },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    f.close();
  }
});
