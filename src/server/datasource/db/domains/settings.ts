/**
 * The db DataSource, settings domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res } from '../shared';
import { eq } from 'drizzle-orm';
import { type PolicyPreview, type PolicyRule, type PolicyWeights, type PriorityPolicy, type Settings, type WorkItemRecord, budgetsForDay, raiseBudgetToday, raiseSummary, SETTINGS_SECTION_SCHEMAS } from '@/contract';
import { RETENTION_SETTINGS_KEY, resolveRetention } from '@/db/retention/policy';
import { loadRetentionSettings, runDataRetention } from '@/db/retention/run';
import { localDay as localDayOf } from '@/engines/activity/time';
import { changeSets } from '@/db/schema';
import { personaOf } from '@/personas';
import { invalid, notFound } from '@/server/errors';
import { receiptFromChangeSet } from '../audit';
import type { ReadModel } from '../model';
import { SETTINGS } from '../reads/scope';
import { storedOrderFrom } from '../rank';
import { writeKv } from '../store/common';
import { writeSpend } from '../store/health';
import { insertPolicyVersion, writeSection, type Section } from '../store/settings';
import { isRecordTypeKv } from '@/server/chat/record-type';
import { personaSwitched, reseededPolicy, timeWithoutRecordType } from '@/server/persona/switch';
import { recomputeWeeks } from '@/projections/run';
import { mergeSendingPatch, sendingConfirmNeeded } from '@/outbox';
import { projectionStore } from '../store/projections.run';

export class DbSettings {
  constructor(private readonly ctx: DbCtx) {}

  async getSettings(_i: I<'getSettings'>): Promise<Res<'getSettings'>> {
    return this.ctx.read(SETTINGS, (m) => m.settings());
  }

  async patchSettings({ params, body }: I<'patchSettings'>): Promise<Res<'patchSettings'>> {
    const section = params.section as Section;
    // D-55: a persona switch reranks under the new role's starter policy (ranked before the change set)
    const rankedIds = section === 'persona' ? await this.ctx.ds.today.rankedIds() : [];
    const r = await this.ctx.mutate({ action: `settings.${section}`, summary: `Saved ${section} settings`, entity: { type: 'settings', id: section }, current: async () => (await this.ctx.model(WHOLE)).settings() }, async (w, model) => {
      const s = model.settings();
      const cur = s[section];
      this.ctx.checkVersion(cur, body.ifVersion, `Settings (${section})`, s);
      const parsed = SETTINGS_SECTION_SCHEMAS[section].safeParse(body.value);
      if (!parsed.success) throw invalid(`Invalid ${section} settings: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, { issues: parsed.error.issues });
      const value = parsed.data as Record<string, unknown>;
      if (section === 'sending' && !body.confirm) {
      const need = sendingConfirmNeeded(s.sending, value);
      if (need) throw invalid(need, { confirmRequired: true });
    }
      if (section === 'budgets') {
        const soft = (value.softUsd as number | undefined) ?? s.budgets.softUsd;
        const hard = (value.hardUsd as number | undefined) ?? s.budgets.hardUsd;
        if (soft > hard) throw invalid('Soft budget cannot exceed the hard cap');
        const t = value.today as { softUsd: number; hardUsd: number } | null | undefined;
        if (t && t.softUsd > t.hardUsd) throw invalid("Today's soft budget cannot exceed today's hard cap");
      }
      const merged = section === 'sending' ? mergeSendingPatch(s.sending, value) : section === 'time' ? { ...cur, ...value, onsiteHours: { ...s.time.onsiteHours, ...((value.onsiteHours as object | undefined) ?? {}) } } : { ...cur, ...value };
      const next: Settings = { ...s, [section]: { ...merged, version: cur.version + 1 } };
      await writeSection(w, section, next[section]);
      if (section === 'persona' && personaSwitched(s, next)) {
        // D-55: the new role's starter policy as a new version, and the record-type cache cleared; Undo reverts all
        const at = this.ctx.now().toISOString();
        const { policy, obligation } = reseededPolicy(s.policy, personaOf(next), at);
        const rowId = await insertPolicyVersion(w, policy, { at, by: 'user', note: policy.note ?? 'Role pack', activate: true, changeSetId: w.cs.id, obligation });
        await this.ctx.ds.today.rerankIn(w, model, policy, rankedIds, this.ctx.now(), rowId);
        const time = timeWithoutRecordType(s.time);
        if (time) await writeSection(w, 'time', time);
        for (const k of [...w.kv.keys()].filter(isRecordTypeKv)) await writeKv(w, k, null);
      }
      if (section === 'budgets') {
        const sp = model.spend();
        const eff = budgetsForDay(next.budgets, localDayOf(this.ctx.now().getTime(), s.profile.timezone));
        const pct = eff.softUsd > 0 ? Math.round((sp.today.usd / eff.softUsd) * 100) : 0;
        await writeSpend(w, { ...sp, today: { ...sp.today, softBudgetUsd: eff.softUsd, hardCapUsd: eff.hardUsd, pct }, state: sp.today.usd >= eff.hardUsd ? 'capped' : pct >= next.budgets.alertPct ? 'soft_alert' : 'ok' });
      }
    });
    // Settings ▸ Time changes what onsite days log: the recent weeks (and the next one) recompute in the background
    if (section === 'time') {
      const now = this.ctx.now();
      const days = Array.from({ length: 8 }, (_, i) => new Date(now.getTime() + (1 - i) * 7 * 86_400_000).toISOString().slice(0, 10));
      void this.ctx.userId()
        .then((userId) => recomputeWeeks({ store: projectionStore(this.ctx.db), userId, days, now }))
        .then(() => this.ctx.bus.publishTables(['activity_entries'], [], 'settings.time'))
        .catch(() => undefined);
    }
    return { entity: (await this.ctx.model(WHOLE)).settings(), auditId: r.auditId };
  }

  /** "Raise today's cap" with a reason: today's override goes up and the raise is kept (raiseBudgetToday, contract). */
  async raiseBudgetToday({ body }: I<'raiseBudgetToday'>): Promise<Res<'raiseBudgetToday'>> {
    const raiseIn = (s: Settings) => {
      try {
        return raiseBudgetToday(s.budgets, body, localDayOf(this.ctx.now().getTime(), s.profile.timezone), this.ctx.now().toISOString());
      } catch (e) {
        throw invalid(e instanceof Error ? e.message : String(e));
      }
    };
    const first = raiseIn((await this.ctx.model(WHOLE)).settings()).raise;
    const r = await this.ctx.mutate({ action: 'settings.budgets', summary: raiseSummary(first), entity: { type: 'settings', id: 'budgets' }, current: async () => (await this.ctx.model(WHOLE)).settings() }, async (w, model) => {
      const { next: budgets, raise } = raiseIn(model.settings());
      await writeSection(w, 'budgets', budgets);
      const sp = model.spend();
      const pct = raise.toSoftUsd > 0 ? Math.round((sp.today.usd / raise.toSoftUsd) * 100) : 0;
      await writeSpend(w, { ...sp, today: { ...sp.today, softBudgetUsd: raise.toSoftUsd, hardCapUsd: raise.toHardUsd, pct }, state: sp.today.usd >= raise.toHardUsd ? 'capped' : pct >= budgets.alertPct ? 'soft_alert' : 'ok' });
    });
    return { entity: (await this.ctx.model(WHOLE)).settings().budgets, auditId: r.auditId };
  }

  // Settings ▸ Data: the retention horizons (user_settings key `retention`) and "Run retention now" (p4-retention's
  // runDataRetention, forced so it runs even with the nightly job off). Local app data only: nothing external.
  async getRetention(_i: I<'getRetention'>): Promise<Res<'getRetention'>> {
    return loadRetentionSettings(this.ctx.db, await this.ctx.userId());
  }

  async patchRetention({ body }: I<'patchRetention'>): Promise<Res<'patchRetention'>> {
    const next = resolveRetention({ ...(await this.getRetention({} as I<'getRetention'>)), ...body });
    // one undoable change set on user_settings `retention` (the audit trigger needs one)
    await this.ctx.mutate({ action: 'settings.retention', summary: next.enabled ? 'Saved data retention settings' : 'Turned off nightly data retention', entity: { type: 'settings', id: RETENTION_SETTINGS_KEY } }, async (w) => {
      await writeKv(w, RETENTION_SETTINGS_KEY, next);
    });
    return next;
  }

  async runRetention({ body }: I<'runRetention'>): Promise<Res<'runRetention'>> {
    return runDataRetention(this.ctx.db, await this.ctx.userId(), { dry: body.dry, force: true });
  }

  private proposedPolicy(m: ReadModel, weights?: PolicyWeights, rules?: PolicyRule[]): PriorityPolicy {
    const pol = m.settings().policy;
    return { ...pol, weights: weights ?? pol.weights, rules: rules ?? pol.rules };
  }

  preview(m: ReadModel, ordered: WorkItemRecord[], policy: PriorityPolicy): PolicyPreview {
    return this.ctx.ranker.preview(m, ordered, policy, this.ctx.now());
  }

  async previewPolicy({ body }: I<'previewPolicy'>): Promise<Res<'previewPolicy'>> {
    const m = await this.ctx.model(WHOLE);
    const ordered = storedOrderFrom(m, await this.ctx.ds.today.rankedIds());
    return this.preview(m, ordered, this.proposedPolicy(m, body.weights as PolicyWeights | undefined, body.rules));
  }

  async applyPolicyInternal(weights: PolicyWeights, rules: PolicyRule[], note: string, by: 'user' | 'chat' | 'system', ifVersion: number) {
    const now = this.ctx.now();
    const rankedIds = await this.ctx.ds.today.rankedIds();
    let policy: PriorityPolicy | null = null;
    let changed = 0;
    const r = await this.ctx.mutate({ action: 'policy.apply', summary: 'Policy applied', entity: { type: 'policy', id: 'policy' }, current: async () => (await this.ctx.model(WHOLE)).settings().policy }, async (w, model) => {
      const s = model.settings();
      this.ctx.checkVersion(s.policy, ifVersion, 'Priority policy', s.policy);
      const pol: PriorityPolicy = { ...s.policy, version: s.policy.version + 1, weights, rules, updatedAt: now.toISOString(), note };
      policy = pol;
      await w.tx.update(changeSets).set({ summary: `Policy v${pol.version}: ${note}`, entityId: pol.id }).where(eq(changeSets.id, w.cs.id));
      const rowId = await insertPolicyVersion(w, pol, { at: now.toISOString(), by, note, activate: true, changeSetId: w.cs.id });
      const res = await this.ctx.ds.today.rerankIn(w, model, pol, rankedIds, now, rowId);
      changed = res.result.changed;
    });
    const m = await this.ctx.model(WHOLE);
    const receipt = await receiptFromChangeSet(this.ctx.db, r.auditId, m, by === 'chat' ? 'chat' : 'user', `Policy v${policy!.version} applied: ${changed} of the Top 10 moved`, now.toISOString(), (table, field) => (table === 'work_items' ? field === 'rank' : table === 'priority_policies'));
    return { policy: m.settings().policy, auditId: r.auditId, receipt };
  }

  async applyPolicy({ body }: I<'applyPolicy'>): Promise<Res<'applyPolicy'>> {
    const r = await this.applyPolicyInternal(body.weights as PolicyWeights, body.rules, body.note ?? 'Edited in Settings', 'user', body.ifVersion);
    return { entity: r.policy, auditId: r.auditId, receipt: r.receipt };
  }

  async revertPolicy({ body }: I<'revertPolicy'>): Promise<Res<'revertPolicy'>> {
    const m = await this.ctx.model(WHOLE);
    const target = m.get('policyVersions', String(body.toVersion));
    if (!target) throw notFound('Policy version', String(body.toVersion));
    const r = await this.applyPolicyInternal(target.policy.weights, target.policy.rules, `Reverted to v${body.toVersion}`, 'user', body.ifVersion);
    return { entity: r.policy, auditId: r.auditId, receipt: r.receipt };
  }

  async getPolicyVersions(_i: I<'getPolicyVersions'>): Promise<Res<'getPolicyVersions'>> {
    const m = await this.ctx.model(WHOLE);
    return { current: m.settings().policy.version, versions: m.all('policyVersions').sort((a, b) => b.version - a.version) };
  }
}
