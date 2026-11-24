/**
 * Health ▸ Setup on the client (11 R6/R7, 01 R7): one dependency row → what the user reads and which buttons it has.
 * Pure and browser-safe: every problem and next step comes from the error catalog's one renderer (src/errors/render.ts),
 * so a broken Slack reads the same on the Setup row, the Health "needs you" block, a toast and Getting started.
 *
 * State machine per dependency: missing → installed → signed_out → expired → ok, plus offline (network) and unknown
 * (the probe failed). offline and unknown never read as broken: "Can't tell right now; retrying", no red, no count.
 */
import type { CatalogAction, Connector, DependencyState, HealthPayload, SetupDependency } from '@/contract';
import { codeFromStatusReason, toCatalogCode } from '@/errors/aliases';
import { isCatalogCode } from '@/errors/catalog';
import { render } from '@/errors/render';

/** What the user-initiated Claude check costs (src/ops/smoke.ts SMOKE_ESTIMATE_USD; a test pins them equal). */
export const SMOKE_ESTIMATE_USD = 0.001;

export type SetupTone = 'ok' | 'danger' | 'warning' | 'neutral';

/** The state chip: words and tone. Only the states that need the user are red or amber. */
export const STATE_CHIP: Readonly<Record<DependencyState, { label: string; tone: SetupTone }>> = {
  ok: { label: 'Ready', tone: 'ok' },
  missing: { label: 'Not installed', tone: 'danger' },
  installed: { label: 'Needs setup', tone: 'warning' },
  signed_out: { label: 'Signed out', tone: 'danger' },
  expired: { label: 'Expired', tone: 'danger' },
  offline: { label: 'Offline', tone: 'neutral' },
  unknown: { label: "Can't tell yet", tone: 'neutral' },
};

/** States the user has to act on (they count on the badge). offline and unknown are the app's to retry. */
export const NEEDS_YOU_STATES: ReadonlySet<DependencyState> = new Set(['missing', 'installed', 'signed_out', 'expired']);
export const needsAction = (s: DependencyState): boolean => NEEDS_YOU_STATES.has(s);

/** The status phrase for the two states that are never "broken". */
export const UNSURE_TEXT: Readonly<Record<'offline' | 'unknown', string>> = {
  offline: "Can't reach it right now; Command Center retries by itself.",
  unknown: "Can't tell right now; retrying.",
};

// ------------------------------------------------------------------ anchors (one link target per dependency)

export const setupAnchor = (depId: string): string => `setup-${depId}`;
/** The Setup row for a dependency: Health ▸ Setup, scrolled to it. */
export const setupHref = (depId: string): string => `/health?tab=setup#${setupAnchor(depId)}`;
/** "#setup-slack-mcp" → "slack-mcp"; null for any other hash. */
export const depIdFromHash = (hash: string | null | undefined): string | null => (hash && /^#?setup-([\w-]+)$/.exec(hash)?.[1]) || null;

/** The dependency a connector reads through (its Setup row). */
export function dependencyIdForSource(source: string | null | undefined): string | null {
  switch (source) {
    case 'slack':
      return 'slack-mcp';
    case 'org62':
      return 'org62-mcp';
    case 'gmail':
    case 'calendar':
    case 'drive':
    case 'gemini':
      return 'devbar';
    case 'vdp':
      return 'vdp-access';
    case 'claude':
      return 'claude-signin';
    default:
      return null;
  }
}

/** The dependency a catalog code is about (its Setup row), or null when it is not about one (a send, a bug). */
export function dependencyIdForCode(code: string | null | undefined): string | null {
  if (!code) return null;
  const rules: Array<[RegExp, string]> = [
    [/^(AUTH|RATE)\.SLACK\b|^DATA\.SLACK_SCOPE$/, 'slack-mcp'],
    [/^(AUTH|RATE)\.ORG62\b|^DATA\.SOQL_INVALID$/, 'org62-mcp'],
    [/^(AUTH|RATE)\.GOOGLE\b|^DEP\.DEVBAR\.|^NET\.GATEWAY_DOWN$/, 'devbar'],
    [/^(AUTH|RATE)\.VDP\b|^DEP\.(VDP|PYTHON)\./, 'vdp-access'],
    [/^DEP\.CLAUDE\.(MISSING|TOO_OLD)$/, 'claude-cli'],
    [/^(AUTH|RATE)\.LLM\./, 'claude-signin'],
    [/^DEP\.DB\.|^DATA\.SCHEMA_/, 'database'],
    [/^DEP\.WORKER\.|^BUG\.WORKER_CRASH_LOOP$/, 'worker'],
    [/^DEP\.NODE\./, 'node'],
  ];
  return rules.find(([re]) => re.test(code))?.[1] ?? null;
}

/** The connector a dependency's re-auth runs on (by source kind: db connector ids are uuids). */
export function connectorForDependency<C extends Pick<Connector, 'id' | 'source' | 'state'>>(depId: string, connectors: readonly C[]): C | null {
  const of = connectors.filter((c) => dependencyIdForSource(c.source) === depId);
  // Google: the first one that needs you, else Gmail
  return of.find((c) => c.state === 'auth_needed' || c.state === 'error') ?? of.find((c) => c.source === 'gmail') ?? of[0] ?? null;
}

// ------------------------------------------------------------------ codes from connectors and API errors

/** A connector's current problem as a catalog code (null when it is fine). Never its raw error message. */
export function connectorCode(c: Pick<Connector, 'state' | 'source' | 'lastError' | 'impact'>): string | null {
  if (c.state === 'ok' || c.state === 'catching_up' || c.state === 'paused') return null;
  const fromLine = codeFromStatusReason(c.lastError?.message, c.source) ?? toCatalogCode(c.lastError?.message, c.source);
  if (fromLine) return fromLine;
  switch (c.state) {
    case 'auth_needed':
      return toCatalogCode('auth_needed', c.source);
    case 'offline':
      return 'NET.OFFLINE';
    case 'degraded':
      return c.lastError?.class === 'rate_limited' ? toCatalogCode('rate_limited', c.source) : 'NET.SERVICE_DOWN';
    default:
      return c.lastError?.class === 'auth' ? toCatalogCode('invalid_auth', c.source) : 'BUG.UNKNOWN';
  }
}

/** An ApiError (or anything thrown) → a catalog code: the server's own code when it sent one, else its API code's. */
export function errorCode(e: unknown): string {
  const details = (e as { details?: { code?: unknown } } | null)?.details;
  if (details && typeof details.code === 'string' && isCatalogCode(details.code)) return details.code;
  const api = (e as { code?: unknown } | null)?.code;
  return (typeof api === 'string' && toCatalogCode(api)) || 'BUG.UNKNOWN';
}

export interface Problem {
  code: string;
  title: string;
  text: string;
  nextStep: string;
  action: CatalogAction | null;
  /** The Setup row that owns the detail, when the problem is about a dependency. */
  depId: string | null;
  href: string | null;
}

/** One problem in the catalog's words, with the Setup row it links to. */
export function problemOf(code: string, o: { source?: string | null; depId?: string | null } = {}): Problem {
  const r = render(code, { source: o.source ?? null });
  const depId = o.depId ?? dependencyIdForCode(r.code);
  return { code: r.code, title: r.title, text: r.text, nextStep: r.nextStep, action: r.action, depId, href: depId ? setupHref(depId) : null };
}

/**
 * A broken or degraded connector's problem. When its Setup row needs the user, the row's code wins (one diagnosis for
 * both); otherwise the connector's own state.
 */
export function connectorProblem(c: Pick<Connector, 'state' | 'source' | 'lastError' | 'impact' | 'label'>, setup?: readonly SetupDependency[] | null): Problem | null {
  const depId = dependencyIdForSource(c.source);
  const dep = depId ? setup?.find((d) => d.id === depId) : undefined;
  const own = connectorCode(c);
  if (!own) return null;
  const code = dep && needsAction(dep.state) && dep.code ? dep.code : own;
  return problemOf(code, { source: c.label, depId });
}

/** A toast in the catalog's words for a thrown error, with "How to fix" when a Setup row owns it. */
export function problemToast(e: unknown, o: { key: string; source?: string | null; title?: string }) {
  const p = problemOf(errorCode(e), { source: o.source ?? null });
  return {
    key: o.key,
    tone: 'error' as const,
    title: o.title ? `${o.title}: ${p.title}` : p.title,
    body: p.nextStep,
    durationMs: 20_000,
    ...(p.href ? { action: { label: 'How to fix', href: p.href } } : {}),
  };
}

// ------------------------------------------------------------------ the row

export type SetupButtonKind = 'run' | 'reauth' | 'open' | 'link' | 'report' | 'smoke' | 'check';

export interface SetupButton {
  kind: SetupButtonKind;
  label: string;
  /** run: the command · reauth: the handler kind · open: an app route · link: a URL or README anchor. */
  ref: string;
}

export interface SetupRowView {
  id: string;
  anchor: string;
  label: string;
  why: string;
  state: DependencyState;
  chip: { label: string; tone: SetupTone };
  needsYou: boolean;
  /** The catalog's title and text (what broke, in the user's words); null when ok. */
  problem: { title: string; text: string } | null;
  /** The ONE next step; null when ok. */
  nextStep: string | null;
  /** The exact command to copy (a `run` action), shown in a copy box. */
  command: string | null;
  /** The primary button first; "Check again" (or the Claude test) last. */
  buttons: SetupButton[];
  /** The catalog code, shown only in a muted "code" chip. */
  code: string | null;
  checked: string;
}

/** "checked just now" · "checked 2 min ago" · "checked 3 h ago" · "checked 2 days ago" · "not checked yet". */
export function checkedAgo(iso: string | null | undefined, nowMs: number): string {
  if (!iso) return 'not checked yet';
  const min = Math.floor((nowMs - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(min)) return 'not checked yet';
  if (min < 1) return 'checked just now';
  if (min < 60) return `checked ${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `checked ${h} h ago`;
  const d = Math.floor(h / 24);
  return `checked ${d} day${d === 1 ? '' : 's'} ago`;
}

const smokeLabel = () => `Test Claude (about $${SMOKE_ESTIMATE_USD.toFixed(3)})`;

function buttonOf(a: CatalogAction): SetupButton {
  return { kind: a.kind, label: a.label, ref: a.ref };
}

export function setupRowView(dep: SetupDependency, nowMs: number): SetupRowView {
  const chip = STATE_CHIP[dep.state];
  const base = { id: dep.id, anchor: setupAnchor(dep.id), label: dep.label, why: dep.why, state: dep.state, chip, checked: checkedAgo(dep.lastChecked, nowMs) };
  const check: SetupButton = dep.id === 'claude-signin' ? { kind: 'smoke', label: smokeLabel(), ref: 'claude-smoke' } : { kind: 'check', label: 'Check again', ref: dep.id };
  if (dep.state === 'ok') return { ...base, needsYou: false, problem: null, nextStep: null, command: null, buttons: [], code: null };

  const r = dep.code ? render(dep.code) : null;
  const action = dep.action ?? r?.action ?? null;
  const command = action?.kind === 'run' ? action.ref : null;

  if (dep.state === 'offline' || dep.state === 'unknown') {
    // never "broken": the app's own retry; a known network code still says which network, in the catalog's words
    const problem = r && dep.state === 'offline' ? { title: r.title, text: r.text } : { title: chip.label, text: UNSURE_TEXT[dep.state] };
    return { ...base, needsYou: false, problem, nextStep: r && dep.state === 'offline' ? r.nextStep : (dep.nextStep ?? null), command: null, buttons: [check], code: r?.code ?? null };
  }

  const problem = r ? { title: r.title, text: r.text } : { title: `${dep.label}: ${chip.label.toLowerCase()}`, text: dep.why };
  const nextStep = dep.nextStep ?? r?.nextStep ?? 'Click Check again.';
  const buttons: SetupButton[] = [];
  // a `run` action is the copy box, not a button; Check again verifies it afterwards
  if (action && action.kind !== 'run') buttons.push(buttonOf(action));
  buttons.push(check);
  return { ...base, needsYou: true, problem, nextStep, command, buttons, code: r?.code ?? dep.code ?? null };
}

// ------------------------------------------------------------------ the list and the badge

/** The Setup rows that need the user (the sidebar's health badge counts these: one list, one number). */
export function selectSetupNeedsYou(h: Pick<HealthPayload, 'setup'> | null | undefined): SetupDependency[] {
  return (h?.setup?.dependencies ?? []).filter((d) => needsAction(d.state));
}

/** The sidebar health badge count, from the same list Health ▸ Setup shows. */
export const setupBadgeCount = (h: Pick<HealthPayload, 'setup'> | null | undefined): number => selectSetupNeedsYou(h).length;

export interface SetupSummary {
  needs: number;
  unsure: number;
  ok: number;
  /** "All set" · "2 need you · 1 can't tell yet". */
  line: string;
  /** The newest check across the rows (the "checked 2 min ago" stamp). */
  lastChecked: string | null;
}

export function setupSummary(deps: readonly SetupDependency[]): SetupSummary {
  const needs = deps.filter((d) => needsAction(d.state)).length;
  const unsure = deps.filter((d) => d.state === 'offline' || d.state === 'unknown').length;
  const ok = deps.length - needs - unsure;
  const parts = [needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', unsure ? `${unsure} can't tell yet` : ''].filter(Boolean);
  const lastChecked = deps.map((d) => d.lastChecked).filter((x): x is string => !!x).sort().at(-1) ?? null;
  return { needs, unsure, ok, line: parts.length ? parts.join(' · ') : 'All set', lastChecked };
}

/** Rows that need the user first, then the unsure ones, then ready; the server's order within each. */
export function sortSetup<T extends Pick<SetupDependency, 'state'>>(deps: readonly T[]): T[] {
  const rank = (s: DependencyState) => (needsAction(s) ? 0 : s === 'ok' ? 2 : 1);
  return deps.map((d, i) => ({ d, i })).sort((a, b) => rank(a.d.state) - rank(b.d.state) || a.i - b.i).map((x) => x.d);
}

// ------------------------------------------------------------------ app down (GET /health failed)

export interface DownView {
  code: string;
  title: string;
  text: string;
  nextStep: string;
  command: string | null;
}

/**
 * GET /health failed: what GET /doctor says broke, in the catalog's words. The database first (nothing loads without
 * it), then a stale worker heartbeat. Null when the doctor names neither (the page shows its generic retry).
 */
export function appDownView(doctor: { database?: DownView | null; checks?: Array<{ id: string; code?: string; status: string }> } | null | undefined): DownView | null {
  if (!doctor) return null;
  if (doctor.database) return doctor.database;
  const hb = doctor.checks?.find((c) => c.id === 'heartbeat' && c.status !== 'ok' && c.code);
  if (!hb?.code) return null;
  const r = render(hb.code);
  return { code: r.code, title: r.title, text: r.text, nextStep: r.nextStep, command: r.action?.kind === 'run' ? r.action.ref : null };
}

// ------------------------------------------------------------------ the update banner (H-11, H-12)

export type UpdateSource = 'installed' | 'checkout';

export interface UpdateBannerInfo {
  text: string;
  prompt: string;
  notes: string | null;
  /** Where this app runs from (GET /version `release`): an installed copy updates from a build file, a checkout from its repo. */
  source: UpdateSource;
  /** The short line that says which ("Installed copy: Claude Code downloads the build from Drive"). */
  how: string;
}

/**
 * "Command Center 2.0.1 is available · Ask Claude Code to update", and the exact prompt the click copies. An installed
 * copy (`release` present) can't run a plain `npm run update` (that prints "update it from a build file"): its prompt
 * is the server's (`update.prompt`: the Drive download, the sha256 check, then
 * `npm --prefix "<releases/current>" run update -- --from <file>`). A source checkout keeps `npm run update`.
 */
export function updateBanner(
  v:
    | {
        version: string;
        update?: { available: boolean; version?: string | null; notes?: string; channel: string; prompt?: string } | null;
        release?: { version: string } | null;
      }
    | null
    | undefined,
): UpdateBannerInfo | null {
  const u = v?.update;
  if (!u?.available || !u.version || u.version === v?.version) return null;
  const notes = u.notes?.trim() || null;
  const text = `Command Center ${u.version} is available`;
  if (v?.release) {
    const prompt =
      u.prompt?.trim() ||
      // the server builds it whenever `available`; this only covers a reply without it
      `Update Command Center to v${u.version}: follow "Updating" in docs/INSTALL.md (download the build and manifest.json from the Command Center Drive folder, check its sha256, then run update -- --from that file), and show me its output. Do not change anything else.`;
    return { text, prompt, notes, source: 'installed', how: 'Installed copy: Claude Code downloads the build from Drive' };
  }
  return {
    text,
    prompt: `Update Command Center to ${u.version}: in the Command Center folder run npm run update, and tell me what it printed.`,
    notes,
    source: 'checkout',
    how: 'Source checkout: Claude Code runs npm run update',
  };
}
