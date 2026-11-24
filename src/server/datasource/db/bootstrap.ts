/**
 * First-run bootstrap of a real database (WIRE): the user and every record `loadModel` needs, with real
 * defaults and no mock data. `npm run setup` calls it after migrations; `npm run db:bootstrap` runs it alone.
 *
 * What it writes (each step only fills in what is missing; an existing value is never overwritten):
 *   users                 the user (email lower-cased, the same key the worker's CC_USER_EMAIL resolves), display
 *                         name and time zone; `person_id` → the user's own `people` row (is_me); `team_pack_id`.
 *   person_identities     email, Slack member id, Org62 user id of "me" (the scanner's me.slackId / me.org62UserId),
 *                         one per system, only when "me" has none for that system yet.
 *   team pack             the SE task-type vocabulary (`src/engines/activity/taxonomy.ts`, CR/CF flags, swaps,
 *                         meeting-type rule) and the Meeting_Type picklist the contract maps (CF/CR).
 *   user_settings         `settings.<section>` for profile, agentBehavior, sending, budgets, display, chat;
 *                         `cc.meta` (asOf/lastActiveAt = now, the current Salesforce fiscal quarter, the canvas).
 *   priority_policies     v1 of the role pack's starter policy (SE IC or SE manager), active.
 *   llm_budgets           the `total` budget row, so spend rolls up per day (doctor's budget check).
 *
 * What it never writes: accounts, people other than "me", work items, connectors, jobs, scan runs, fixtures.
 * Connectors are registered by the scanner on first use (`DbScannerStore.connectorId`, one row per scanner
 * connector), so a bootstrapped database never holds a second row per source.
 *
 * Safe defaults (tenets: Nothing leaves without approval, Draft, don't send): dry-run ON, every channel in
 * draft mode, every autonomy level L1 (a draft in the app, you send it). Only the user raises them, in Settings.
 */
import { createHash } from 'node:crypto';

import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';

import {
  AgentBehaviorSettings,
  BudgetSettings,
  ChatSettings,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_TIME_SETTINGS,
  ClosingSettings,
  DEFAULT_CLOSING_SETTINGS,
  DEFAULT_SCANNING_SETTINGS,
  DEFAULT_SENDING_SETTINGS,
  DisplaySettings,
  FeedbackSettings,
  GuideSettings,
  DEFAULT_PRIORITY_SETTINGS,
  PersonaId,
  PersonaSettings,
  ProfileSettings,
  ScanningSettings,
  SendingSettings,
  TimeSettings,
  type PolicyRule,
  type PriorityPolicy,
  type SeedMeta,
} from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { llmBudgets, org62PicklistValues, people, personIdentities, seTaskTypes, teamPacks, users } from '@/db/schema';
import { CF_SWAP, INTERNAL_DOWNGRADE, isCF, isCR, isNeither, TAXONOMY } from '@/engines/activity/taxonomy';
import { addDays, localDay, zonedToMs } from '@/engines/activity/time';
import { ROLE_POLICIES } from '@/engines/priority/policy';
import type { PriorityTemplate } from '@/personas';

import { loadKv } from './ext';
import { uuidFor } from './ids';
import { contractWeightsFromEngine } from './policy-map';
import { ensureExtractor } from './seed';
import type { WriteCtx } from './store/common';
import { insertPolicyVersion, loadPolicies, META_KEY, readMeta, SECTIONS, settingsKey, writeMeta, writeSection, type MetaState, type Section } from './store/settings';

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$|^24:00$/;
/** An optional text field: blank (setup's "optional" answer) and missing both mean null. */
const optionalText = (t: z.ZodString) => z.preprocess((v) => (typeof v === 'string' ? v.trim() || null : (v ?? null)), t.nullable());

export const BootstrapProfile = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1),
  role: z.enum(['se_ic', 'se_manager']).default('se_ic'),
  /** D-55: the persona (se · ae). Its level comes from `role` (se_manager → manager). */
  persona: PersonaId.default('se'),
  timezone: z.string().refine(isIanaZone, 'not an IANA time zone'),
  workingHours: z
    .object({ start: z.string().regex(HHMM), end: z.string().regex(HHMM), days: z.array(z.number().int().min(0).max(6)).min(1).default([1, 2, 3, 4, 5]) })
    .default({ start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] }),
  /** Slack member id (U… / W…). The Slack scanner searches with it (`scan-slack`: from:/to: me). */
  slackUserId: optionalText(z.string().regex(/^[UW][A-Z0-9]{6,}$/, 'Slack member ids start with U or W')),
  /** Org62 User id (005…). The Org62 scanner queries my opportunity teams, events and DCs with it. */
  org62UserId: optionalText(z.string().regex(/^005[A-Za-z0-9]{12}([A-Za-z0-9]{3})?$/, 'Org62 user ids start with 005 (15 or 18 characters)')),
  managerName: optionalText(z.string()),
  /** Hours target of the current fiscal quarter (CR hours; the activity engine's 250). */
  quarterTargetH: z.number().min(0).max(2000).default(250),
});
export type BootstrapProfile = z.infer<typeof BootstrapProfile>;
export type BootstrapProfileInput = z.input<typeof BootstrapProfile>;

function isIanaZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz.includes('/') || tz === 'UTC';
  } catch {
    return false;
  }
}

/** `profile.json` as `npm run setup` writes it (snake_case) → bootstrap input. Unknown keys are ignored. */
export function profileFromSetupFile(raw: Record<string, unknown>): Partial<BootstrapProfileInput> {
  const wh = raw.working_hours as { start?: string; end?: string; days?: number[] } | undefined;
  const out: Partial<BootstrapProfileInput> = {};
  if (typeof raw.email === 'string' && raw.email) out.email = raw.email;
  if (typeof raw.name === 'string' && raw.name) out.name = raw.name;
  if (raw.role_pack === 'se_ic' || raw.role_pack === 'se_manager') out.role = raw.role_pack;
  if (raw.persona === 'se' || raw.persona === 'ae') out.persona = raw.persona;
  if (typeof raw.timezone === 'string' && raw.timezone) out.timezone = raw.timezone;
  if (wh?.start && wh.end) out.workingHours = { start: wh.start, end: wh.end, ...(Array.isArray(wh.days) && wh.days.length ? { days: wh.days } : {}) };
  if (typeof raw.slack_user_id === 'string') out.slackUserId = raw.slack_user_id;
  if (typeof raw.org62_user_id === 'string') out.org62UserId = raw.org62_user_id;
  if (typeof raw.manager_name === 'string') out.managerName = raw.manager_name;
  if (typeof raw.quarter_target_h === 'number') out.quarterTargetH = raw.quarter_target_h;
  return out;
}

// ---------------------------------------------------------------------------
// Defaults (pure)
// ---------------------------------------------------------------------------

/** Every action type the Settings page lists, at L1 (a draft in the app; you send it). */
export const DEFAULT_AUTONOMY = { slack_reply: 'L1', email_reply: 'L1', canvas_rewrite: 'L1', tool_launch: 'L1', claude_session: 'L1', activity_log: 'L1' } as const;

/** The settings sections for a profile (contract defaults; nothing personal beyond the profile itself). */
export function defaultSections(p: BootstrapProfile): Record<Section, unknown> {
  const firstName = p.name.split(/\s+/)[0] ?? p.name;
  return {
    profile: ProfileSettings.parse({ version: 1, name: p.name, email: p.email, role: p.role, timezone: p.timezone, workingHours: p.workingHours, managerName: p.managerName }),
    agentBehavior: AgentBehaviorSettings.parse({
      version: 1,
      voice: { samples: [], style: '' },
      autonomy: { ...DEFAULT_AUTONOMY },
      taskCapture: ['Anything I say I will do', 'Direct asks of me from customers, my AE or my manager', 'Action items assigned to me in meeting notes'],
      watchedSources: [],
      drafting: { tone: 'crisp', length: 'short', signoff: firstName },
    }),
    sending: SendingSettings.parse({ ...DEFAULT_SENDING_SETTINGS, channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' } } }),
    // SCANNER.md §7 and the scanner's own fallback: $5 soft (alert at 80%), $15 hard per day
    budgets: BudgetSettings.parse({ version: 1, softUsd: 5, hardUsd: 15, alertPct: 80 }),
    display: DisplaySettings.parse({ version: 1, density: 'comfortable', theme: 'lightning', shortcutsEnabled: true, scheme: 'dark', textSize: 16 }),
    chat: ChatSettings.parse({ ...DEFAULT_CHAT_SETTINGS }),
    time: TimeSettings.parse({ ...DEFAULT_TIME_SETTINGS, onsiteHours: { ...DEFAULT_TIME_SETTINGS.onsiteHours } }),
    closing: ClosingSettings.parse({ ...DEFAULT_CLOSING_SETTINGS }),
    scanning: ScanningSettings.parse({ ...DEFAULT_SCANNING_SETTINGS }),
    persona: PersonaSettings.parse({ version: 1, id: p.persona, level: p.persona === 'se' && p.role === 'se_manager' ? 'manager' : 'ic' }),
    feedback: FeedbackSettings.parse({ version: 1 }),
    guide: GuideSettings.parse({ version: 1 }),
    priority: { ...DEFAULT_PRIORITY_SETTINGS },
  };
}

/** The starter policy template for a profile: the persona's level template (AE → `ae`), else the SE role pack. */
export function templateFor(p: Pick<BootstrapProfile, 'role' | 'persona'>): PriorityTemplate {
  return p.persona === 'ae' ? 'ae' : p.role;
}

/**
 * The role pack's starter policy in contract vocabulary. Weights are the engine's role template
 * (`ROLE_POLICIES`, src/engines/priority/policy.ts) through the one weight mapping (policy-map.ts); rules are the
 * template's rules the contract can express (boost = engine points / POINTS_PER_WEIGHT). Template rules on
 * fields the contract has no condition for (external attendees, stakeholder tiers, the mandatory-training lane
 * floor) are left out; the engine-only `obligation` weight carries mandatory trainings instead.
 */
export function rolePolicy(role: PriorityTemplate, at: string, id: string): { policy: PriorityPolicy; obligation: number } {
  const tpl = ROLE_POLICIES[role];
  const trainingsBelowPrep: PolicyRule = { id: 'never_rank_trainings_above_customer_prep', text: 'Never rank trainings above customer prep', enabled: true, when: { kinds: ['training'] }, boost: -2 };
  const rules: PolicyRule[] =
    role !== 'se_manager'
      ? [
          { id: 'customer_facing_over_internal', text: 'Customer-facing beats internal', enabled: true, when: { customerFacing: true }, boost: 1.2 },
          { id: 'manager_asks_within_24h', text: "My manager's asks within 24h", enabled: true, when: { fromManager: true, dueWithinH: 24 }, boost: 0.8 },
          trainingsBelowPrep,
        ]
      : [
          { id: 'customer_facing_over_internal', text: 'Customer-facing beats internal', enabled: true, when: { customerFacing: true }, boost: 0.6 },
          { id: 'leader_asks_within_8h', text: "My leader's asks within 8h", enabled: true, when: { fromManager: true, dueWithinH: 8 }, boost: 1 },
          trainingsBelowPrep,
        ];
  return {
    policy: { id, version: 1, name: tpl.name, role, weights: contractWeightsFromEngine(tpl.weights), rules, updatedAt: at, note: `Role pack: ${tpl.name}` },
    obligation: tpl.weights.obligation,
  };
}

/**
 * The Salesforce fiscal quarter containing `now` in `tz` (the fiscal year starts on 1 February: FY27 is
 * Feb 2026 to Jan 2027). `due` is the quarter's last day at the end of the working day.
 */
export function fiscalQuarter(now: Date, tz: string, dayEnd = '18:00'): { label: string; due: string } {
  const today = localDay(now.getTime(), tz);
  const [y, m] = today.split('-').map(Number) as [number, number];
  const fy = m >= 2 ? y + 1 : y;
  const fiscalMonth = (m + 10) % 12; // Feb → 0 … Jan → 11
  const q = Math.floor(fiscalMonth / 3) + 1;
  const startMonth = (q - 1) * 3 + 1; // 0-based calendar month of the quarter's first day: Feb, May, Aug, Nov
  // every quarter starts in calendar year fy − 1 (Q4 runs Nov to Jan); Date.UTC rolls month 13 into the next year
  const nextStart = new Date(Date.UTC(fy - 1, startMonth + 3, 1)).toISOString().slice(0, 10);
  const lastDay = addDays(nextStart, -1);
  const end = dayEnd === '24:00' ? '23:59' : dayEnd;
  return { label: `Q${q} FY${String(fy % 100).padStart(2, '0')}`, due: new Date(zonedToMs(lastDay, end, tz)).toISOString() };
}

export function defaultMeta(p: BootstrapProfile, userId: string, now: Date): MetaState {
  const at = now.toISOString();
  const meta: SeedMeta = {
    schemaVersion: 1,
    label: 'live',
    asOf: at,
    lastActiveAt: at,
    timezone: p.timezone,
    user: { id: userId, name: p.name, email: p.email },
    quarter: { ...fiscalQuarter(now, p.timezone, p.workingHours.end), targetH: p.quarterTargetH, loggedH: 0 },
    canvas: { label: 'Work-order canvas', lastSyncedAt: null, rowsChangedSince: 0 },
  };
  return { ...meta, rankedAt: at, policyRankVersion: 1 };
}

/** The SE task-type vocabulary of the team pack (the team's task-type canvas, via the activity engine's taxonomy). */
const POST_SALE = /^(Post Sale|Red Account)/;
const ENABLEMENT = new Set(['Sales Enablement', 'Mentorship', 'Personal Development']);
export function taskTypeRows(): { name: string; cr: boolean; cf: boolean; bucket: 'pre_sale' | 'post_sale' | 'enablement' | 'neither'; requiresMeetingType: boolean }[] {
  return Object.keys(TAXONOMY).map((name) => ({
    name,
    cr: isCR(name),
    cf: isCF(name),
    bucket: POST_SALE.test(name) ? 'post_sale' : ENABLEMENT.has(name) ? 'enablement' : isNeither(name) ? 'neither' : 'pre_sale',
    requiresMeetingType: name === 'Workshop' || name === 'POC',
  }));
}
const TEAM_PACK = { slug: 'salesforce-se', version: '1', name: 'Salesforce SE', sourcePath: 'src/engines/activity/taxonomy.ts' } as const;

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

export class BootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BootstrapError';
  }
}

export interface BootstrapOptions {
  db: Db;
  profile: BootstrapProfileInput;
  now?: Date;
  log?: (line: string) => void;
}

export interface BootstrapResult {
  userId: string;
  /** `created`: a new user · `completed`: an existing user got the missing pieces · `up_to_date`: nothing to do. */
  status: 'created' | 'completed' | 'up_to_date';
  /** What this run wrote (names only, no values). */
  wrote: string[];
}

/** Idempotent: creates the user and whatever `loadModel` needs, never overwriting an existing value. */
export async function bootstrapUser(opts: BootstrapOptions): Promise<BootstrapResult> {
  const p = BootstrapProfile.parse(opts.profile);
  const { db } = opts;
  const now = opts.now ?? new Date();
  const log = opts.log ?? (() => {});
  const wrote: string[] = [];

  // one user per database: the web DataSource serves the single active user
  const others = await db.select({ id: users.id }).from(users).where(and(eq(users.isActive, true), ne(users.email, p.email))).limit(1);
  if (others.length) throw new BootstrapError('this database already has a different active user; bootstrap one user per database');

  // ---- users (not audited: identity), team pack (shared vocabulary)
  const inserted = await db.insert(users).values({ email: p.email, displayName: p.name, timezone: p.timezone }).onConflictDoNothing().returning({ id: users.id });
  const [u] = await db.select().from(users).where(eq(users.email, p.email));
  if (!u) throw new BootstrapError('could not create the user');
  const userId = u.id;
  if (inserted.length) wrote.push('user');
  else if (!u.displayName) {
    await db.update(users).set({ displayName: p.name }).where(eq(users.id, userId));
    wrote.push('user.display_name');
  }

  const packId = await ensureTeamPack(db, wrote);
  if (!u.teamPackId) {
    await db.update(users).set({ teamPackId: packId }).where(eq(users.id, userId));
    wrote.push('user.team_pack');
  }
  const extractorId = await ensureExtractor(db);

  // ---- audited rows in one system change set: me, settings, policy, meta
  const kv0 = await loadKv(db, userId);
  const sections0 = await loadSectionKeys(db, userId);
  const pol0 = await loadPolicies({ db, userId, kv: kv0 });
  const [me0] = u.personId ? [{ id: u.personId }] : await db.select({ id: people.id }).from(people).where(and(eq(people.ownerUserId, userId), eq(people.isMe, true))).orderBy(asc(people.createdAt)).limit(1);
  const ids0 = me0 ? await db.select({ system: personIdentities.system }).from(personIdentities).where(eq(personIdentities.personId, me0.id)) : [];
  const haveSystem = new Set(ids0.map((r) => r.system));
  const wantIds = ([['email', p.email], ['slack', p.slackUserId], ['org62_user', p.org62UserId]] as const).filter(([s, v]) => !!v && !haveSystem.has(s));
  const missingSections = SECTIONS.filter((s) => !sections0.has(settingsKey(s)));
  const [budget0] = await db.select({ id: llmBudgets.id }).from(llmBudgets).where(and(eq(llmBudgets.ownerUserId, userId), eq(llmBudgets.scope, 'total'))).limit(1);
  const needs = !me0 || !u.personId || wantIds.length > 0 || missingSections.length > 0 || !pol0.current || !readMeta({ kv: kv0 }) || !budget0;

  if (needs) {
    await withChangeSet({ db, userId, actor: actors.system('bootstrap'), kind: 'system', reason: 'Bootstrap: first-run settings and policy', undoable: false }, async (tx, cs) => {
      const w: WriteCtx = { tx, cs, userId, me: { id: me0?.id ?? userId, name: p.name }, now, extractorId, timezone: p.timezone, kv: kv0 };

      // "me": the user's own people row (from_me detection) and its identities
      let meId = me0?.id;
      if (!meId) {
        const taken = await tx.select({ id: people.id }).from(people).where(eq(people.id, userId));
        const [row] = await tx
          .insert(people)
          .values({ ...(taken.length ? {} : { id: userId }), ownerUserId: userId, displayName: p.name, primaryEmail: p.email, affiliation: 'internal', isMe: true })
          .returning({ id: people.id });
        meId = row!.id;
        wrote.push('me');
      }
      if (u.personId !== meId) {
        await tx.update(users).set({ personId: meId }).where(eq(users.id, userId));
        if (u.personId) wrote.push('user.person');
      }
      for (const [system, externalId] of wantIds) {
        await tx.insert(personIdentities).values({ ownerUserId: userId, personId: meId, system, externalId: externalId!, isPrimary: true, method: 'user', verifiedAt: now }).onConflictDoNothing();
        wrote.push(`identity.${system}`);
      }

      const sections = defaultSections(p);
      for (const s of missingSections) {
        await writeSection(w, s, sections[s]);
        wrote.push(`settings.${s}`);
      }

      if (!pol0.current) {
        const { policy, obligation } = rolePolicy(templateFor(p), now.toISOString(), uuidFor(`policy:${userId}`));
        await insertPolicyVersion(w, policy, { at: now.toISOString(), by: 'system', note: policy.note ?? 'Role pack', activate: true, rowId: policy.id, changeSetId: cs.id, obligation });
        wrote.push(`policy.${templateFor(p)}@v1`);
      }

      if (!readMeta({ kv: kv0 })) {
        await writeMeta(w, defaultMeta(p, meId, now));
        wrote.push(META_KEY);
      }

      // the total LLM budget row at the soft budget, alert only: spend rolls up per day (llm_budget_days, the
      // doctor's budget check); the scanner keeps its hard cap from the budgets section (default $15)
      if (!budget0) {
        const budgets = BudgetSettings.parse(sections0.get(settingsKey('budgets')) ?? sections.budgets);
        const b = await tx
          .insert(llmBudgets)
          .values({ ownerUserId: userId, scope: 'total', scopeValue: null, dailyLimitUsd: budgets.softUsd, alertAtPct: budgets.alertPct, hardStop: false, effectiveFrom: localDay(now.getTime(), p.timezone) })
          .onConflictDoNothing()
          .returning({ id: llmBudgets.id });
        if (b.length) wrote.push('llm_budget.total');
      }
    });
  }

  const status: BootstrapResult['status'] = inserted.length ? 'created' : wrote.length ? 'completed' : 'up_to_date';
  log(`[bootstrap] ${status}${wrote.length ? `: ${wrote.join(', ')}` : ''}`);
  return { userId, status, wrote };
}

async function loadSectionKeys(db: Db, userId: string): Promise<Map<string, unknown>> {
  const rows = await db.execute<{ key: string; value: unknown }>(sql`select key, value from user_settings where owner_user_id = ${userId} and key like 'settings.%'`);
  return new Map(rows.rows.map((r) => [r.key, r.value]));
}

/** The shared SE team pack: task types (with CF swaps / internal downgrades) and the Meeting_Type picklist. */
async function ensureTeamPack(db: Db, wrote: string[]): Promise<string> {
  const rows = taskTypeRows();
  const hash = createHash('sha256').update(JSON.stringify({ rows, CF_SWAP, INTERNAL_DOWNGRADE })).digest('hex').slice(0, 32);
  const made = await db.insert(teamPacks).values({ ...TEAM_PACK, contentHash: hash }).onConflictDoNothing().returning({ id: teamPacks.id });
  const [pack] = await db.select({ id: teamPacks.id }).from(teamPacks).where(and(eq(teamPacks.slug, TEAM_PACK.slug), eq(teamPacks.version, TEAM_PACK.version)));
  const packId = pack!.id;
  const tt = await db
    .insert(seTaskTypes)
    .values(rows.map((r, i) => ({ teamPackId: packId, name: r.name, countsCustomerRelated: r.cr, countsCustomerFacing: r.cf, bucket: r.bucket, requiresMeetingType: r.requiresMeetingType, ordinal: i })))
    .onConflictDoNothing()
    .returning({ id: seTaskTypes.id });
  if (tt.length) {
    const all = await db.select({ id: seTaskTypes.id, name: seTaskTypes.name }).from(seTaskTypes).where(eq(seTaskTypes.teamPackId, packId));
    const byName = new Map(all.map((r) => [r.name, r.id]));
    for (const [from, to] of Object.entries(CF_SWAP)) if (byName.has(from) && byName.has(to)) await db.update(seTaskTypes).set({ externalSwapToId: byName.get(to)! }).where(eq(seTaskTypes.id, byName.get(from)!));
    for (const [from, to] of Object.entries(INTERNAL_DOWNGRADE)) if (byName.has(from) && byName.has(to)) await db.update(seTaskTypes).set({ internalDowngradeToId: byName.get(to)! }).where(eq(seTaskTypes.id, byName.get(from)!));
  }
  const mt = await db
    .insert(org62PicklistValues)
    .values([
      { teamPackId: packId, field: 'Meeting_Type__c', value: 'CF', ordinal: 0 },
      { teamPackId: packId, field: 'Meeting_Type__c', value: 'CR', ordinal: 1 },
    ])
    .onConflictDoNothing()
    .returning({ id: org62PicklistValues.id });
  if (made.length || tt.length || mt.length) wrote.push('team_pack');
  return packId;
}
