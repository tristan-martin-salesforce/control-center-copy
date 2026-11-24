/**
 * The mock DataSource, settings domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { I, Res } from '../shared';
import { personaOf } from '@/personas';
import { personaSwitched, reseededPolicy, timeWithoutRecordType } from '@/server/persona/switch';
import { type PolicyPreview, type PolicyRule, type PolicyWeights, type PriorityPolicy, type Settings, budgetsForDay, raiseBudgetToday, raiseSummary, SETTINGS_SECTION_SCHEMAS } from '@/contract';
import { DELEGATED_RULES, RETENTION_SETTINGS_KEY, resolveRetention, SQL_RULES } from '@/db/retention/policy';
import type { RetentionSettings } from '@/contract/settings';
import { invalid, notFound } from '@/server/errors';
import { sendingConfirmNeeded } from '@/outbox/settings';
import { computeRanking, scoreItem, storedOrder, toRankRows } from '../rank';
import { Tx } from '../store';

export class MockSettings {
  constructor(private readonly ctx: MockCtx) {}

  async getSettings(_i: I<'getSettings'>): Promise<Res<'getSettings'>> {
    return this.ctx.store.settings();
  }

  async patchSettings({ params, body }: I<'patchSettings'>): Promise<Res<'patchSettings'>> {
    const s = this.ctx.store.settings();
    const section = params.section;
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
    }
    const merged = section === 'sending' ? this.ctx.ds.outbox.mergeSending(s.sending, value) : { ...cur, ...value };
    const next: Settings = { ...s, [section]: { ...merged, version: cur.version + 1 } };
    if (section === 'persona' && personaSwitched(s, next)) {
      // D-55: the new role's starter policy as a new version (reranked), and the record-type override cleared, in one
      // audit entry: Undo puts the persona, the policy and the ranking back
      const at = this.ctx.nowIso();
      const { policy } = reseededPolicy(s.policy, personaOf(next), at);
      const time = timeWithoutRecordType(s.time);
      const after: Settings = { ...next, policy, ...(time ? { time } : {}) };
      const r = this.ctx.ds.today.rerankAll('user', `settings.${section}`, `Saved ${section} settings`, policy, (tx) => {
        tx.put('settings', after);
        tx.put('policyVersions', { version: policy.version, at, by: 'user', note: policy.note ?? 'Role pack', policy });
      }, { type: 'settings', id: section, label: `Settings · ${section}` });
      return { entity: after, auditId: r.entry?.id ?? null };
    }
    const { entry } = this.ctx.tx({ actor: 'user', action: `settings.${section}`, summary: `Saved ${section} settings`, entity: { type: 'settings', id: section, label: `Settings · ${section}` } }, (tx) => {
      tx.put('settings', next);
      if (section === 'budgets') {
        const sp = this.ctx.store.spend();
        const eff = budgetsForDay(next.budgets, new Intl.DateTimeFormat('en-CA', { timeZone: next.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.ctx.now()));
        const pct = eff.softUsd > 0 ? Math.round((sp.today.usd / eff.softUsd) * 100) : 0;
        tx.put('spend', { ...sp, today: { ...sp.today, softBudgetUsd: eff.softUsd, hardCapUsd: eff.hardUsd, pct }, state: sp.today.usd >= eff.hardUsd ? 'capped' : pct >= next.budgets.alertPct ? 'soft_alert' : 'ok' });
      }
    });
    return { entity: next, auditId: entry?.id ?? null };
  }

  /** "Raise today's cap" with a reason: today's override goes up and the raise is kept (raiseBudgetToday, contract). */
  async raiseBudgetToday({ body }: I<'raiseBudgetToday'>): Promise<Res<'raiseBudgetToday'>> {
    const s = this.ctx.store.settings();
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: s.profile.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(this.ctx.now());
    let out: ReturnType<typeof raiseBudgetToday>;
    try {
      out = raiseBudgetToday(s.budgets, body, day, this.ctx.nowIso());
    } catch (e) {
      throw invalid(e instanceof Error ? e.message : String(e));
    }
    const { next: budgets, raise } = out;
    const { entry } = this.ctx.tx({ actor: 'user', action: 'settings.budgets', summary: raiseSummary(raise), entity: { type: 'settings', id: 'budgets', label: 'Settings · budgets' } }, (tx) => {
      tx.put('settings', { ...s, budgets });
      const sp = this.ctx.store.spend();
      const pct = raise.toSoftUsd > 0 ? Math.round((sp.today.usd / raise.toSoftUsd) * 100) : 0;
      tx.put('spend', { ...sp, today: { ...sp.today, softBudgetUsd: raise.toSoftUsd, hardCapUsd: raise.toHardUsd, pct }, state: sp.today.usd >= raise.toHardUsd ? 'capped' : pct >= budgets.alertPct ? 'soft_alert' : 'ok' });
    });
    return { entity: budgets, auditId: entry?.id ?? null };
  }

  // Settings ▸ Data: the retention horizons and "Run retention now", faked over the mock's own records. The only
  // mock table the policy reaches is the event log (acknowledged events past `eventsDays`); the rest report 0 rows.
  private retention: RetentionSettings = resolveRetention(undefined);

  async getRetention(_i: I<'getRetention'>): Promise<Res<'getRetention'>> {
    return { ...this.retention };
  }

  async patchRetention({ body }: I<'patchRetention'>): Promise<Res<'patchRetention'>> {
    this.retention = resolveRetention({ ...this.retention, ...body });
    this.ctx.publish(['settings'], [RETENTION_SETTINGS_KEY], 'retention.patch');
    return { ...this.retention };
  }

  async runRetention({ body }: I<'runRetention'>): Promise<Res<'runRetention'>> {
    const cfg = this.retention;
    const cutoff = this.ctx.now().getTime() - cfg.eventsDays * 86_400_000;
    const stale = this.ctx.store.all('eventLog').filter((e) => e.acknowledged && Date.parse(e.lastSeenAt ?? e.at) < cutoff);
    if (!body.dry && stale.length) this.ctx.tx({ actor: 'system', action: 'data.retention', summary: `Retention removed ${stale.length} old events`, entity: { type: 'settings', id: RETENTION_SETTINGS_KEY, label: 'Settings · data' }, undoable: false }, (tx) => stale.forEach((e) => tx.remove('eventLog', e.id)));
    const ROW_BYTES = 512;
    const tables = [
      ...SQL_RULES.map((r) => ({ rule: r.id, table: r.table, action: r.action, rows: r.id === 'events_resolved' ? stale.length : 0 })),
      ...DELEGATED_RULES.map((r) => ({ rule: r.id, table: r.table, action: 'delete', rows: null, note: r.describe })),
    ];
    const before = this.ctx.store.all('eventLog').length * ROW_BYTES + (body.dry ? 0 : stale.length * ROW_BYTES);
    return { dry: body.dry, tables, bytesBefore: before, bytesAfter: body.dry ? before : before - stale.length * ROW_BYTES, estimatedReclaimBytes: stale.length * ROW_BYTES, settings: { ...cfg } };
  }

  private proposedPolicy(weights?: PolicyWeights, rules?: PolicyRule[]): PriorityPolicy {
    const pol = this.ctx.store.settings().policy;
    return { ...pol, weights: weights ?? pol.weights, rules: rules ?? pol.rules };
  }

  preview(policy: PriorityPolicy): PolicyPreview {
    const now = this.ctx.now();
    const current = storedOrder(this.ctx.store);
    const baseline = current.map((i) => i.id);
    const currentPolicy = this.ctx.store.settings().policy;
    const before = current.slice(0, 10).map((w, i) => {
      const s = scoreItem(w, this.ctx.store, currentPolicy, now);
      return { workItemId: w.id, title: w.title, rank: i + 1, score: s.score, moved: 0, topReason: s.reasons[0]?.label ?? null };
    });
    const after = toRankRows(this.ctx.store, computeRanking(this.ctx.store, policy, now), baseline, 10);
    const changedCount = after.filter((r, i) => before[i]?.workItemId !== r.workItemId).length;
    const lead = after[0];
    return {
      basedOnVersion: currentPolicy.version,
      before,
      after,
      changedCount,
      summary: changedCount ? `${changedCount} of the Top 10 move${lead && lead.workItemId !== before[0]?.workItemId ? `; "${lead.title}" takes #1` : ''}` : 'No change to the Top 10',
    };
  }

  async previewPolicy({ body }: I<'previewPolicy'>): Promise<Res<'previewPolicy'>> {
    return this.preview(this.proposedPolicy(body.weights as PolicyWeights | undefined, body.rules));
  }

  applyPolicyInternal(weights: PolicyWeights, rules: PolicyRule[], note: string, by: 'user' | 'chat' | 'system', extra?: (tx: Tx) => void) {
    const s = this.ctx.store.settings();
    const pol: PriorityPolicy = { ...s.policy, version: s.policy.version + 1, weights, rules, updatedAt: this.ctx.nowIso(), note };
    const r = this.ctx.ds.today.rerankAll(by === 'system' ? 'system' : by, 'policy.apply', `Policy v${pol.version}: ${note}`, pol, (tx) => {
      tx.put('settings', { ...s, policy: pol });
      tx.put('policyVersions', { version: pol.version, at: this.ctx.nowIso(), by, note, policy: pol });
      extra?.(tx);
    });
    const receipt = this.ctx.receiptFrom(r.entry, r.ops, by === 'chat' ? 'chat' : 'user', `Policy v${pol.version} applied: ${r.result.changed} of the Top 10 moved`, (op, f) => (op.col === 'workItems' ? f === 'rank' : op.col === 'settings'));
    return { ...r, policy: pol, receipt };
  }

  async applyPolicy({ body }: I<'applyPolicy'>): Promise<Res<'applyPolicy'>> {
    const cur = this.ctx.store.settings().policy;
    this.ctx.checkVersion(cur, body.ifVersion, 'Priority policy', cur);
    const r = this.applyPolicyInternal(body.weights as PolicyWeights, body.rules, body.note ?? 'Edited in Settings', 'user');
    return { entity: r.policy, auditId: r.entry?.id ?? null, receipt: r.receipt };
  }

  async revertPolicy({ body }: I<'revertPolicy'>): Promise<Res<'revertPolicy'>> {
    const cur = this.ctx.store.settings().policy;
    this.ctx.checkVersion(cur, body.ifVersion, 'Priority policy', cur);
    const target = this.ctx.store.get('policyVersions', String(body.toVersion));
    if (!target) throw notFound('Policy version', String(body.toVersion));
    const r = this.applyPolicyInternal(target.policy.weights, target.policy.rules, `Reverted to v${body.toVersion}`, 'user');
    return { entity: r.policy, auditId: r.entry?.id ?? null, receipt: r.receipt };
  }

  async getPolicyVersions(_i: I<'getPolicyVersions'>): Promise<Res<'getPolicyVersions'>> {
    return { current: this.ctx.store.settings().policy.version, versions: this.ctx.store.all('policyVersions').sort((a, b) => b.version - a.version) };
  }
}
