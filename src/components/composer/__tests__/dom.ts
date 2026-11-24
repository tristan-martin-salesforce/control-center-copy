/**
 * Minimal React DOM test harness (react-dom/client + act) so component tests need no extra dependency.
 * Use from files marked `// @vitest-environment jsdom`.
 */
import * as React from 'react';
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// vitest.config has no JSX setting, so esbuild emits classic `React.createElement` for .tsx: provide it.
(globalThis as { React?: typeof React }).React = React;

export interface Rendered {
  container: HTMLElement;
  root: Root;
  unmount: () => Promise<void>;
}

const mounted: Rendered[] = [];

export async function render(el: ReactElement): Promise<Rendered> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(el));
  const r: Rendered = {
    container,
    root,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
  mounted.push(r);
  return r;
}

export async function cleanup(): Promise<void> {
  while (mounted.length) await mounted.pop()!.unmount();
  document.body.innerHTML = '';
}

const POLL_MS = 20;

/**
 * Poll (inside act) until fn returns a truthy value. The budget is a number of polls (`timeoutMs / 20`), never a
 * wall-clock deadline: each poll yields to the event loop for at least 20 ms, so a loaded machine gets more wall time
 * instead of a flake. Under `vi.useFakeTimers()` each poll advances the fake clock by 20 ms instead of sleeping.
 */
export async function waitFor<T>(fn: () => T | null | undefined | false, timeoutMs = 4000): Promise<T> {
  const polls = Math.max(1, Math.ceil(timeoutMs / POLL_MS));
  let lastErr: unknown;
  for (let i = 0; ; i++) {
    try {
      const v = fn();
      if (v) return v;
    } catch (e) {
      lastErr = e;
    }
    if (i >= polls) break;
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(POLL_MS);
      else await new Promise((r) => setTimeout(r, POLL_MS));
    });
  }
  throw lastErr ?? new Error('waitFor: timed out');
}

/** Advance fake timers by `ms` inside act (the file called `vi.useFakeTimers()`), so timer-driven renders flush. */
export async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('click: no element');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

export const $ = (sel: string, root: ParentNode = document) => root.querySelector<HTMLElement>(sel);
export const $$ = (sel: string, root: ParentNode = document) => [...root.querySelectorAll<HTMLElement>(sel)];
