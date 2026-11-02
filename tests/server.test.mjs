import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer } from '../plugins/nexo/runtime/server.mjs';
import { fixture, command, seed, claim } from './helpers.mjs';
test('loopback auth, one-time browser login, read-only browser and real-time SSE', async () => {
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  try {
    const url = s.origin,
      headers = { Authorization: 'Bearer ' + s.registry.token, 'Content-Type': 'application/json' };
    assert.equal((await fetch(url + '/api/state')).status, 401);
    assert.equal(
      (await fetch(url + '/api/state', { headers: { ...headers, Origin: 'https://evil.example' } }))
        .status,
      403,
    );
    const hostStatus = await new Promise((resolve) =>
      http.get(url + '/api/health', { headers: { Host: 'evil.example' } }, (r) => {
        r.resume();
        resolve(r.statusCode);
      }),
    );
    assert.equal(hostStatus, 403);
    const ticket = await (
      await fetch(url + '/api/ticket', { method: 'POST', headers, body: '{}' })
    ).json();
    const body = JSON.stringify({
      ticket: new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('ticket'),
    });
    const auth = await fetch(url + '/api/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    const cookie = auth.headers.get('set-cookie').split(';')[0];
    assert.match(auth.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
    assert.equal((await fetch(url + '/api/bootstrap', { method: 'POST', body })).status, 401);
    assert.equal((await fetch(url + '/api/state', { headers: { Cookie: cookie } })).status, 200);
    assert.equal(
      (
        await fetch(url + '/api/command', {
          method: 'POST',
          headers: { Cookie: cookie },
          body: '{}',
        })
      ).status,
      403,
    );
    const controller = new AbortController();
    const stream = await fetch(url + '/api/events', { headers, signal: controller.signal });
    const reader = stream.body.getReader();
    await reader.read();
    command(s.store, 'delivery', 'live', { title: 'Live delivery' });
    const chunk = await reader.read();
    assert.match(new TextDecoder().decode(chunk.value), /event: change/);
    controller.abort();
    assert.equal((await fetch(url + '/')).status, 200);
    assert.match(
      (await fetch(url + '/app.js')).headers.get('content-security-policy'),
      /frame-ancestors 'none'/,
    );
    const huge = await fetch(url + '/api/command', {
      method: 'POST',
      headers,
      body: JSON.stringify({ data: 'x'.repeat(270000) }),
    });
    assert.equal(huge.status, 413);
  } finally {
    await s.close();
    f.close();
  }
});
test('concurrent HTTP claims have exactly one executor and hooks guard unassigned writers', async () => {
  const f = fixture();
  f.store.close();
  const s = await startServer(f.root, { registry: false });
  try {
    seed(s.store);
    const headers = {
        Authorization: 'Bearer ' + s.registry.token,
        'Content-Type': 'application/json',
      },
      post = (route, body) =>
        fetch(s.origin + '/api/' + route, { method: 'POST', headers, body: JSON.stringify(body) });
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        post('claim', claim('tokens', { agentId: 'agent-' + i, scopes: ['scope-' + i] })),
      ),
    );
    assert.equal(responses.filter((r) => r.ok).length, 1);
    const denied = await post('hook', {
      sessionId: 's',
      agentId: 'unknown',
      event: 'PreToolUse',
      toolName: 'Write',
    });
    assert.equal(denied.status, 409);
    const a = s.store.agents().find((a) => a.state === 'working');
    assert.ok(a);
    await post('hook', { sessionId: a.sessionId, agentId: a.agentId, event: 'SubagentStop' });
    assert.equal(s.store.agents().length, 0);
    assert.notEqual(s.store.get('tokens').data.stageId, 'done');
  } finally {
    await s.close();
    f.close();
  }
});
test('multiple project cookies coexist on 127.0.0.1 across different ports', async () => {
  const a = fixture(),
    b = fixture();
  a.store.close();
  b.store.close();
  const x = await startServer(a.root, { registry: false }),
    y = await startServer(b.root, { registry: false });
  try {
    const cookies = [];
    for (const s of [x, y]) {
      const ticket = await (
        await fetch(s.origin + '/api/ticket', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + s.registry.token },
          body: '{}',
        })
      ).json();
      const r = await fetch(s.origin + '/api/bootstrap', {
        method: 'POST',
        body: JSON.stringify({
          ticket: new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('ticket'),
        }),
      });
      cookies.push(r.headers.get('set-cookie').split(';')[0]);
    }
    assert.notEqual(cookies[0].split('=')[0], cookies[1].split('=')[0]);
    for (const s of [x, y]) {
      const r = await fetch(s.origin + '/api/state', { headers: { Cookie: cookies.join('; ') } });
      assert.equal(r.status, 200);
      assert.equal((await r.json()).project.id, s.store.config.id);
    }
  } finally {
    await x.close();
    await y.close();
    a.close();
    b.close();
  }
});
