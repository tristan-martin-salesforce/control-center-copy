/**
 * Onboarding on a real database (B-079).
 *
 * Who must onboard: an empty database (no active user), or a user row the bootstrap never finished. A user with
 * `user_settings` key `onboarding` = complete finished here; a fully bootstrapped user without that key was set up
 * by the CLI (`npm run setup` / `npm run db:bootstrap`) and counts as onboarded, so the CLI go-live never sees it.
 *
 * Until the last step the draft lives in the state folder (no user row to hang it on; src/server/onboarding/
 * drafts.ts). Finishing runs `bootstrapUser()` (exactly what setup runs), then saves what the bootstrap does not
 * overwrite through the DataSource's own Settings writers (profile; the persona's activations and level; the edited
 * policy as v2 "Set during onboarding"), saves the first-scan request in `user_settings` key `onboarding` (the worker
 * reads it: src/worker/first-scan-config.ts), and deletes the draft. Nothing here calls an external system; the Sources step only reads status.
 */
import { readFileSync } from 'node:fs';

import { and, eq, sql } from 'drizzle-orm';

import { FirstScanRequest, type DetectionSpend, type IdentityDetection, type IdentityKind, type OnboardingCompleteResult, type OnboardingReason, type OnboardingSourcesPayload, type OnboardingState, type RouteInput, type RouteOutput, type SaveOnboardingStepRequest, type Settings } from '@/contract';
import { actors, withChangeSet } from '@/db/changeset';
import type { Db } from '@/db/client';
import { insertLlmCall, ledgerHash } from '@/db/ledger';
import { priorityPolicies, users } from '@/db/schema';
import { profilePath } from '@/ops/paths';
import { applyDetections, applyStep, bootstrapInput, buildState, finalChoices, freshStored, personaPatch, prefillPersona, prefillYou, rolePacks, same } from '@/server/onboarding/core';
import { onboardingCost } from '@/server/onboarding/cost';
import { FileDraftStore, type DraftStore } from '@/server/onboarding/drafts';
import { savedFirstScan, startFirstScan, type FirstScanStarter } from '@/server/onboarding/first-scan';
import { IDENTITY_SKILL, LiveIdentityDetector, type IdentityDetector } from '@/server/onboarding/identity';
import { simulatedSources, SourceProbe } from '@/server/onboarding/sources';
import { localDay } from '@/engines/activity/time';
import { loadSkill } from '@/llm/skill-loader';
import { randomUUID } from 'node:crypto';
import { AppError, invalid } from '@/server/errors';

import { BootstrapError, bootstrapUser, profileFromSetupFile, type BootstrapProfileInput } from './bootstrap';
import { putKv } from './ext';
import { recordFirstScanHold } from './spend';
import { META_KEY, settingsKey, type Section } from './store/settings';

/** `user_settings` key of the onboarding record (the worker reads `firstScan` from it: src/worker/first-scan-config.ts). */
export const ONBOARDING_KEY = 'onboarding';

export interface OnboardingRecord {
  status: 'complete';
  completedAt: string;
  by: 'web';
  firstScan: FirstScanRequest;
}

/** The Settings writers of the DataSource (the same code paths as Settings ▸ Profile and ▸ Priority policy). */
export interface OnboardingWriters {
  getSettings(): Promise<Settings>;
  patchSettings(i: RouteInput<'patchSettings'>): Promise<RouteOutput<'patchSettings'>>;
  applyPolicy(i: RouteInput<'applyPolicy'>): Promise<RouteOutput<'applyPolicy'>>;
}

export interface DbOnboardingOptions {
  /** Where the unfinished draft waits (default: `<CC_STATE_DIR>/onboarding.json` for this database). */
  drafts?: DraftStore;
  /** Sources status (default: the shared probe of this process; tests inject a fake). */
  probe?: SourceProbe;
  starter?: FirstScanStarter;
  /** `profile.json` from `npm run setup`, used to prefill step 1 (default: the state folder's). */
  setupProfile?: () => Partial<BootstrapProfileInput> | null;
  /** Slack / Org62 id lookups on the Sources step (default: live, read-only; `null` or CC_ONBOARDING_DETECT=off: none). */
  detector?: IdentityDetector | null;
}

const REQUIRED_SECTIONS: Section[] = ['profile', 'agentBehavior', 'sending', 'budgets', 'display'];

/** One probe per process (every route bundle's DataSource shares it, so the 2-minute cache holds). */
function sharedProbe(): SourceProbe {
  const g = globalThis as { __ccOnboardingProbe?: SourceProbe };
  if (process.env.CC_SOURCES_PROBE === 'off') return (g.__ccOnboardingProbe ??= new SourceProbe(async () => notChecked(new Date())));
  return (g.__ccOnboardingProbe ??= new SourceProbe());
}

/** CC_SOURCES_PROBE=off: nothing is run; every row shows its command (describe() runs nothing). */
function notChecked(now: Date): OnboardingSourcesPayload {
  const p = simulatedSources([], now);
  return { ...p, sources: p.sources.map((x) => ({ ...x, message: 'Not checked on this server (CC_SOURCES_PROBE=off).' })) };
}

function readSetupProfile(): Partial<BootstrapProfileInput> | null {
  try {
    return profileFromSetupFile(JSON.parse(readFileSync(profilePath(), 'utf8')) as Record<string, unknown>);
  } catch {
    return null;
  }
}

interface Who {
  user: { id: string; email: string; name: string | null; timezone: string } | null;
  complete: boolean;
  reason: OnboardingReason;
  record: OnboardingRecord | null;
  dailyHardUsd: number | null;
}

export class DbOnboarding {
  private database: Promise<string> | null = null;
  private readonly starter: FirstScanStarter;
  private readonly probe: SourceProbe;
  private readonly setupProfile: () => Partial<BootstrapProfileInput> | null;
  private readonly detector: IdentityDetector | null;
  private store: DraftStore | null;

  constructor(
    private readonly db: Db,
    private readonly now: () => Date,
    private readonly writers: OnboardingWriters,
    opts: DbOnboardingOptions = {},
  ) {
    this.starter = opts.starter ?? savedFirstScan();
    this.probe = opts.probe ?? sharedProbe();
    this.setupProfile = opts.setupProfile ?? readSetupProfile;
    this.detector = opts.detector !== undefined ? opts.detector : process.env.CC_ONBOARDING_DETECT === 'off' ? null : new LiveIdentityDetector();
    this.store = opts.drafts ?? null;
  }

  private dbName(): Promise<string> {
    this.database ??= this.db.execute<{ name: string }>(sql`select current_database() as name`).then((r) => r.rows[0]!.name);
    return this.database;
  }

  private async drafts(): Promise<DraftStore> {
    this.store ??= new FileDraftStore(await this.dbName());
    return this.store;
  }

  /** Who this database serves, and whether they still have to onboard. Cheap: the gate calls it on every load. */
  async who(): Promise<Who> {
    const byId = process.env.CC_USER_ID;
    const rows = await this.db
      .select({ id: users.id, email: users.email, name: users.displayName, timezone: users.timezone })
      .from(users)
      .where(byId ? eq(users.id, byId) : eq(users.isActive, true))
      .limit(2);
    if (!rows.length) return { user: null, complete: false, reason: 'no_user', record: null, dailyHardUsd: null };
    if (rows.length > 1) throw new AppError('internal', 'CC_DATA=db: several users; set CC_USER_ID', undefined, false);
    const user = rows[0]!;
    const kv = await this.db.execute<{ key: string; value: unknown }>(
      sql`select key, value from user_settings where owner_user_id = ${user.id} and (key in (${ONBOARDING_KEY}, ${META_KEY}) or key like 'settings.%')`,
    );
    const map = new Map(kv.rows.map((r) => [r.key, r.value]));
    const rec = map.get(ONBOARDING_KEY) as OnboardingRecord | undefined;
    const budgets = map.get(settingsKey('budgets')) as { hardUsd?: number } | undefined;
    const dailyHardUsd = typeof budgets?.hardUsd === 'number' ? budgets.hardUsd : null;
    if (rec?.status === 'complete') return { user, complete: true, reason: 'onboarded', record: rec, dailyHardUsd };
    const [pol] = await this.db.select({ id: priorityPolicies.id }).from(priorityPolicies).where(and(eq(priorityPolicies.ownerUserId, user.id), eq(priorityPolicies.status, 'active'))).limit(1);
    const bootstrapped = !!pol && map.has(META_KEY) && REQUIRED_SECTIONS.every((s) => map.has(settingsKey(s)));
    return { user, complete: bootstrapped, reason: bootstrapped ? 'cli' : 'incomplete_user', record: null, dailyHardUsd };
  }

  private prefill(w: Who) {
    return prefillYou({ user: w.user ? { email: w.user.email, name: w.user.name, timezone: w.user.timezone } : null, setupProfile: this.setupProfile(), envEmail: process.env.CC_USER_EMAIL ?? null });
  }

  /** `profile.json`'s persona (npm run setup --headless writes one), else none: the role step asks. */
  private prefillPersona() {
    const sp = this.setupProfile();
    return prefillPersona({ persona: sp?.persona ?? null, role: sp?.role ?? null });
  }

  private async fresh(w: Who, now: Date) {
    return freshStored(await this.dbName(), this.prefill(w), now, this.prefillPersona());
  }

  private async stateFrom(w: Who): Promise<OnboardingState> {
    const now = this.now();
    const stored = w.complete ? null : (await this.drafts()).load();
    return buildState({
      mode: 'db',
      required: !w.complete,
      status: w.complete ? 'complete' : stored ? 'in_progress' : 'not_started',
      reason: w.reason,
      stored,
      prefill: this.prefill(w),
      prefillPersona: this.prefillPersona(),
      locked: w.user && !w.complete ? ['email'] : [],
      packs: rolePacks(now),
      cost: onboardingCost(w.dailyHardUsd ?? 15),
      completedAt: w.record?.completedAt ?? null,
      firstScan: w.record?.firstScan ?? null,
      detection: this.detector?.mode ?? 'off',
    });
  }

  async state(): Promise<OnboardingState> {
    const w = await this.who();
    // warm the Sources step's slow check (claude mcp list) while the first steps are filled in
    if (!w.complete) void this.probe.get().catch(() => undefined);
    return this.stateFrom(w);
  }

  async save(req: SaveOnboardingStepRequest): Promise<OnboardingState> {
    const w = await this.who();
    if (w.complete) throw invalid('This database is already set up. Change your choices in Settings.', { reason: w.reason });
    if (req.step === 'sources' && req.value.detect?.length) return this.detect(w, req.value.detect);
    const store = await this.drafts();
    const now = this.now();
    const cur = store.load() ?? (await this.fresh(w, now));
    store.save(applyStep(cur, req, { now, packs: rolePacks(now), lockedEmail: w.user?.email ?? null }));
    return this.stateFrom(w);
  }

  async sources(refresh: boolean): Promise<OnboardingSourcesPayload> {
    return this.probe.get(refresh);
  }

  /**
   * The Sources step's id lookups: only for a connected source, in parallel, read-only (src/server/onboarding/
   * identity.ts). The draft is read again afterwards (it may have moved on meanwhile) and only the outcomes, the
   * spend and still-empty ids are merged in; the step does not move. The spend reaches the ledger when you finish.
   */
  private async detect(w: Who, kinds: IdentityKind[]): Promise<OnboardingState> {
    const store = await this.drafts();
    const now = this.now();
    const cur0 = store.load() ?? (await this.fresh(w, now));
    if (!this.detector) return this.stateFrom(w);
    const email = (w.user?.email ?? cur0.draft.you.email ?? '').trim().toLowerCase();
    const sources = await this.probe.get().catch(() => null);
    const state = new Map((sources?.sources ?? []).map((x) => [x.id, x.state]));
    const at = () => this.now().toISOString();
    const results = await Promise.all(
      [...new Set(kinds)].map(async (kind): Promise<{ kind: IdentityKind; detection: IdentityDetection; spend: DetectionSpend | null }> => {
        const label = kind === 'slack' ? 'Slack' : 'Org62';
        if (state.get(kind) !== 'ok') return { kind, detection: { status: 'not_connected', id: null, name: null, message: `Sign in to ${label} first, then Detect again.`, at: at(), costUsd: 0, simulated: false }, spend: null };
        try {
          return { kind, ...(await this.detector!.detect(kind, { email, name: cur0.draft.you.name ?? null })) };
        } catch {
          return { kind, detection: { status: 'failed', id: null, name: null, message: 'The lookup did not finish.', at: at(), costUsd: 0, simulated: false }, spend: null };
        }
      }),
    );
    const cur = store.load() ?? cur0;
    store.save(applyDetections(cur, results, this.now()));
    return this.stateFrom(w);
  }

  async complete(): Promise<OnboardingCompleteResult> {
    const w0 = await this.who();
    if (w0.complete) {
      if (w0.reason === 'onboarded' && w0.record) {
        const s = await this.writers.getSettings();
        return { state: await this.stateFrom(w0), bootstrap: 'up_to_date', wrote: [], policyVersion: s.policy.version, firstScan: w0.record.firstScan, redirect: '/' };
      }
      throw invalid('This database is already set up (npm run setup). Change your choices in Settings.', { reason: w0.reason });
    }
    const now = this.now();
    const store = await this.drafts();
    const packs = rolePacks(now);
    const cur = store.load() ?? (await this.fresh(w0, now));
    if (w0.user) cur.draft.you.email = w0.user.email;
    const { role, you, priorities, history } = finalChoices(cur.draft, packs);

    // 1. the same bootstrap `npm run setup --headless` runs: user, me, identities, team pack, every section (the
    //    persona's id and level), the persona template's policy v1, meta
    let boot;
    try {
      boot = await bootstrapUser({ db: this.db, profile: bootstrapInput(you, role), now });
    } catch (e) {
      if (e instanceof BootstrapError) throw invalid(e.message);
      throw e;
    }
    const wrote = [...boot.wrote];

    // 2. what the bootstrap never overwrites, through the Settings writers (an unfinished user's old values)
    const s = await this.writers.getSettings();
    const profile = { name: you.name, role: you.role, timezone: you.timezone, workingHours: you.workingHours };
    const diff = Object.fromEntries(Object.entries(profile).filter(([k, v]) => !same(v, (s.profile as Record<string, unknown>)[k])));
    if (Object.keys(diff).length) {
      await this.writers.patchSettings({ params: { section: 'profile' }, body: { ifVersion: s.profile.version, value: diff } });
      wrote.push('settings.profile');
    }
    // the sources you activated (persona overrides), and an unfinished user's old persona or level
    const pp = personaPatch(s.persona, role);
    if (Object.keys(pp).length) {
      await this.writers.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: pp } });
      wrote.push('settings.persona');
    }
    // a persona switch reseeds the starter policy (src/server/persona/switch.ts): compare with the policy as it is now
    const pol = Object.keys(pp).length ? (await this.writers.getSettings()).policy : s.policy;
    let policyVersion = pol.version;
    if (!same(pol.weights, priorities.weights) || !same(pol.rules, priorities.rules)) {
      const r = await this.writers.applyPolicy({ body: { weights: priorities.weights, rules: priorities.rules, note: 'Set during onboarding', ifVersion: pol.version } });
      policyVersion = r.entity.version;
      wrote.push(`policy@v${policyVersion}`);
    }

    // 3. the first scan (the worker reads it from the onboarding record) and the record itself
    const firstScan = FirstScanRequest.parse(await startFirstScan({ lookbackDays: history.lookbackDays, budgetUsd: history.budgetUsd, at: now }, this.starter));
    const record: OnboardingRecord = { status: 'complete', completedAt: now.toISOString(), by: 'web', firstScan };
    await withChangeSet({ db: this.db, userId: boot.userId, actor: actors.system('onboarding'), kind: 'system', reason: 'Onboarding finished', undoable: false }, async (tx) => {
      await putKv(tx, boot.userId, ONBOARDING_KEY, record);
      // the id lookups' spend, into the ledger like every other LLM call (there was no user to own it before)
      await recordDetectionSpend(tx as unknown as Db, boot.userId, you.timezone, cur.draft.spend);
    });
    // COST-9: the first scan's estimate, recorded as its hold (the one-time first-scan budget, never the day's)
    await recordFirstScanHold(this.db, boot.userId, history.lookbackDays, now).catch(() => undefined);
    if (cur.draft.spend.length) wrote.push(`llm_calls×${cur.draft.spend.length}`);
    wrote.push(ONBOARDING_KEY);
    store.clear();

    const w = await this.who();
    return { state: await this.stateFrom(w), bootstrap: boot.status, wrote, policyVersion, firstScan, redirect: '/' };
  }
}

/** One `llm_calls` row per id lookup (purpose resolve_entity, skill detect-identity), plus the day's budget roll-up. */
export async function recordDetectionSpend(db: Db, userId: string, timezone: string, spend: DetectionSpend[]): Promise<void> {
  if (!spend.length) return;
  let version = '1';
  try {
    version = loadSkill(IDENTITY_SKILL).frontmatter.version;
  } catch {
    /* the version is a label only */
  }
  for (const s of spend) {
    const started = new Date(s.startedAt);
    const day = localDay(started.getTime(), timezone);
    await insertLlmCall(db, {
      ownerUserId: userId,
      purpose: 'resolve_entity',
      model: s.model,
      skillKey: 'detect-identity',
      promptVersion: version,
      requestHash: `identity:${s.kind}:${randomUUID()}`,
      status: s.status,
      errorCode: s.errorCode,
      inputTokens: s.inputTokens,
      outputTokens: s.outputTokens,
      costUsd: s.costUsd,
      latencyMs: s.ms,
      budgetDay: day,
      startedAt: started,
      finishedAt: new Date(started.getTime() + s.ms),
      // Onboarding ▸ Sources ▸ Detect: the user asked for each lookup.
      trigger: 'user_action',
      modelReason: 'default',
      contentHash: ledgerHash(s.model, version, 'detect-identity', s.kind),
      outcome: s.status,
    });
  }
}
