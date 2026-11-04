import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { NexoError, assert } from './model.js';
import { localDir } from './project.js';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/** A persistent SQLite file supplies an OS-managed mutex. Never unlink this file:
 * deleting a locked inode would let another process acquire a different mutex.
 * No data transaction uses this connection; process exit releases the lock. */
export function tryLock(root: string, name: 'writer' | 'startup'): (() => void) | undefined {
  const file = path.join(localDir(root), name + '.sqlite');
  if (fs.existsSync(file))
    assert(!fs.lstatSync(file).isSymbolicLink(), 'UNSAFE_PATH', 'Lock cannot be a symlink');
  const db = new DatabaseSync(file, { timeout: 0 });
  try {
    db.exec('BEGIN IMMEDIATE');
  } catch (e) {
    db.close();
    const code = Number((e as any).errcode) & 0xff;
    if (code === 5 || code === 6) return;
    throw e;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      db.exec('ROLLBACK');
    } finally {
      db.close();
    }
  };
}

export function acquireWriter(root: string) {
  const release = tryLock(root, 'writer');
  if (!release)
    throw new NexoError(
      'WRITER_BUSY',
      'Another Nexo writer owns this directory. Use the registered service; a live owner is never replaced by a timeout.',
      503,
    );
  return release;
}

export async function acquireStartup(root: string) {
  const deadline = Date.now() + 30_000;
  let release: (() => void) | undefined;
  while (!(release = tryLock(root, 'startup'))) {
    if (Date.now() >= deadline)
      throw new NexoError(
        'STARTUP_BUSY',
        'Another client is starting or upgrading Nexo. No live lock was stolen.',
        503,
      );
    await delay(100);
  }
  // rc.1/rc.2 clients only understand this directory. Keep it during handoff,
  // while the OS mutex is authoritative for current clients.
  const dir = path.join(localDir(root), 'startup.lock');
  const file = path.join(dir, 'owner.json');
  const instance = crypto.randomUUID();
  let timer: NodeJS.Timeout | undefined;
  let owned = false;
  try {
    for (;;) {
      try {
        fs.mkdirSync(dir);
        owned = true;
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      assert(
        !fs.lstatSync(dir).isSymbolicLink(),
        'UNSAFE_PATH',
        'Startup guard cannot be a symlink',
      );
      try {
        const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
        // A previous current-version client has released/died: we hold its OS mutex.
        // Never reclaim an unidentified legacy owner solely because a clock expired.
        if (owner.protocol === 2 && owner.root === root) {
          fs.rmSync(file);
          fs.rmdirSync(dir);
          continue;
        }
      } catch (e) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
      }
      if (Date.now() >= deadline)
        throw new NexoError(
          'LEGACY_STARTUP_BUSY',
          'A legacy Nexo startup lock has no verified owner. Finish/reload that client; it was not removed by age.',
          503,
        );
      await delay(100);
    }
    fs.writeFileSync(file, JSON.stringify({ protocol: 2, root, instance, pid: process.pid }), {
      flag: 'wx',
      mode: 0o600,
    });
    timer = setInterval(() => {
      try {
        const now = new Date();
        fs.utimesSync(dir, now, now);
      } catch {}
    }, 5000);
    timer.unref();
    return () => {
      clearInterval(timer);
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).instance === instance) {
          fs.rmSync(file);
          fs.rmdirSync(dir);
        }
      } catch {}
      release!();
    };
  } catch (e) {
    if (owned) {
      try {
        fs.rmSync(file, { force: true });
        fs.rmdirSync(dir);
      } catch {}
    }
    release();
    throw e;
  }
}
