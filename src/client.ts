import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { atomicWrite, findProject, localDir } from './project.js';
type Registry = {
  version: number;
  pid: number;
  instance: string;
  port: number;
  token: string;
  root: string;
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function ensureServer(root = findProject()): Promise<Registry> {
  root = fs.realpathSync.native(root);
  const dir = localDir(root),
    file = path.join(dir, 'server.json'),
    lock = path.join(dir, 'startup.lock');
  const existing = async () => {
    try {
      const r = JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
      if (
        r.root !== root ||
        !Number.isInteger(r.port) ||
        r.port < 1 ||
        r.port > 65535 ||
        r.version !== 1
      )
        return;
      const response = await fetch(`http://127.0.0.1:${r.port}/api/health`, {
        signal: AbortSignal.timeout(700),
      });
      const health = (await response.json()) as any;
      if (health.instance === r.instance) return r;
    } catch {}
  };
  const running = await existing();
  if (running) return running;
  try {
    fs.mkdirSync(lock);
  } catch {
    for (let attempt = 0; attempt < 40; attempt++) {
      const r = await existing();
      if (r) return r;
      await wait(250);
    }
    // Never kill a PID based only on a stale registry. A stale startup lock can be retried safely.
    if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 30_000) {
      fs.rmdirSync(lock);
      return ensureServer(root);
    }
    throw new Error('Serviço está iniciando. Tente novamente em alguns segundos.');
  }
  try {
    const r = await existing();
    if (r) return r;
    try {
      const previous = JSON.parse(fs.readFileSync(file, 'utf8')) as Registry;
      if (previous.root === root && Number.isInteger(previous.pid)) {
        let alive = false;
        try {
          process.kill(previous.pid, 0);
          alive = true;
        } catch (e) {
          alive = (e as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (alive)
          throw new Error(
            'O processo do board ainda existe, mas não responde. Consulte .nexo/local/server.log antes de reiniciá-lo; Nexo não inicia um segundo escritor.',
          );
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('O processo')) throw e;
    }
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
      if (value) return value;
      await wait(100);
    }
    throw new Error('O board não iniciou. Consulte .nexo/local/server.log e /nexo:doctor.');
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}
export async function request(route: string, body?: unknown, root?: string) {
  const r = await ensureServer(root);
  const response = await fetch(`http://127.0.0.1:${r.port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${r.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const result = (await response.json()) as any;
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
