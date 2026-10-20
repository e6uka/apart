import fs from "node:fs/promises";
import { mergeRuns, RUN_HISTORY_LIMIT, type RunRecord } from "../shared/protocol";

export class RunHistory {
  private runs: RunRecord[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string, private readonly limit = RUN_HISTORY_LIMIT) {}

  list(): Promise<RunRecord[]> {
    return this.enqueue(async () => [...(await this.load())]);
  }

  add(run: RunRecord): Promise<void> {
    return this.enqueue(async () => {
      this.runs = mergeRuns(await this.load(), [run], 0, this.limit);
      await this.save();
    });
  }

  clearBefore(at: number): Promise<void> {
    return this.enqueue(async () => {
      const runs = await this.load();
      const kept = runs.filter((run) => run.startedAt >= at);
      if (kept.length === runs.length) return;
      this.runs = kept;
      await this.save();
    });
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task, task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async load(): Promise<RunRecord[]> {
    if (this.runs) return this.runs;
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, "utf8")) as unknown;
      this.runs = Array.isArray(parsed) ? mergeRuns([], parsed as RunRecord[], 0, this.limit) : [];
    } catch {
      this.runs = [];
    }
    return this.runs;
  }

  private async save(): Promise<void> {
    const temp = `${this.file}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(this.runs ?? []), { mode: 0o600 });
    await fs.rename(temp, this.file);
  }
}
