import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export function syncDirectory(dir: string) {
  // Windows does not expose a portable directory fsync through node:fs.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Retry only sharing/permission contention, with a deadline and asynchronous waits.
 * Never delete the destination or copy over it: readers retain the last complete file. */
export async function replaceFile(
  source: string,
  target: string,
  onRetry: (code: string, attempt: number) => void,
  timeoutMs = 3000,
) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt++;
    try {
      await fs.promises.rename(source, target);
      syncDirectory(path.dirname(target));
      return attempt;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(code) || Date.now() >= deadline) throw e;
      onRetry(code, attempt);
      await delay(
        Math.min(deadline - Date.now(), 40 * 2 ** Math.min(attempt, 3) + Math.random() * 40),
      );
    }
  }
}
