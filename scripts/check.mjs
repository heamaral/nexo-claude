import { spawnSync } from 'node:child_process';
for (const args of [
  ['node_modules/typescript/bin/tsc', '--noEmit'],
  ['scripts/build.mjs'],
  ['--disable-warning=ExperimentalWarning', '--test', '--test-concurrency=1', 'tests/*.test.mjs'],
]) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
