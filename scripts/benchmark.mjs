import { performance } from 'node:perf_hooks';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { initialize } from '../plugins/nexo/runtime/project.mjs';
import { Store } from '../plugins/nexo/runtime/store.mjs';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-benchmark-')),
  count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 100000) throw new Error('Invalid count');
initialize(root, 'Benchmark');
let store = new Store(root);
const write = (kind, id, data) =>
  store.execute({
    commandId: crypto.randomUUID(),
    actor: 'benchmark',
    op: 'create',
    kind,
    id,
    expectedVersion: 0,
    data,
  });
try {
  write('delivery', 'bench', { title: 'Benchmark' });
  let at = performance.now();
  for (let i = 0; i < count; i++)
    write('task', 'task-' + i, {
      deliveryId: 'bench',
      title: 'Task ' + i,
      description: 'Searchable benchmark task',
      dependencies: i ? ['task-' + (i - 1)] : [],
    });
  const createMs = performance.now() - at;
  at = performance.now();
  store.snapshot();
  const snapshotMs = performance.now() - at;
  at = performance.now();
  const state = store.state();
  const stateMs = performance.now() - at;
  at = performance.now();
  store.search('searchable');
  const searchMs = performance.now() - at;
  store.close();
  fs.rmSync(path.join(root, '.nexo/local/state.sqlite'));
  at = performance.now();
  store = new Store(root);
  const replayMs = performance.now() - at;
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        tasks: count,
        events: state.eventCount,
        createMs,
        snapshotMs,
        stateMs,
        searchMs,
        replayMs,
        snapshotBytes: fs.statSync(path.join(root, '.nexo/project.sqlite')).size,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  if (path.basename(root).startsWith('nexo-benchmark-'))
    fs.rmSync(root, { recursive: true, force: true });
}
