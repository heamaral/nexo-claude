import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findProject, localDir } from './project.js';
import { VERSION, compareVersions } from './version.js';
import { acquireStartup, tryLock } from './locks.js';
import { Registry, readRegistry, probeRegistry, processAlive } from './registry.js';
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function ensureServer(root = findProject()): Promise<Registry> {
  root = fs.realpathSync.native(root);
  const dir = localDir(root),
    file = path.join(dir, 'server.json');
  const existing = async () => {
    const r = readRegistry(root);
    return r ? probeRegistry(r) : undefined;
  };
  const running = await existing();
  const reusable = (r: Registry | undefined) =>
    !!r?.runtimeVersion && !r.draining && compareVersions(r.runtimeVersion, VERSION) >= 0;
  if (reusable(running)) return running!;
  const releaseStartup = await acquireStartup(root);
  try {
    const r = await existing();
    if (reusable(r)) return r!;
    if (r) {
      // Authenticated graceful shutdown drains writes and preserves the live SQLite leases.
      // Never kill a PID or downgrade a newer runtime used by another session.
      const response = await fetch(`http://127.0.0.1:${r.port}/api/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${r.token}`, Connection: 'close' },
        body: '{}',
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new Error(
          'Nexo could not gracefully upgrade the board service. Retry after the current session completes.',
        );
      await response.text();
      for (let i = 0; i < 500; i++) {
        try {
          if (JSON.parse(fs.readFileSync(file, 'utf8')).instance !== r.instance) break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT') break;
          throw e;
        }
        await wait(50);
      }
      if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).instance === r.instance)
        throw new Error(
          'Nexo is still closing its previous board service. Retry shortly; no second writer was started.',
        );
    }
    const previous = readRegistry(root);
    if (previous?.writerProtocol === 2) {
      const release = tryLock(root, 'writer');
      if (!release)
        throw new Error(
          'The directory writer is still alive but not responding. Nexo will not start a second writer.',
        );
      release();
    } else if (previous && processAlive(previous.pid))
      throw new Error(
        'O processo do board ainda existe, mas não responde. Consulte .nexo/local/server.log; Nexo não inicia um segundo escritor.',
      );
    const log = fs.openSync(path.join(dir, 'server.log'), 'a');
    const child = spawn(
      process.execPath,
      [
        '--disable-warning=ExperimentalWarning',
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'cli.mjs'),
        'serve',
        '--project',
        root,
      ],
      { cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log] },
    );
    let spawnError: Error | undefined;
    child.on('error', (e) => {
      spawnError = e;
    });
    child.unref();
    fs.closeSync(log);
    for (let attempt = 0; attempt < 60; attempt++) {
      if (spawnError) throw spawnError;
      const value = await existing();
      if (reusable(value)) return value!;
      await wait(100);
    }
    throw new Error('O board não iniciou. Consulte .nexo/local/server.log e /nexo:doctor.');
  } finally {
    releaseStartup();
  }
}
export async function request(
  route: string,
  body?: unknown,
  root?: string,
  retried = false,
): Promise<any> {
  const r = await ensureServer(root);
  const response = await fetch(`http://127.0.0.1:${r.port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = (await response.json()) as any;
  // Only retry an explicit rejection before execution. A network failure after
  // acceptance is ambiguous, particularly for claims, and is never replayed here.
  if (!response.ok && result.error === 'SERVER_DRAINING' && !retried) {
    await wait(100);
    return request(route, body, root, true);
  }
  if (!response.ok) throw new Error(`${result.error}: ${result.message}`);
  return result;
}
export async function board(root?: string, open = true) {
  const { url } = await request('ticket', {}, root);
  if (open) {
    let child;
    // Explicit argv; no project content is evaluated by a shell.
    if (process.platform === 'win32')
      child = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], {
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      });
    else
      child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], {
        detached: true,
        stdio: 'ignore',
      });
    child.on('error', () => {});
    child.unref();
  }
  return { url, expiresInSeconds: 60 };
}
