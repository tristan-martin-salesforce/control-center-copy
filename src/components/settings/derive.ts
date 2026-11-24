/** Settings: pure helpers (dirty checks, policy editing, thresholds). Tested in tests/p5/settings-derive.test.ts. */
import type { AutonomyLevel, PolicyRule, PolicyVersion, PolicyWeightKey, PolicyWeights, RankRow } from '@/contract';

export function same(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => same((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/** Only the keys of `draft` (within `keys`) that differ from the server value: the minimal PATCH body. */
export function changedKeys<T extends Record<string, unknown>>(draft: T, server: T, keys: readonly (keyof T)[]): Partial<T> {
  const out: Partial<T> = {};
  for (const k of keys) if (!same(draft[k], server[k])) out[k] = draft[k];
  return out;
}

export function isDirty<T extends Record<string, unknown>>(draft: T, server: T, keys: readonly (keyof T)[]): boolean {
  return Object.keys(changedKeys(draft, server, keys)).length > 0;
}

// ── Priority policy ────────────────────────────────────────────────────────────────────────

export const WEIGHT_META: Record<PolicyWeightKey, { label: string; hint: string }> = {
  customer_facing: { label: 'Customer-facing', hint: 'Work that touches a customer beats internal work.' },
  meeting_proximity: { label: 'Meeting proximity', hint: 'Serves a meeting that is coming up soon.' },
  due_urgency: { label: 'Due urgency', hint: 'Due soon or overdue.' },
  manager_ask: { label: 'Manager ask', hint: 'Asked by your manager.' },
  deal_value: { label: 'Deal value', hint: 'Bigger opportunities rise.' },
  lead_time: { label: 'Lead time', hint: 'Long agent time with a meeting ahead: kick it off first.' },
  age: { label: 'Age', hint: 'Old items rise slowly.' },
  effort_fit: { label: 'Effort fit', hint: 'Small items that fit a gap.' },
};
export const WEIGHT_KEYS = Object.keys(WEIGHT_META) as PolicyWeightKey[];

export function setWeight(w: PolicyWeights, key: PolicyWeightKey, value: number): PolicyWeights {
  return { ...w, [key]: Math.min(10, Math.max(0, Math.round(value * 2) / 2)) };
}

export type RuleCondition = 'any' | 'customer' | 'manager' | 'due24';

export const CONDITION_LABEL: Record<RuleCondition, string> = {
  any: 'Always',
  customer: 'When it is customer-facing',
  manager: 'When my manager asks',
  due24: 'When due within 24 h',
};

export function conditionToWhen(c: RuleCondition): PolicyRule['when'] {
  switch (c) {
    case 'customer':
      return { customerFacing: true };
    case 'manager':
      return { fromManager: true };
    case 'due24':
      return { dueWithinH: 24 };
    default:
      return {};
  }
}

export function newRule(text: string, condition: RuleCondition, boost: number, id = `rule_${Math.random().toString(36).slice(2, 8)}`): PolicyRule {
  return { id, text: text.trim(), enabled: true, when: conditionToWhen(condition), boost: Math.min(10, Math.max(-10, boost)) };
}

export function canPreview(weights: PolicyWeights, rules: PolicyRule[], serverWeights: PolicyWeights, serverRules: PolicyRule[]): boolean {
  return !same(weights, serverWeights) || !same(rules, serverRules);
}

export function lastChangedLine(versions: PolicyVersion[], current: number): string {
  const v = versions.find((x) => x.version === current) ?? versions[0];
  if (!v) return `v${current}`;
  const by = v.by === 'chat' ? 'chat' : v.by === 'user' ? 'you' : 'the starter pack';
  return `Last changed by ${by} · v${v.version}`;
}

// ── Agent behavior ─────────────────────────────────────────────────────────────────────────

export const AUTONOMY_LEVELS: Array<{ level: AutonomyLevel; label: string; hint: string }> = [
  { level: 'L0', label: 'L0 Suggest', hint: 'Shown in the app only.' },
  { level: 'L1', label: 'L1 Draft', hint: 'A draft exists in the app. You send it.' },
  { level: 'L2', label: 'L2 Stage', hint: 'Pushed to the destination as a draft.' },
  { level: 'L3', label: 'L3 One-click', hint: 'Executes when you approve.' },
  { level: 'L4', label: 'L4 Auto', hint: 'Executes without a click, audited and undoable. Internal, reversible actions and the two approved batches (logging and forecast) only.' },
];

export const ACTION_LABEL: Record<string, string> = {
  slack_reply: 'Slack replies',
  email_reply: 'Email replies',
  canvas_rewrite: 'Updating an approved batch',
  tool_launch: 'Launching tools',
  claude_session: 'Claude sessions',
  activity_log: 'Activity log approval',
};

export const actionLabel = (k: string) => ACTION_LABEL[k] ?? k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Raising an action's autonomy above L2 sends or executes without a click: worth a heads-up. */
export function autonomyRaised(before: Record<string, AutonomyLevel>, after: Record<string, AutonomyLevel>): string[] {
  const rank = (l: AutonomyLevel) => Number(l.slice(1));
  return Object.keys(after).filter((k) => rank(after[k]!) > rank(before[k] ?? 'L0') && rank(after[k]!) >= 3);
}

// ── Thresholds (engine settings; local until the contract has a section) ────────────────────

export interface Thresholds {
  autoCloseMin: 'sure' | 'likely';
  reopenWindowDays: number;
  mergeScore: number;
  snoozeWakeOnNewInfo: boolean;
}

export const DEFAULT_THRESHOLDS: Thresholds = { autoCloseMin: 'sure', reopenWindowDays: 14, mergeScore: 0.85, snoozeWakeOnNewInfo: false };
export const THRESHOLDS_KEY = 'cc:settings:thresholds';

export function parseThresholds(raw: string | null): Thresholds {
  if (!raw) return DEFAULT_THRESHOLDS;
  try {
    const v = JSON.parse(raw) as Partial<Thresholds>;
    return {
      autoCloseMin: v.autoCloseMin === 'likely' ? 'likely' : 'sure',
      reopenWindowDays: Number.isFinite(v.reopenWindowDays) ? Math.max(1, Math.round(v.reopenWindowDays!)) : DEFAULT_THRESHOLDS.reopenWindowDays,
      mergeScore: Number.isFinite(v.mergeScore) ? Math.min(1, Math.max(0.5, v.mergeScore!)) : DEFAULT_THRESHOLDS.mergeScore,
      snoozeWakeOnNewInfo: v.snoozeWakeOnNewInfo === true,
    };
  } catch {
    return DEFAULT_THRESHOLDS;
  }
}

export const COMMON_TIMEZONES = ['America/Denver', 'America/Los_Angeles', 'America/Chicago', 'America/New_York', 'America/Phoenix', 'Europe/London', 'Europe/Paris', 'Europe/Berlin', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function validateHours(start: string, end: string): string | null {
  const ok = /^([01]\d|2[0-3]):[0-5]\d$/;
  if (!ok.test(start) || !ok.test(end)) return 'Use 24-hour times like 07:30.';
  return start >= end ? 'Start must be before end.' : null;
}

export function validateBudgets(softUsd: number, hardUsd: number, alertPct: number): string | null {
  if (![softUsd, hardUsd, alertPct].every(Number.isFinite)) return 'Enter numbers.';
  if (softUsd > hardUsd) return 'The soft budget cannot be higher than the hard cap.';
  if (alertPct < 1 || alertPct > 100) return 'The alert is a percentage from 1 to 100.';
  return null;
}

// ── Settings v2: nav, policy diff, re-rank comparison, score breakdown ──────────────────────

export type SectionId = 'profile' | 'role' | 'display' | 'time' | 'policy' | 'thresholds' | 'closing' | 'agent' | 'sending' | 'budgets' | 'connectors' | 'watches' | 'scanning' | 'feedback' | 'data' | 'about';

/** The five top sections (01-ui-audit R8) plus Advanced, collapsed. */
export type SectionGroupId = 'me' | 'sources' | 'sending' | 'budgets' | 'data' | 'advanced';

export interface SectionMeta {
  id: SectionId;
  label: string;
  /** Extra words the "Find a setting" box matches. */
  keywords: string;
}

export interface SectionGroup {
  id: SectionGroupId;
  label: string;
  /** One line under the group's name. */
  blurb: string;
  /** Advanced: folded until opened, a search matches inside it, or one of its pages is open. */
  collapsed?: boolean;
  items: SectionMeta[];
}

/**
 * Settings in five sections (01-ui-audit R8, 2026-11-20): Me · Sources · Sending · Budgets · Data, then Advanced.
 * Each section holds the pages it took over; `?section=` names a page, so every old link still lands (the page ids
 * did not change), and a section's own id (`?section=me`) opens its first page. Storage keys did not change.
 */
export const SECTION_GROUPS: SectionGroup[] = [
  {
    id: 'me',
    label: 'Me',
    blurb: 'Who you are, your role, your hours',
    items: [
      { id: 'profile', label: 'Profile & hours', keywords: 'me identity name email role pack manager timezone time zone working hours days aes i cover coverage' },
      { id: 'role', label: 'Role & rules', keywords: 'role persona solutions engineer se specialist ae account executive level manager duties rules what counts as a task capture thresholds features sources activate deactivate available preconfiguration preset vdp forecast notes deal role contributions missed opportunities' },
      { id: 'display', label: 'Display', keywords: 'theme dark light system text size font density compact comfortable shortcuts keyboard cheat sheet' },
      { id: 'time', label: 'Time', keywords: 'time onsite on-site trip travel flight airport buffer hotel dinner customer-facing hours frame dismissed sources' },
    ],
  },
  {
    id: 'sources',
    label: 'Sources',
    blurb: 'What the app reads, and how often',
    items: [
      { id: 'connectors', label: 'Connectors', keywords: 'connectors sources slack gmail calendar drive gemini org62 vdp claude auth re-auth sign in scan health' },
      { id: 'watches', label: 'Watches', keywords: 'watches channels briefs subscriptions cadence digest' },
      { id: 'scanning', label: 'Scanning', keywords: 'scanning scanner asks channel @channel @here list catch up missed meeting get up to speed opp team where does this belong mapping questions triage' },
    ],
  },
  {
    id: 'sending',
    label: 'Sending',
    blurb: 'What may leave, and how much the agents do',
    items: [
      { id: 'sending', label: 'Sending', keywords: 'sending dry run dry-run draft send default read-back verification undo window vdp autopilot daily cap trusted sites asset links hosts closing items for you resolution check old closers watch only' },
      { id: 'agent', label: 'Autonomy', keywords: 'agent behavior autonomy ladder L0 L1 L2 L3 L4 voice samples style task capture watched sources channels drafting tone length sign-off' },
      { id: 'feedback', label: 'Feedback', keywords: 'feedback report bug idea team channel slack post live diagnose' },
    ],
  },
  {
    id: 'budgets',
    label: 'Budgets',
    blurb: 'What the AI may spend',
    items: [{ id: 'budgets', label: 'Budgets', keywords: 'budgets spend cost soft hard cap usd dollars alert warning per message per run day assistant limits receipts holds asks governor model routing auto haiku sonnet opus ranking priority engine v1 v2 preview make this my list memory remember remembers preferences pinned notes forget' }],
  },
  {
    id: 'data',
    label: 'Data',
    blurb: 'What is kept, backups, and this build',
    items: [
      { id: 'data', label: 'Data & backups', keywords: 'data retention keep delete purge clean up old records trace events llm text orphan sources backups backup restore export database size disk privacy' },
      { id: 'about', label: 'About', keywords: 'about version sha build modified changelog release update upgrade migration worker persona getting started checklist tips coach marks guide readme' },
    ],
  },
  {
    id: 'advanced',
    label: 'Advanced',
    blurb: 'Ranking and closing rules',
    collapsed: true,
    items: [
      { id: 'policy', label: 'Priority policy', keywords: 'priority policy weights sliders rules boost rank re-rank preview apply version revert undo customer-facing manager due urgency meeting' },
      { id: 'thresholds', label: 'Thresholds', keywords: 'thresholds auto-close evidence reopen window merge score snooze wake engines' },
      { id: 'closing', label: 'Closing work', keywords: 'closing close for me auto-close closed for you settle done resolved moment passed not yours not an ask duplicate superseded gone quiet strictness cautious balanced eager ask first external people channels rules reopen follow-up old asks stronger model tell me what closed' },
    ],
  },
];

export const SECTIONS: SectionMeta[] = SECTION_GROUPS.flatMap((g) => g.items);
/** Settings opens on who you are (Me ▸ Profile & hours); the ranking policy sits under Advanced. */
export const DEFAULT_SECTION: SectionId = 'profile';

/** The section a page sits in. */
export function groupOf(id: SectionId): SectionGroup {
  return SECTION_GROUPS.find((g) => g.items.some((it) => it.id === id))!;
}

/**
 * `?section=` → the page to show: a page id as is (every link from before the five sections), a section id
 * (`me`, `sources`, `data`, `advanced`) its first page, anything else Me ▸ Profile.
 */
export function asSectionId(v: string | null | undefined): SectionId {
  if (SECTIONS.some((s) => s.id === v)) return v as SectionId;
  const g = SECTION_GROUPS.find((x) => x.id === v);
  return g ? g.items[0]!.id : DEFAULT_SECTION;
}

/** Sections whose label, keywords or current summary contain every word of the query. */
export function matchSections(q: string, summaries: Partial<Record<SectionId, string>> = {}): SectionId[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return SECTIONS.filter((s) => {
    const hay = `${s.label} ${s.keywords} ${summaries[s.id] ?? ''}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).map((s) => s.id);
}

const fmtNum = (n: number) => String(Math.round(n * 100) / 100);

/** Plain-language list of what a policy draft changes: "Due urgency 2.5 → 3.5", "“Travel can wait” off". */
export function policyChanges(saved: { weights: PolicyWeights; rules: PolicyRule[] }, draft: { weights: PolicyWeights; rules: PolicyRule[] }): string[] {
  const out: string[] = [];
  for (const k of WEIGHT_KEYS) if (saved.weights[k] !== draft.weights[k]) out.push(`${WEIGHT_META[k].label} ${fmtNum(saved.weights[k])} → ${fmtNum(draft.weights[k])}`);
  const byId = new Map(saved.rules.map((r) => [r.id, r]));
  for (const r of draft.rules) {
    const o = byId.get(r.id);
    if (!o) out.push(`new rule “${r.text}”`);
    else if (o.enabled !== r.enabled) out.push(`“${r.text}” ${r.enabled ? 'on' : 'off'}`);
    else if (o.boost !== r.boost) out.push(`“${r.text}” boost ${fmtNum(o.boost)} → ${fmtNum(r.boost)}`);
    else if (o.text !== r.text) out.push(`renamed “${o.text}”`);
  }
  const kept = new Set(draft.rules.map((r) => r.id));
  for (const o of saved.rules) if (!kept.has(o.id)) out.push(`removed “${o.text}”`);
  return out;
}

export interface CompareRow {
  id: string;
  title: string;
  rank: number;
  score: number;
  why: string | null;
  /** Rank in the current ordering (null = not in the current top 10). */
  was: number | null;
}

export interface RankCompare {
  now: CompareRow[];
  after: CompareRow[];
  /** After-apply top 5 rows whose current rank is outside the top 5. */
  enters: CompareRow[];
  /** Current top 5 rows that fall outside the top 5 after apply (`to` null = beyond the top 10). */
  leaves: Array<CompareRow & { to: number | null }>;
  /** How many of the top 5 positions change. */
  movedTop5: number;
}

/** Before/after from the real policy preview. `moved` on a server row is positive when it rose. */
export function compareRanks(before: RankRow[], after: RankRow[]): RankCompare {
  const nowRank = new Map(before.map((r) => [r.workItemId, r.rank]));
  const afterRank = new Map(after.map((r) => [r.workItemId, r.rank]));
  const now: CompareRow[] = before.map((r) => ({ id: r.workItemId, title: r.title, rank: r.rank, score: r.score, why: r.topReason, was: r.rank }));
  const aft: CompareRow[] = after.map((r) => {
    const was = nowRank.get(r.workItemId) ?? (r.moved ? r.rank + r.moved : null);
    return { id: r.workItemId, title: r.title, rank: r.rank, score: r.score, why: r.topReason, was };
  });
  const enters = aft.filter((r) => r.rank <= 5 && (r.was === null || r.was > 5));
  const leaves = now.filter((r) => r.rank <= 5 && !((afterRank.get(r.id) ?? Infinity) <= 5)).map((r) => ({ ...r, to: afterRank.get(r.id) ?? null }));
  const movedTop5 = aft.filter((r) => r.rank <= 5 && r.was !== r.rank).length;
  return { now, after: aft, enters, leaves, movedTop5 };
}

export interface BreakdownLine {
  key: string;
  label: string;
  now: number;
  /** Estimated under the draft; null when it can't be derived (the weight was 0). */
  after: number | null;
  changed: boolean;
}

/**
 * Why an item scores what it does, part by part (RankReason: weight × signal, plus rules), and what the draft
 * changes. A weight's part scales with the weight (the signal is fixed); a rule's part is its boost while on.
 * The remainder (parts beyond the top reasons) is one "Other signals" line, so the parts add up to the score.
 */
export function scoreBreakdown(
  reasons: Array<{ key: string; label: string; contribution: number }>,
  score: number | null,
  saved: { weights: PolicyWeights; rules: PolicyRule[] },
  draft: { weights: PolicyWeights; rules: PolicyRule[] } | null,
  /** The real score under the draft (from the preview), when known. */
  afterScore?: number | null,
): { lines: BreakdownLine[]; nowTotal: number; afterTotal: number | null } {
  const lines: BreakdownLine[] = reasons.map((r) => {
    let after: number | null = r.contribution;
    if (draft) {
      if ((WEIGHT_KEYS as string[]).includes(r.key)) {
        const k = r.key as PolicyWeightKey;
        after = saved.weights[k] > 0 ? (r.contribution * draft.weights[k]) / saved.weights[k] : null;
      } else if (r.key.startsWith('rule:')) {
        const rule = draft.rules.find((x) => x.id === r.key.slice(5));
        after = rule && rule.enabled ? rule.boost : 0;
      }
    }
    const a = after === null ? null : Math.round(after * 100) / 100;
    return { key: r.key, label: r.label, now: r.contribution, after: a, changed: a === null || Math.abs(a - r.contribution) > 1e-9 };
  });
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const sum = reasons.reduce((n, r) => n + r.contribution, 0);
  const nowTotal = score ?? sum;
  let rest = r2(nowTotal - sum);
  // A changed weight outside the top reasons still moved the score: when the real after-score is known, the part
  // nothing else explains belongs to it (score is linear in each weight), so it gets its own line.
  if (draft && afterScore !== null && afterScore !== undefined) {
    const shown = new Set(reasons.map((r) => r.key));
    const missing = WEIGHT_KEYS.filter((k) => !shown.has(k) && draft.weights[k] !== saved.weights[k]);
    const known = lines.reduce((n, l) => n + ((l.after ?? l.now) - l.now), 0);
    const delta = r2(afterScore - nowTotal - known);
    if (missing.length === 1 && Math.abs(delta) >= 0.01) {
      const k = missing[0]!;
      const signal = delta / (draft.weights[k] - saved.weights[k]);
      const now = r2(signal * saved.weights[k]);
      lines.push({ key: k, label: WEIGHT_META[k].label, now, after: r2(now + delta), changed: true });
      rest = r2(rest - now);
    } else if (missing.length > 1 && Math.abs(delta) >= 0.01) {
      lines.push({ key: 'weights', label: 'Other changed weights', now: 0, after: delta, changed: true });
    }
  }
  if (Math.abs(rest) >= 0.01) lines.push({ key: 'other', label: 'Other signals', now: rest, after: rest, changed: false });
  const afterTotal = draft ? (lines.some((l) => l.after === null) ? null : r2(lines.reduce((n, l) => n + (l.after ?? 0), 0))) : null;
  return { lines, nowTotal, afterTotal };
}

/** What was typed for a new watch → kind, stored target and label ("team-updates" → "#team-updates"). Null while invalid. */
export function normaliseWatchTarget(raw: string): { targetKind: 'channel' | 'person' | 'search'; target: string; label: string } | null {
  const t = raw.trim();
  if (!t) return null;
  if (t.startsWith('@')) return t.length > 1 ? { targetKind: 'person', target: t.slice(1), label: t } : null;
  if (/\s/.test(t) && !t.startsWith('#')) return { targetKind: 'search', target: t, label: t };
  const name = t.replace(/^#+/, '').trim();
  return name ? { targetKind: 'channel', target: `#${name}`, label: `#${name}` } : null;
}

/** "07:30" → minutes after midnight (NaN when malformed). */
export function hhmmToMin(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

/** "10h a day" for valid working hours, else null. */
export function hoursPerDay(start: string, end: string): string | null {
  const a = hhmmToMin(start);
  const b = hhmmToMin(end);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return null;
  const m = b - a;
  return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''} a day`;
}

/** "Mon–Fri", "Mon, Wed, Fri", "No days". */
export function daysLabel(days: number[]): string {
  const d = [...new Set(days)].sort((a, b) => a - b);
  if (!d.length) return 'No days';
  const run = d.every((x, i) => i === 0 || x === d[i - 1]! + 1);
  if (run && d.length >= 3) return `${DAY_NAMES[d[0]!]}–${DAY_NAMES[d[d.length - 1]!]}`;
  return d.map((x) => DAY_NAMES[x]).join(', ');
}

/** Short zone name for "Every time shows in MT" (MST/MDT → MT). */
export function zoneAbbrev(tz: string, at: Date = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? tz;
    return part.replace(/^([MCEP])[SD]T$/, '$1T');
  } catch {
    return tz;
  }
}

// ── Closing work (SETTLE-1) ──────────────────────────────────────────────────────────────────

/** A channel as stored on the ask-first list ("team-updates" → "#team-updates"); null while empty. */
export function normaliseChannel(raw: string): string | null {
  const name = raw.trim().replace(/^#+/, '').trim();
  return name ? `#${name}`.slice(0, 120) : null;
}

/** The nav summary: "On · Balanced · 5 close" / "Off · asks only". */
export function closingSummary(c: { enabled: boolean; strictness: string; reasons: Record<string, string> }): string {
  if (!c.enabled) return 'Off · asks only';
  const close = Object.values(c.reasons).filter((a) => a === 'close').length;
  return `On · ${c.strictness.charAt(0).toUpperCase()}${c.strictness.slice(1)} · ${close} reason${close === 1 ? '' : 's'} close`;
}

/** "Me ▸ Profile & hours"; a page named like its section ("Budgets") says it once. */
export function sectionCrumb(group: string, page: string): string {
  return !page || page === group ? group : `${group} ▸ ${page}`;
}
