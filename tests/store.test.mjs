import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../plugins/nexo/runtime/store.mjs';
import { fixture, command, seed, claim } from './helpers.mjs';

test('versioned commands, idempotency, hierarchy and combined dependency cycles', () => {
  const f = fixture();
  try {
    seed(f.store);
    const c = {
      commandId: crypto.randomUUID(),
      actor: 'test',
      kind: 'task',
      op: 'update',
      id: 'tokens',
      expectedVersion: 1,
      data: { description: 'Updated' },
    };
    f.store.execute(c);
    assert.equal(f.store.execute(c).duplicate, true);
    assert.throws(() => f.store.execute({ ...c, data: { description: 'Other' } }), /commandId/);
    assert.throws(
      () => command(f.store, 'task', 'tokens', { dependencies: ['integrate'] }, 'update'),
      /Ciclo/,
    );
    command(f.store, 'task', 'child', {
      deliveryId: 'delivery',
      parentId: 'tokens',
      title: 'Token hashing',
    });
    assert.throws(
      () => command(f.store, 'task', 'child', { dependencies: ['tokens'] }, 'update'),
      /hierarquia/,
    );
    assert.equal(f.store.get('tokens').version, 2);
  } finally {
    f.close();
  }
});
test('claims serialize executors and overlapping scopes; fencing rejects stale completion', () => {
  const f = fixture();
  try {
    seed(f.store);
    const a = f.store.claim(claim());
    assert.equal(f.store.get('tokens').data.stageId, 'doing');
    assert.throws(
      () => f.store.claim(claim('tokens', { agentId: 'agent-b', scopes: ['other'] })),
      /executor/,
    );
    assert.throws(
      () =>
        f.store.claim(claim('form', { agentId: 'agent-b', teamId: 'frontend', scopes: ['src'] })),
      /Escopo/,
    );
    assert.throws(
      () =>
        f.store.claim(
          claim('integrate', { agentId: 'agent-c', teamId: undefined, scopes: ['integration'] }),
        ),
      /Dependências/,
    );
    f.store.db.prepare('UPDATE agents SET expires_at=0').run();
    assert.equal(f.store.agents()[0].state, 'lost_contact');
    assert.throws(() => f.store.heartbeat(a.token), /expirada/);
    const b = f.store.claim(claim('tokens', { agentId: 'agent-b' }));
    assert.ok(b.fence > a.fence);
    assert.throws(
      () =>
        command(
          f.store,
          'task',
          'tokens',
          { stageId: 'done', result: 'Done', evidence: [{ label: 'Tests', commit: 'abc1234' }] },
          'update',
          { leaseToken: a.token },
        ),
      /lease/i,
    );
    command(
      f.store,
      'task',
      'tokens',
      {
        stageId: 'done',
        result: 'Unit tests passed',
        evidence: [{ label: 'Unit tests', commit: 'abc1234' }],
      },
      'update',
      { leaseToken: b.token },
    );
    assert.equal(f.store.agents().filter((a) => a.state === 'working').length, 0);
    assert.equal(f.store.search('tokens')[0].id, 'tokens');
  } finally {
    f.close();
  }
});
test('evidence, parent progress and accepted delivery history are enforced', () => {
  const f = fixture();
  try {
    command(f.store, 'delivery', 'd', { title: 'Delivery' });
    command(f.store, 'task', 'parent', { deliveryId: 'd', title: 'Parent' });
    command(f.store, 'task', 'child', { deliveryId: 'd', parentId: 'parent', title: 'Child' });
    const finish = {
      stageId: 'done',
      result: 'Implemented',
      evidence: [{ label: 'Tests', commit: 'abc1234' }],
    };
    assert.throws(() => command(f.store, 'task', 'parent', finish, 'update'), /Subcards/);
    assert.throws(
      () => command(f.store, 'task', 'child', { stageId: 'done', result: 'Done' }, 'update'),
      /evidência/,
    );
    command(f.store, 'task', 'child', finish, 'update');
    command(f.store, 'task', 'parent', finish, 'update');
    command(f.store, 'delivery', 'd', { result: 'Delivered' }, 'accept');
    assert.throws(
      () => command(f.store, 'task', 'child', { title: 'Changed' }, 'update'),
      /imutável/,
    );
    assert.throws(
      () => command(f.store, 'delivery', 'd', { title: 'Other' }, 'update'),
      /imutável/,
    );
    command(f.store, 'delivery', 'next', { title: 'Next delivery', revisionOf: 'd' });
    assert.equal(f.store.get('d').data.title, 'Delivery');
  } finally {
    f.close();
  }
});
test('closed SQLite snapshot excludes leases, recovers from events, follows branch event removal', () => {
  const f = fixture();
  try {
    seed(f.store);
    const a = f.store.claim(claim());
    f.store.snapshot();
    const snapshot = new DatabaseSync(path.join(f.root, '.nexo/project.sqlite'), {
      readOnly: true,
    });
    assert.equal(snapshot.prepare('SELECT COUNT(*) n FROM agents').get().n, 0);
    assert.equal(snapshot.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    snapshot.close();
    assert.ok(
      !fs.readFileSync(path.join(f.root, '.nexo/project.sqlite')).includes(Buffer.from(a.token)),
    );
    const before = f.store.events().length;
    const event = f.store.events().find((e) => e.command.id === 'integrate');
    const removed = new Set([event.id]);
    let grow = true;
    while (grow) {
      grow = false;
      for (const e of f.store.events())
        if (!removed.has(e.id) && e.parents.some((p) => removed.has(p))) {
          removed.add(e.id);
          grow = true;
        }
    }
    for (const id of removed) fs.rmSync(path.join(f.root, '.nexo/events', id + '.json'));
    f.store.sync();
    assert.equal(f.store.get('integrate'), undefined);
    assert.equal(f.store.events().length, before - removed.size);
    assert.equal(f.store.agents().length, 0);
    f.store.close();
    fs.rmSync(path.join(f.root, '.nexo/local/state.sqlite'));
    const recovered = new Store(f.root);
    assert.ok(recovered.get('tokens'));
    assert.equal(recovered.get('integrate'), undefined);
    recovered.close();
  } finally {
    f.close();
  }
});
test('parallel branch changes create a deterministic explicit merge conflict', () => {
  const a = fixture(),
    b = fixture();
  try {
    command(a.store, 'delivery', 'd', { title: 'Original' });
    b.store.close();
    fs.copyFileSync(
      path.join(a.root, '.nexo/project.json'),
      path.join(b.root, '.nexo/project.json'),
    );
    for (const name of fs.readdirSync(path.join(a.root, '.nexo/events')))
      fs.copyFileSync(
        path.join(a.root, '.nexo/events', name),
        path.join(b.root, '.nexo/events', name),
      );
    const branch = new Store(b.root);
    command(a.store, 'delivery', 'd', { title: 'Branch A' }, 'update');
    command(branch, 'delivery', 'd', { title: 'Branch B' }, 'update');
    for (const name of fs.readdirSync(path.join(b.root, '.nexo/events')))
      fs.copyFileSync(
        path.join(b.root, '.nexo/events', name),
        path.join(a.root, '.nexo/events', name),
      );
    a.store.sync();
    assert.equal(a.store.conflicts().length, 1);
    const conflict = a.store.conflicts()[0].event_id;
    assert.throws(() => command(a.store, 'delivery', 'new', { title: 'Blocked' }), /divergentes/);
    a.store.resolve([conflict]);
    command(a.store, 'delivery', 'd', { title: 'Reconciled' }, 'update');
    assert.equal(a.store.get('d').data.title, 'Reconciled');
    branch.close();
  } finally {
    a.close();
    b.close();
  }
});
test('projects remain isolated and runtime actors never leak into cloned history', () => {
  const a = fixture(),
    b = fixture();
  try {
    seed(a.store);
    assert.equal(b.store.all().length, 0);
    const event = a.store.events()[0];
    fs.writeFileSync(path.join(b.root, '.nexo/events', event.id + '.json'), JSON.stringify(event));
    assert.throws(() => b.store.sync(), /Integridade/);
  } finally {
    a.close();
    b.close();
  }
});
