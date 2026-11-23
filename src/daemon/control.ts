export const MAX_PAUSE_MS = 15 * 60 * 1000;

export class PausedTooLongError extends Error {
  constructor(limitMs: number) {
    super(`The script was paused for more than ${Math.round(limitMs / 60000)} minutes, so apart stopped it`);
    this.name = "PausedTooLongError";
  }
}

type Listener = (paused: boolean) => void;

export class RunControl {
  private pausedAt: number | null = null;
  private pauser: unknown = null;
  private pausedTotal = 0;
  private ended = false;
  private expiry: NodeJS.Timeout | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly expiredListeners = new Set<(error: Error) => void>();

  constructor(private readonly maxPauseMs = MAX_PAUSE_MS) {}

  get paused(): boolean {
    return this.pausedAt !== null;
  }

  now(): number {
    const current = Date.now();
    return current - this.pausedTotal - (this.pausedAt === null ? 0 : current - this.pausedAt);
  }

  pausedBy(owner: unknown): boolean {
    return this.pausedAt !== null && this.pauser === owner;
  }

  pause(owner: unknown = null): boolean {
    if (this.ended || this.pausedAt !== null) return false;
    this.pausedAt = Date.now();
    this.pauser = owner;
    this.expiry = setTimeout(() => {
      const error = new PausedTooLongError(this.maxPauseMs);
      this.end();
      for (const listener of this.expiredListeners) listener(error);
    }, this.maxPauseMs);
    this.emit();
    return true;
  }

  resume(): boolean {
    if (this.pausedAt === null) return false;
    this.pausedTotal += Date.now() - this.pausedAt;
    this.pausedAt = null;
    this.pauser = null;
    if (this.expiry) clearTimeout(this.expiry);
    this.expiry = null;
    this.emit();
    return true;
  }

  end(): void {
    this.resume();
    this.ended = true;
  }

  onChange(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onExpired(listener: (error: Error) => void): () => void {
    this.expiredListeners.add(listener);
    return () => this.expiredListeners.delete(listener);
  }

  async gate(): Promise<boolean> {
    if (this.pausedAt === null) return false;
    await new Promise<void>((resolve) => {
      const off = this.onChange((paused) => {
        if (paused) return;
        off();
        resolve();
      });
    });
    return true;
  }

  timer(ms: number, fire: () => void): () => void {
    const deadline = this.now() + ms;
    let handle: NodeJS.Timeout | null = null;
    let offChange: (() => void) | null = null;
    let cancelled = false;
    const schedule = () => {
      if (cancelled) return;
      if (this.paused) {
        offChange = this.onChange((paused) => {
          if (paused) return;
          offChange?.();
          offChange = null;
          schedule();
        });
        return;
      }
      const remaining = deadline - this.now();
      if (remaining <= 0) {
        fire();
        return;
      }
      handle = setTimeout(schedule, remaining);
    };
    schedule();
    return () => {
      cancelled = true;
      if (handle) clearTimeout(handle);
      offChange?.();
    };
  }

  private emit(): void {
    const paused = this.paused;
    for (const listener of Array.from(this.listeners)) listener(paused);
  }
}
