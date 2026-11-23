import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PausedTooLongError, RunControl, ScriptStoppedError } from "../src/daemon/control";

describe("RunControl", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stops the clock while paused", () => {
    const control = new RunControl();
    const start = control.now();
    vi.advanceTimersByTime(1000);
    control.pause();
    vi.advanceTimersByTime(5000);
    expect(control.now() - start).toBe(1000);
    control.resume();
    vi.advanceTimersByTime(500);
    expect(control.now() - start).toBe(1500);
  });

  it("holds timers while paused and fires them on active time", () => {
    const control = new RunControl();
    const fired = vi.fn();
    control.timer(1000, fired);
    vi.advanceTimersByTime(400);
    control.pause();
    vi.advanceTimersByTime(10000);
    expect(fired).not.toHaveBeenCalled();
    control.resume();
    vi.advanceTimersByTime(599);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledOnce();
  });

  it("lets a cancelled timer never fire", () => {
    const control = new RunControl();
    const fired = vi.fn();
    control.timer(100, fired)();
    vi.advanceTimersByTime(1000);
    expect(fired).not.toHaveBeenCalled();
  });

  it("gates until resumed and reports that it waited", async () => {
    const control = new RunControl();
    expect(await control.gate()).toBe(false);
    control.pause();
    let waited: boolean | null = null;
    const gate = control.gate().then((value) => { waited = value; });
    await Promise.resolve();
    expect(waited).toBeNull();
    control.resume();
    await gate;
    expect(waited).toBe(true);
  });

  it("gives up on a pause that runs past the limit and stops waiters from acting", async () => {
    const control = new RunControl(60000);
    const expired = vi.fn();
    control.onExpired(expired);
    control.pause();
    const gate = control.gate();
    vi.advanceTimersByTime(60000);
    await expect(gate).rejects.toBeInstanceOf(ScriptStoppedError);
    await expect(control.gate()).rejects.toBeInstanceOf(ScriptStoppedError);
    expect(expired.mock.calls[0][0]).toBeInstanceOf(PausedTooLongError);
    expect(control.pause()).toBe(false);
  });

  it("knows which tab paused", () => {
    const control = new RunControl();
    const tab = {};
    control.pause(tab);
    expect(control.pausedBy(tab)).toBe(true);
    expect(control.pausedBy({})).toBe(false);
    control.end();
    expect(control.paused).toBe(false);
  });
});
