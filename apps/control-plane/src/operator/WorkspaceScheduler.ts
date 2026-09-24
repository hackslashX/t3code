import * as Effect from "effect/Effect";

export interface WorkspaceKey {
  readonly namespace: string;
  readonly name: string;
}

export interface WorkspaceSchedulerOptions {
  readonly reconcile: (key: WorkspaceKey) => Promise<void>;
  readonly onError?: (key: WorkspaceKey, error: unknown, retryAttempt: number) => void;
  readonly retryDelayMilliseconds?: (attempt: number) => number;
}

interface Entry {
  pending: boolean;
  stopped: boolean;
  retryAttempt: number;
}

const keyString = (key: WorkspaceKey) => `${key.namespace}/${key.name}`;
const sleep = (milliseconds: number, signal: AbortSignal) =>
  Effect.runPromise(Effect.sleep(milliseconds), { signal });

export class WorkspaceScheduler {
  readonly #entries = new Map<string, Entry>();
  readonly #options: WorkspaceSchedulerOptions;
  #stopped = false;
  readonly #idleWaiters = new Set<() => void>();
  readonly #stopController = new AbortController();

  constructor(options: WorkspaceSchedulerOptions) {
    this.#options = options;
  }

  enqueue(key: WorkspaceKey): void {
    if (this.#stopped) return;
    const id = keyString(key);
    const existing = this.#entries.get(id);
    if (existing !== undefined) {
      existing.pending = true;
      return;
    }
    const entry: Entry = { pending: false, stopped: false, retryAttempt: 0 };
    this.#entries.set(id, entry);
    void this.#run(key, entry);
  }

  stop(): void {
    this.#stopped = true;
    this.#stopController.abort();
    for (const entry of this.#entries.values()) entry.stopped = true;
  }

  get activeCount(): number {
    return this.#entries.size;
  }

  whenIdle(): Promise<void> {
    if (this.#entries.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  async #run(key: WorkspaceKey, entry: Entry): Promise<void> {
    const id = keyString(key);
    while (!this.#stopped && !entry.stopped) {
      entry.pending = false;
      try {
        await this.#options.reconcile(key);
        entry.retryAttempt = 0;
      } catch (error) {
        entry.retryAttempt += 1;
        this.#options.onError?.(key, error, entry.retryAttempt);
        const delay =
          this.#options.retryDelayMilliseconds?.(entry.retryAttempt) ??
          Math.min(30_000, 250 * 2 ** Math.min(entry.retryAttempt - 1, 7));
        try {
          await sleep(delay, this.#stopController.signal);
        } catch {
          // Shutdown interrupts retry backoff.
        }
        entry.pending = !this.#stopped;
      }
      if (!entry.pending) break;
    }
    this.#entries.delete(id);
    if (this.#entries.size === 0) {
      for (const resolve of this.#idleWaiters) resolve();
      this.#idleWaiters.clear();
    }
  }
}
