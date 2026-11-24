/**
 * Wait for a condition, never for a fixed time. A test that sleeps 120 ms and then asserts races the code's own timers
 * on a loaded machine; `until` polls instead, and its budget is a number of polls (each yields to the event loop for
 * `everyMs`), never a wall-clock deadline, so a slow machine gets more time rather than a flake.
 * For code on timers you control, prefer `vi.useFakeTimers()` + `vi.advanceTimersByTimeAsync` (CONTRIBUTING ▸ Tests).
 * DOM tests have the same thing as `waitFor` in src/components/composer/__tests__/dom.ts.
 */
export async function until<T>(fn: () => T | Promise<T>, { polls = 250, everyMs = 20, what = 'condition' }: { polls?: number; everyMs?: number; what?: string } = {}): Promise<T> {
  let last: T | undefined;
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      lastErr = e;
    }
    if (i >= polls) break;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw lastErr ?? new Error(`until: ${what} not met after ${polls} polls (last value: ${String(last)})`);
}

/** `until` for an assertion: retries while it throws (what `vi.waitFor` does, without its 1 s wall-clock cap). */
export const eventually = (assertion: () => unknown, o?: { polls?: number; everyMs?: number }): Promise<true> =>
  until(async () => {
    await assertion();
    return true as const;
  }, o);
