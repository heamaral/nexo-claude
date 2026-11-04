import fs from 'node:fs';
import { NexoError } from './model.js';
import { replaceFile } from './files.js';

export type SnapshotState = {
  status: 'pending' | 'publishing' | 'retrying' | 'ready' | 'error';
  dirty: boolean;
  generation: number;
  publishedGeneration: number;
  attempts: number;
  publications: number;
  lastSuccessAt: string | null;
  lastError: { code: string; message: string; operation: string; at: string } | null;
};

/** One publication per directory owner. Callers join the in-flight publication,
 * then flush through the durable generation visible when they called flush(). */
export class Snapshots {
  private generation = 0;
  private publishedGeneration = -1;
  private job?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private dirtySince = Date.now();
  private automatic = false;
  private failures = 0;
  private stopped = false;
  private artifactStamp = '';
  private info: SnapshotState = {
    status: 'pending',
    dirty: true,
    generation: 0,
    publishedGeneration: -1,
    attempts: 0,
    publications: 0,
    lastSuccessAt: null,
    lastError: null,
  };
  onChange = () => {};
  constructor(
    private target: string,
    private stage: () => string,
  ) {}
  state(): SnapshotState {
    return {
      ...this.info,
      generation: this.generation,
      publishedGeneration: this.publishedGeneration,
      dirty: this.publishedGeneration < this.generation,
    };
  }
  get busy() {
    return !!this.job;
  }
  start() {
    this.automatic = true;
    this.schedule(0);
  }
  pause() {
    this.automatic = false;
    clearTimeout(this.timer);
  }
  private stamp() {
    try {
      const s = fs.lstatSync(this.target);
      return s.isFile() ? [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(':') : '';
    } catch {
      return '';
    }
  }
  verify() {
    if (!this.job && this.publishedGeneration >= 0 && this.stamp() !== this.artifactStamp) {
      // Git may replace/remove only the derived binary without changing events.
      this.publishedGeneration = -1;
      this.info.status = 'pending';
      this.schedule(0);
      this.onChange();
    }
  }
  markDirty() {
    if (this.publishedGeneration === this.generation) this.dirtySince = Date.now();
    this.generation++;
    if (!this.job && !this.info.lastError) this.info.status = 'pending';
    if (this.failures) return; // New cards do not defeat the publication failure backoff.
    this.schedule(Math.min(500, Math.max(0, 5000 - (Date.now() - this.dirtySince))));
  }
  private schedule(ms: number) {
    if (!this.automatic || this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush().catch(() => {});
    }, ms);
    this.timer.unref();
  }
  async flush(requested = this.generation): Promise<void> {
    if (this.stopped) throw new Error('Snapshot publisher is closed');
    this.verify();
    if (this.publishedGeneration >= requested && !this.job) return;
    clearTimeout(this.timer);
    if (!this.job) {
      const captured = this.generation;
      this.job = this.publish(captured).finally(() => {
        this.job = undefined;
        if (this.publishedGeneration < this.generation)
          this.schedule(
            this.failures ? Math.min(30_000, 1000 * 2 ** Math.min(this.failures - 1, 5)) : 0,
          );
      });
    }
    await this.job;
    if (this.publishedGeneration < requested) await this.flush(requested);
  }
  private async publish(captured: number) {
    let temp: string | undefined;
    this.info.status = 'publishing';
    this.info.attempts = 0;
    this.onChange();
    try {
      temp = this.stage();
      this.info.attempts = await replaceFile(temp, this.target, (code, attempt) => {
        this.info.status = 'retrying';
        this.info.attempts = attempt;
        this.info.lastError = {
          code,
          message: 'Snapshot replacement is waiting for a file handle to be released.',
          operation: 'replace',
          at: new Date().toISOString(),
        };
        this.onChange();
      });
      this.artifactStamp = this.stamp();
      this.publishedGeneration = captured;
      this.info.status = this.generation === captured ? 'ready' : 'pending';
      this.info.lastSuccessAt = new Date().toISOString();
      this.info.lastError = null;
      this.info.publications++;
      this.failures = 0;
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      this.failures++;
      this.info.status = 'error';
      this.info.lastError = {
        code: err.code ?? 'SNAPSHOT_FAILED',
        message: err.message,
        operation: temp ? 'replace' : 'stage',
        at: new Date().toISOString(),
      };
      const recovery = ['EPERM', 'EACCES', 'EBUSY'].includes(this.info.lastError.code)
        ? 'Close readers of .nexo/project.sqlite, check file permissions and retry before committing it.'
        : 'Inspect snapshot.lastError and filesystem health, then retry before committing it.';
      throw new NexoError(
        'SNAPSHOT_PENDING',
        'The live database and event outbox are preserved. Snapshot publication failed (' +
          this.info.lastError.code +
          '). ' +
          recovery,
        503,
      );
    } finally {
      if (temp) {
        // This is our unpublished generation, never the last known-good destination.
        try {
          await fs.promises.rm(temp, { force: true });
        } catch {
          /* A scanner can also delay cleanup. */
        }
      }
      this.onChange();
    }
  }
  /** Called only after in-flight publication has settled, while ownership is held. */
  stop() {
    if (this.job) throw new Error('Wait for the snapshot publisher before closing its owner');
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
