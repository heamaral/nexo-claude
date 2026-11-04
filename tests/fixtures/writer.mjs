import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../plugins/nexo/runtime/store.mjs';
const root = process.argv[2];
if (process.argv[3] === 'startup') {
  const mutex = new DatabaseSync(path.join(root, '.nexo/local/startup.sqlite'));
  mutex.exec('BEGIN IMMEDIATE');
  const dir = path.join(root, '.nexo/local/startup.lock');
  fs.mkdirSync(dir);
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({ protocol: 2, root, pid: process.pid, instance: crypto.randomUUID() }),
  );
  fs.utimesSync(dir, new Date(0), new Date(0));
  process.send({ ready: true });
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}
const store = new Store(root);
if (process.argv[3] === 'outbox') {
  const rename = fs.renameSync;
  fs.renameSync = (from, to) => {
    if (to.includes('events'))
      throw Object.assign(new Error('Injected export sharing violation'), { code: 'EPERM' });
    return rename(from, to);
  };
  try {
    store.execute({
      commandId: crypto.randomUUID(),
      actor: 'crash-fixture',
      kind: 'delivery',
      id: 'outbox',
      op: 'create',
      expectedVersion: 0,
      data: { title: 'Committed before crash' },
    });
  } catch {}
  fs.renameSync = rename;
}
process.send({ ready: true });
process.on('message', () => {
  store.close();
  process.exit(0);
});
setInterval(() => {}, 1000);
