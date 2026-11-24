/**
 * Settings sections, the versioned priority policy, and the user meta.
 *
 * Settings sections → user_settings `settings.<section>` (the schema's per-user settings store; each
 *   value carries its contract version). `chat` (CONTRACT-1) defaults to {version: 1, defaultModel: 'sonnet'}
 *   until it is first saved, like the mock.
 * PriorityPolicy → priority_policies (one row per version; exactly one `active`) + priority_policy_rules.
 *   weights → weight_* columns through ../policy-map.ts (the one contract ↔ engine ↔ column mapping;
 *   weight_obligation is engine-only and carries over between versions) · rules → priority_policy_rules (rule_key = rule id, label/explanation = text,
 *   kind boost|penalty, condition = `when`, effect_value = boost) · note → change_summary · version ·
 *   by → source · updatedAt → activated_at. The contract policy id is the first version's row id, so it
 *   stays stable across versions. Ext: name, role, note (when null).
 * Meta (seed meta: asOf, lastActiveAt, quarter, canvas, repo folder) → `cc.meta`. users holds
 *   email / display_name / timezone.
 */
import { and, asc, desc, eq } from 'drizzle-orm';

import type { PolicyRule, PolicyVersion, PolicyWeights, PriorityPolicy, SeedMeta, Settings } from '@/contract';
import { priorityPolicies, priorityPolicyRules, userSettings } from '@/db/schema';

import { policyByFromDb, policyByToDb } from '../enums';
import { contractWeightsFromRow, DEFAULT_OBLIGATION_WEIGHT, weightColumnsFromContract } from '../policy-map';
import { uuidFor } from '../ids';
import { ext, isoReq, writeExt, writeKv, type ReadCtx, type WriteCtx } from './common';

export const SECTIONS = ['profile', 'agentBehavior', 'sending', 'budgets', 'display', 'chat', 'time', 'scanning', 'closing', 'persona', 'feedback', 'guide', 'priority'] as const;
export type Section = (typeof SECTIONS)[number];
export const settingsKey = (s: Section) => `settings.${s}`;

export const META_KEY = 'cc.meta';
export type MetaState = SeedMeta & { rankedAt: string; policyRankVersion: number };

export function readMeta(rc: { kv: Map<string, unknown> }): MetaState | null {
  return (rc.kv.get(META_KEY) as MetaState | undefined) ?? null;
}
export async function writeMeta(w: WriteCtx, m: MetaState) {
  await writeKv(w, META_KEY, m);
}

export async function loadSettingsSections(rc: Pick<ReadCtx, 'db' | 'userId'>): Promise<Partial<Omit<Settings, 'policy'>>> {
  const rows = await rc.db.select().from(userSettings).where(eq(userSettings.ownerUserId, rc.userId));
  const out: Record<string, unknown> = {};
  for (const r of rows) if (r.key.startsWith('settings.')) out[r.key.slice('settings.'.length)] = r.value;
  return out as Partial<Omit<Settings, 'policy'>>;
}

export async function writeSection(w: WriteCtx, section: Section, value: unknown) {
  await writeKv(w, settingsKey(section), value);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

interface PolicyExt {
  name: string;
  role: PriorityPolicy['role'];
  noteNull: boolean;
  rootId: string;
}

type PolicyRow = typeof priorityPolicies.$inferSelect;
type RuleRow = typeof priorityPolicyRules.$inferSelect;

function policyFromRows(rc: { kv: Map<string, unknown> }, row: PolicyRow, rules: RuleRow[], rootId: string): PriorityPolicy {
  const x = ext<PolicyExt>(rc, 'priority_policies', row.id);
  const weights: PolicyWeights = contractWeightsFromRow(row);
  return {
    id: rootId,
    version: row.version,
    name: x.name ?? 'Priority policy',
    role: x.role ?? 'se_ic',
    weights,
    rules: rules
      .filter((r) => r.policyId === row.id)
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((r) => ({ id: r.ruleKey, text: r.label, enabled: r.enabled, when: r.condition as PolicyRule['when'], boost: r.effectValue ?? 0 })),
    updatedAt: isoReq(row.activatedAt ?? row.createdAt),
    note: x.noteNull ? null : row.changeSummary,
  };
}

/** Engine-only knobs of the active policy row (no contract field): the obligation weight and the Top 3 size. */
export interface PolicyEngineState {
  obligation: number;
  top3Size: number;
}

export async function loadPolicies(rc: Pick<ReadCtx, 'db' | 'userId' | 'kv'>): Promise<{ current: PriorityPolicy | null; currentRowId: string | null; versions: PolicyVersion[]; engine: PolicyEngineState }> {
  const rows = await rc.db.select().from(priorityPolicies).where(eq(priorityPolicies.ownerUserId, rc.userId)).orderBy(asc(priorityPolicies.version));
  if (!rows.length) return { current: null, currentRowId: null, versions: [], engine: { obligation: DEFAULT_OBLIGATION_WEIGHT, top3Size: 3 } };
  const rules = await rc.db.select().from(priorityPolicyRules);
  const rootId = rows[0]!.id;
  const active = rows.find((r) => r.status === 'active') ?? rows[rows.length - 1]!;
  const versions: PolicyVersion[] = rows.map((r) => ({
    version: r.version,
    at: isoReq(r.createdAt),
    by: policyByFromDb(r.source),
    note: r.changeSummary,
    policy: policyFromRows(rc, r, rules, rootId),
  }));
  return { current: policyFromRows(rc, active, rules, rootId), currentRowId: active.id, versions, engine: { obligation: Number(active.weightObligation), top3Size: active.top3Size } };
}

/** Insert one policy version row (+ its rules). `activate` retires the previous active row first. */
export async function insertPolicyVersion(w: WriteCtx, p: PriorityPolicy, meta: { at: string; by: PolicyVersion['by']; note: string; activate: boolean; rowId?: string; changeSetId?: string | null; obligation?: number }): Promise<string> {
  const rowId = meta.rowId ?? uuidFor(`${p.id}@v${p.version}`);
  // `obligation` is engine-only (no contract slider): a new version keeps the previous one's
  const [prev] = await w.tx.select({ o: priorityPolicies.weightObligation }).from(priorityPolicies).where(eq(priorityPolicies.ownerUserId, w.userId)).orderBy(desc(priorityPolicies.version)).limit(1);
  if (meta.activate) {
    await w.tx.update(priorityPolicies).set({ status: 'retired', retiredAt: w.now }).where(and(eq(priorityPolicies.ownerUserId, w.userId), eq(priorityPolicies.status, 'active')));
  }
  const weightCols = weightColumnsFromContract(p.weights, meta.obligation ?? (prev ? Number(prev.o) : DEFAULT_OBLIGATION_WEIGHT));
  await w.tx.insert(priorityPolicies).values({
    id: rowId,
    ownerUserId: w.userId,
    version: p.version,
    status: meta.activate ? 'active' : 'retired',
    ...weightCols,
    changeSummary: meta.note,
    source: policyByToDb(meta.by),
    changeSetId: meta.changeSetId ?? null,
    activatedAt: new Date(p.updatedAt),
    retiredAt: meta.activate ? null : new Date(meta.at),
    createdAt: new Date(meta.at),
  });
  if (p.rules.length) {
    await w.tx.insert(priorityPolicyRules).values(
      p.rules.map((r, i) => ({
        policyId: rowId,
        ordinal: i,
        ruleKey: r.id,
        label: r.text,
        explanation: r.text,
        kind: r.boost < 0 ? ('penalty' as const) : ('boost' as const),
        condition: r.when as Record<string, unknown>,
        effectValue: r.boost,
        enabled: r.enabled,
        source: policyByToDb(meta.by) === 'role_template' ? ('role_template' as const) : ('user' as const),
      })),
    );
  }
  await writeExt(w, 'priority_policies', rowId, { name: p.name, role: p.role, noteNull: p.note === null ? true : undefined });
  return rowId;
}

export async function activePolicyRowId(w: Pick<WriteCtx, 'tx' | 'userId'>): Promise<string | null> {
  const [row] = await w.tx.select({ id: priorityPolicies.id }).from(priorityPolicies).where(and(eq(priorityPolicies.ownerUserId, w.userId), eq(priorityPolicies.status, 'active'))).orderBy(desc(priorityPolicies.version)).limit(1);
  return row?.id ?? null;
}
