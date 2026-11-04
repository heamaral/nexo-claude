import fs from 'node:fs';
import path from 'node:path';
import { localDir } from './project.js';
import { assert } from './model.js';

export type Registry = {
  version: number;
  pid: number;
  instance: string;
  port: number;
  token: string;
  root: string;
  runtimeVersion?: string;
  draining?: boolean;
  writerProtocol?: number;
};
export function readRegistry(root: string): Registry | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(localDir(root), 'server.json'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const r = JSON.parse(raw) as Registry;
  assert(
    r.root === root &&
      r.version === 1 &&
      Number.isInteger(r.pid) &&
      r.pid > 0 &&
      Number.isInteger(r.port) &&
      r.port > 0 &&
      r.port <= 65535 &&
      typeof r.instance === 'string' &&
      typeof r.token === 'string',
    'REGISTRY_INVALID',
    'Nexo registry identity is invalid; no second writer was started.',
    503,
  );
  return r;
}
export async function probeRegistry(r: Registry): Promise<Registry | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${r.port}/api/health`, {
      headers: { Connection: 'close' },
      signal: AbortSignal.timeout(1000),
    });
    const health = (await response.json()) as any;
    if (response.ok && health.instance === r.instance && typeof health.version === 'string')
      return { ...r, runtimeVersion: health.version, draining: health.draining === true };
  } catch {}
}
export function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
