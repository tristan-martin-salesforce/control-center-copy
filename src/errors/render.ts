/**
 * The one renderer (11 R5): Health rows, toasts, the Outbox failure text, doctor's lines and the feedback
 * Diagnostics block all turn a code into words here, so a failure reads the same on every surface. Pure and
 * browser-safe (it imports only the catalog).
 */
import { CATALOG, entryOf, isCatalogCode, type CatalogAction, type CatalogEntry } from './catalog';

export interface Rendered {
  code: string;
  /** False when the code is not in the catalog (it renders as BUG.UNKNOWN, with the stored code kept). */
  known: boolean;
  class: CatalogEntry['class'];
  severity: CatalogEntry['severity'];
  retry: CatalogEntry['retry'];
  title: string;
  text: string;
  nextStep: string;
  action: CatalogAction | null;
  /** README anchor ("troubleshooting-vdp"). */
  docs: string;
}

export interface RenderOptions {
  /** The source's label ("Slack", "Gmail"), put before a title that names no source. */
  source?: string | null;
}

export function render(code: string | null | undefined, o: RenderOptions = {}): Rendered {
  const known = isCatalogCode(code);
  const e = entryOf(code);
  return {
    code: known ? e.code : (code ?? e.code),
    known,
    class: e.class,
    severity: e.severity,
    retry: e.retry,
    title: o.source && !e.userTitle.toLowerCase().includes(o.source.toLowerCase()) ? `${o.source}: ${e.userTitle}` : e.userTitle,
    text: e.userText,
    nextStep: e.nextStep,
    action: e.action ?? null,
    docs: e.docsAnchor,
  };
}

/** "Claude Code isn't installed. Install Claude Code (…), then click Check again." */
export function renderLine(code: string | null | undefined, o: RenderOptions = {}): string {
  const r = render(code, o);
  return `${r.title}. ${r.nextStep}`;
}

/** Health's status phrase after the scope label ("needs re-auth", "needs the corporate network: turn on Zscaler, retrying"). */
export function reasonOf(code: string): string {
  const e = entryOf(code);
  return e.reason ?? e.userTitle.charAt(0).toLowerCase() + e.userTitle.slice(1);
}

/** A toast / inline error: title + one next step + the button (never the raw error text). */
export function renderToast(code: string | null | undefined, o: RenderOptions = {}): { title: string; body: string; action: CatalogAction | null; code: string } {
  const r = render(code, o);
  return { title: r.title, body: r.nextStep, action: r.action, code: r.code };
}

/** The doctor CLI's line for a failing check: "[DEP.CLAUDE.MISSING] Claude Code isn't installed". */
export function renderTag(code: string): string {
  return `[${code}] ${render(code).title}`;
}

export const allCodes = (): string[] => Object.keys(CATALOG);
