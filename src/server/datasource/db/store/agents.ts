/**
 * Agent runs (claude_sessions; app runs; tool-run mirrors), tool adapters and tool runs.
 *
 * claude_sessions: title · state → status (+ override for done vs done_review) · workItemId →
 *   launch_work_item_id · startedAt/finishedAt → started_at/ended_at · updatedAt → last_activity_at ·
 *   lastEvent → summary · waiting → waiting_reason (enum) / waiting_detail (question) / waiting_since ·
 *   sessionId → session_external_id · cwd · costUsd → cost_usd · scheduled → entrypoint scheduled_task.
 *   Ext: deepLink (when not the continue link), bgAgents, progress, resultUrl, error, waiting reason text
 *   and choices.
 * App runs (kind app_run) have no table in DATA-MODEL (claude_sessions and tool_runs only): kept whole
 *   under `cc.ext/app_runs/<id>` until BE-6 decides where in-app runs live.
 * tool_adapters: key = manifest.id · name · kind · base_url · capabilities · input_schema · version ·
 *   enabled · health → last_health_at / last_health_ok. Ext: the manifest (a TOOLS manifest under `tools`,
 *   or a seed's legacy manifest), health message, recent runs. Rows are the CONTRACT-1 ToolAdapter view:
 *   `toToolAdapter()` for TOOLS manifests, `ToolAdapterSeedRow` (the mock's own mapping) for seed rows.
 * tool_runs: adapter_id · capability · work_item_id · nba_id · status · input · started/finished ·
 *   error_message; link + artifacts → tool_run_outputs. Ext: progress, the Agents-page mirror row.
 */
import { asc, eq, inArray, like, and } from 'drizzle-orm';

import type { AgentRun, ToolAdapter, ToolHealth, ToolRun } from '@/contract';
import { toToolAdapter, ToolAdapterSeedRow } from '@/contract';
import { logger } from '@/lib/log';
import { toolManifestSchema, type ToolManifest } from '@/tools/manifest';
import { claudeSessions, toolAdapters, toolRunOutputs, toolRuns, userSettings } from '@/db/schema';

import { applyOverride, overrideIfLossy, runStateFromSession, runStateToSession, toolKindToDb, toolStatusFromDb, toolStatusToDb, type DbSessionStatus, type Override } from '../enums';
import { extKey } from '../ext';
import { uuidFor, uuidOrNull } from '../ids';
import { ext, inKeyOrder, iso, isoReq, keyOrder, same, toDate, updateRow, writeExt, writeKv, type ReadCtx, type WriteCtx } from './common';

// ---------------------------------------------------------------------------
// Claude sessions
// ---------------------------------------------------------------------------

interface SessionExt {
  stateOverride: Override<AgentRun['state'], DbSessionStatus>;
  deepLink: string;
  bgAgents: number;
  progress: AgentRun['progress'];
  resultUrl: string;
  error: string;
  waitingReason: string;
  waitingChoices: string[];
  deepLinkNull: boolean;
}

type WaitingEnum = 'permission_prompt' | 'question' | 'plan_approval' | 'error' | 'review_output' | 'input_needed';
function waitingEnum(reason: string): WaitingEnum {
  if (/permission|dialog/i.test(reason)) return 'permission_prompt';
  if (/plan/i.test(reason)) return 'plan_approval';
  if (/error/i.test(reason)) return 'error';
  if (/review/i.test(reason)) return 'review_output';
  if (/input/i.test(reason)) return 'input_needed';
  return 'question';
}
const WAITING_TEXT: Record<WaitingEnum, string> = { permission_prompt: 'dialog open', question: 'question', plan_approval: 'plan approval', error: 'error', review_output: 'review output', input_needed: 'input needed' };

const continueLink = (sessionId: string | null) => (sessionId ? `claude://code/continue?session=${sessionId}` : null);

export async function loadSessions(rc: ReadCtx): Promise<AgentRun[]> {
  const rows = await rc.db.select().from(claudeSessions).where(eq(claudeSessions.ownerUserId, rc.userId)).orderBy(asc(claudeSessions.createdAt), asc(claudeSessions.id));
  return rows.map((r) => {
    const x = ext<SessionExt>(rc, 'claude_sessions', r.id);
    const state = applyOverride(r.status, runStateFromSession(r.status), x.stateOverride);
    return {
      id: r.id,
      kind: 'claude_session',
      title: r.title ?? 'Claude session',
      workItemId: r.launchWorkItemId,
      state,
      startedAt: iso(r.startedAt),
      updatedAt: isoReq(r.lastActivityAt ?? r.updatedAt),
      finishedAt: iso(r.endedAt),
      lastEvent: r.summary ?? '',
      waiting:
        r.status === 'waiting_on_me' && r.waitingReason
          ? { reason: x.waitingReason ?? WAITING_TEXT[r.waitingReason], question: r.waitingDetail, choices: x.waitingChoices ?? [], since: isoReq(r.waitingSince ?? r.updatedAt) }
          : null,
      deepLink: x.deepLinkNull ? null : (x.deepLink ?? continueLink(r.sessionExternalId)),
      sessionId: r.sessionExternalId,
      cwd: r.cwd,
      bgAgents: x.bgAgents ?? 0,
      toolRunId: null,
      progress: x.progress ?? null,
      resultUrl: x.resultUrl ?? null,
      error: x.error ?? null,
      costUsd: r.costUsd,
      scheduled: r.entrypoint === 'scheduled_task',
    };
  });
}

function sessionColumns(a: AgentRun, w: Pick<WriteCtx, 'userId'>) {
  const status = runStateToSession(a.state);
  return {
    id: uuidFor(a.id),
    ownerUserId: w.userId,
    sessionExternalId: a.sessionId,
    entrypoint: a.scheduled ? ('scheduled_task' as const) : ('desktop' as const),
    status,
    waitingReason: a.waiting ? waitingEnum(a.waiting.reason) : null,
    waitingDetail: a.waiting?.question ?? null,
    waitingSince: toDate(a.waiting?.since),
    cwd: a.cwd,
    title: a.title,
    titleSource: 'app' as const,
    summary: a.lastEvent,
    summaryUpdatedAt: toDate(a.updatedAt),
    startedAt: toDate(a.startedAt),
    lastActivityAt: toDate(a.updatedAt),
    endedAt: toDate(a.finishedAt),
    costUsd: a.costUsd,
    launchWorkItemId: uuidOrNull(a.workItemId),
  };
}

function sessionExt(a: AgentRun): Record<string, unknown> {
  const status = runStateToSession(a.state);
  return {
    stateOverride: overrideIfLossy(a.state, status, runStateFromSession) ?? undefined,
    deepLink: a.deepLink === continueLink(a.sessionId) || a.deepLink === null ? undefined : a.deepLink,
    deepLinkNull: a.deepLink === null && continueLink(a.sessionId) !== null ? true : undefined,
    bgAgents: a.bgAgents || undefined,
    progress: a.progress,
    resultUrl: a.resultUrl ?? undefined,
    error: a.error ?? undefined,
    waitingReason: a.waiting && WAITING_TEXT[waitingEnum(a.waiting.reason)] !== a.waiting.reason ? a.waiting.reason : undefined,
    waitingChoices: a.waiting?.choices,
  };
}

export async function insertSession(w: WriteCtx, a: AgentRun, opts: { launchedByApp?: boolean; launchPrompt?: string } = {}): Promise<string> {
  const cols = sessionColumns(a, w);
  await w.tx.insert(claudeSessions).values({
    ...cols,
    launchedByApp: !!opts.launchedByApp,
    launchMode: opts.launchedByApp ? 'desktop_session' : null,
    launchPrompt: opts.launchPrompt ?? null,
    launchRequestedAt: opts.launchedByApp ? w.now : null,
    createdAt: toDate(a.startedAt ?? a.updatedAt)!,
    updatedAt: toDate(a.updatedAt)!,
  });
  await writeExt(w, 'claude_sessions', cols.id, sessionExt(a));
  return cols.id;
}

export async function updateSession(w: WriteCtx, cur: AgentRun, next: AgentRun) {
  const a = sessionColumns(cur, w);
  const b = sessionColumns(next, w);
  const patch: Record<string, unknown> = {};
  for (const k of Object.keys(b) as (keyof typeof b)[]) if (k !== 'id' && !same(a[k], b[k])) patch[k] = b[k];
  await updateRow(w, claudeSessions, b.id, patch, { bump: false });
  await writeExt(w, 'claude_sessions', b.id, sessionExt(next));
}

// ---------------------------------------------------------------------------
// App runs (side-car only) and tool-run mirrors
// ---------------------------------------------------------------------------

export async function loadAppRuns(rc: ReadCtx): Promise<AgentRun[]> {
  const out: AgentRun[] = [];
  for (const [k, v] of rc.kv) if (k.startsWith('cc.ext/app_runs/')) out.push(v as AgentRun);
  return out;
}

export async function writeAppRun(w: WriteCtx, a: AgentRun) {
  await writeKv(w, extKey('app_runs', uuidFor(a.id)), { ...a, id: uuidFor(a.id) });
}

// ---------------------------------------------------------------------------
// Tool adapters
// ---------------------------------------------------------------------------

interface AdapterExt {
  /** Legacy (seed) manifest shape. */
  manifest: ToolAdapter['manifest'];
  /** A TOOLS manifest (src/tools/manifest.ts), when the row was registered from one. */
  tools: ToolManifest;
  healthMessage: string;
  healthUnknown: boolean;
  recentRunIds: string[];
  /** Run-form field order of a legacy manifest (jsonb does not keep `input.schema.properties` key order). */
  fieldOrder: string[];
}

export async function loadToolAdapters(rc: ReadCtx): Promise<(ToolAdapter & { rowId: string })[]> {
  const rows = await rc.db.select().from(toolAdapters).where(eq(toolAdapters.ownerUserId, rc.userId)).orderBy(asc(toolAdapters.createdAt), asc(toolAdapters.key));
  const bad: string[] = [];
  const out: (ToolAdapter & { rowId: string })[] = [];
  for (const r of rows) {
    try {
      out.push(adapterFromRow(rc, r));
    } catch {
      bad.push(r.id);
    }
  }
  // One bad row must not take every page down: drop it, say so once (ids only, never field values).
  if (bad.length) logger('db').warn({ code: 'DATA.ROW_INVALID', table: 'tool_adapters', count: bad.length, ids: bad.slice(0, 20) }, 'tool_adapters: rows failed the contract and were left out');
  return out;
}

export function adapterFromRow(rc: ReadCtx, r: typeof toolAdapters.$inferSelect): ToolAdapter & { rowId: string } {
  {
    const x = ext<AdapterExt>(rc, 'tool_adapters', r.id);
    const health: ToolHealth = {
      state: x.healthUnknown || r.lastHealthOk === null ? 'unknown' : r.lastHealthOk ? 'ok' : 'down',
      checkedAt: iso(r.lastHealthAt),
      message: x.healthMessage ?? null,
    };
    const state = { health, enabled: r.enabled, recentRunIds: x.recentRunIds ?? [] };
    const tools = x.tools ? toolManifestSchema.safeParse(x.tools) : null;
    if (tools?.success) return { rowId: r.id, ...toToolAdapter(tools.data, state) };
    const manifest = x.manifest ?? {
      id: r.key,
      name: r.name,
      description: '',
      version: Number(r.version ?? 1),
      kind: r.kind === 'http_local' ? 'http' : r.kind === 'claude_session' ? 'claude-session' : r.kind === 'mcp' ? 'http' : r.kind,
      capabilities: r.capabilities,
      match: { taskTypes: [], keywords: [] },
      input: { schema: r.inputSchema, prefill: {} },
      launch: {},
      progress: { type: 'none' },
      output: { kind: 'link' },
      health: { type: 'none' },
      safety: { network: 'localhost-only', writes: [], requiresApproval: true, dataClass: 'internal' },
    };
    const order = x.fieldOrder ?? [];
    const pos = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
    const view = ToolAdapterSeedRow.parse({ manifest: withPropertyOrder(manifest, order), ...state });
    return { rowId: r.id, ...view, fields: [...view.fields].sort((a, b) => pos(a.key) - pos(b.key)) };
  }
}

/**
 * The deprecated manifest's `input.schema.properties` in run-form order. jsonb sorts object keys (shortest
 * first), and the Tools launcher still builds its form from these properties, so without this a db-mode form
 * shows "Talk track name, Event, Customer" where the manifest (and the mock) says "Customer, Talk track name, Event".
 */
function withPropertyOrder(manifest: ToolAdapter['manifest'], order: string[]): ToolAdapter['manifest'] {
  const schema = manifest.input?.schema as { properties?: Record<string, unknown> } | undefined;
  const props = schema?.properties;
  if (!props || typeof props !== 'object' || Array.isArray(props)) return manifest;
  const ordered = inKeyOrder(props, order);
  return ordered === props ? manifest : { ...manifest, input: { ...manifest.input, schema: { ...schema, properties: ordered } } };
}

export async function insertToolAdapter(w: WriteCtx, t: ToolAdapter, at: string, tools?: ToolManifest): Promise<string> {
  const id = uuidFor(`tool_adapter:${t.id}`);
  const m = t.manifest;
  await w.tx.insert(toolAdapters).values({
    id,
    ownerUserId: w.userId,
    key: t.id,
    name: t.name,
    kind: toolKindToDb(m.kind),
    baseUrl: m.launch.http?.baseUrl ?? null,
    healthPath: m.health.http?.url ?? null,
    launchCommand: m.launch.cli ? m.launch.cli.argv.join(' ') : null,
    capabilities: m.capabilities,
    inputSchema: m.input.schema,
    version: String(m.version),
    enabled: t.enabled,
    lastHealthAt: toDate(t.health.checkedAt),
    lastHealthOk: t.health.state === 'unknown' ? null : t.health.state === 'ok',
    createdAt: toDate(at)!,
  });
  await writeExt(w, 'tool_adapters', id, { ...(tools ? { tools } : { manifest: m, fieldOrder: t.fields.map((f) => f.key) }), healthMessage: t.health.message ?? undefined, healthUnknown: t.health.state === 'unknown' && t.health.checkedAt !== null ? true : undefined, recentRunIds: t.recentRunIds });
  return id;
}

/** Register a TOOLS manifest (tools-registry/*.json) as a tool_adapters row; reads map it with toToolAdapter(). */
export async function insertToolsManifest(w: WriteCtx, tools: ToolManifest, opts: { enabled?: boolean; health?: ToolHealth; at?: string } = {}): Promise<string> {
  return insertToolAdapter(w, toToolAdapter(tools, { enabled: opts.enabled, health: opts.health }), opts.at ?? w.now.toISOString(), tools);
}

export async function updateToolAdapterRecent(w: WriteCtx, adapterRowId: string, recentRunIds: string[]) {
  const key = extKey('tool_adapters', adapterRowId);
  const prev = (w.kv.get(key) as Record<string, unknown> | undefined) ?? {};
  await writeExt(w, 'tool_adapters', adapterRowId, { ...prev, recentRunIds });
}

// ---------------------------------------------------------------------------
// Tool runs
// ---------------------------------------------------------------------------

interface ToolRunExt {
  progress: ToolRun['progress'];
  agentRun: AgentRun;
  statusOverride: Override<ToolRun['status'], string>;
  artifactMime: Record<string, string>;
  /** Key order of `inputs` (jsonb sorts keys; the Tools rows and run panels list inputs in this order). */
  inputOrder: string[];
}

export async function loadToolRuns(rc: ReadCtx, adapterKey: Map<string, string>): Promise<{ runs: ToolRun[]; mirrors: AgentRun[] }> {
  const rows = await rc.db.select().from(toolRuns).where(eq(toolRuns.ownerUserId, rc.userId)).orderBy(asc(toolRuns.createdAt), asc(toolRuns.id));
  if (!rows.length) return { runs: [], mirrors: [] };
  const outs = await rc.db.select().from(toolRunOutputs).where(inArray(toolRunOutputs.toolRunId, rows.map((r) => r.id))).orderBy(asc(toolRunOutputs.createdAt), asc(toolRunOutputs.id));
  const runs: ToolRun[] = [];
  const mirrors: AgentRun[] = [];
  for (const r of rows) {
    const x = ext<ToolRunExt>(rc, 'tool_runs', r.id);
    const mine = outs.filter((o) => o.toolRunId === r.id);
    const link = mine.find((o) => o.kind === 'url');
    const status = applyOverride(r.status as string, toolStatusFromDb(r.status), x.statusOverride as Override<ToolRun['status'], string> | undefined);
    runs.push({
      id: r.id,
      adapterId: adapterKey.get(r.adapterId) ?? r.adapterId,
      workItemId: r.workItemId,
      nbaId: r.nbaId,
      inputs: inKeyOrder(r.input as ToolRun['inputs'], x.inputOrder),
      status,
      progress: x.progress ?? null,
      linkUrl: link?.url ?? null,
      linkLabel: link?.label ?? null,
      artifacts: mine.filter((o) => o.kind === 'file').map((o) => ({ path: o.localPath ?? '', mime: x.artifactMime?.[o.localPath ?? ''] ?? 'application/octet-stream', label: o.label })),
      startedAt: iso(r.startedAt),
      finishedAt: iso(r.finishedAt),
      error: r.errorMessage,
      agentRunId: x.agentRun?.id ?? null,
    });
    if (x.agentRun) mirrors.push(x.agentRun);
  }
  return { runs, mirrors };
}

export async function insertToolRun(w: WriteCtx, tr: ToolRun, adapterRowId: string, capability: string, mirror: AgentRun | null, createdAt?: string): Promise<string> {
  const id = uuidFor(tr.id);
  const status = toolStatusToDb(tr.status);
  await w.tx.insert(toolRuns).values({
    id,
    ownerUserId: w.userId,
    adapterId: adapterRowId,
    capability,
    workItemId: uuidOrNull(tr.workItemId),
    nbaId: uuidOrNull(tr.nbaId),
    status,
    input: tr.inputs,
    startedAt: toDate(tr.startedAt),
    finishedAt: toDate(tr.finishedAt),
    errorMessage: tr.error,
    createdAt: toDate(createdAt ?? tr.startedAt) ?? w.now,
  });
  await writeOutputs(w, id, tr);
  await writeExt(w, 'tool_runs', id, toolRunExt(tr, mirror));
  return id;
}

function toolRunExt(tr: ToolRun, mirror: AgentRun | null): Record<string, unknown> {
  const status = toolStatusToDb(tr.status);
  const mime: Record<string, string> = {};
  for (const a of tr.artifacts) mime[a.path] = a.mime;
  return {
    progress: tr.progress,
    agentRun: mirror ?? undefined,
    statusOverride: overrideIfLossy(tr.status, status, toolStatusFromDb) ?? undefined,
    artifactMime: Object.keys(mime).length ? mime : undefined,
    inputOrder: keyOrder(tr.inputs),
  };
}

async function writeOutputs(w: WriteCtx, id: string, tr: ToolRun) {
  await w.tx.delete(toolRunOutputs).where(eq(toolRunOutputs.toolRunId, id));
  const rows: (typeof toolRunOutputs.$inferInsert)[] = [];
  if (tr.linkUrl) rows.push({ toolRunId: id, kind: 'url', label: tr.linkLabel ?? 'Open', url: tr.linkUrl });
  for (const a of tr.artifacts) rows.push({ toolRunId: id, kind: 'file', label: a.label, localPath: a.path });
  if (rows.length) await w.tx.insert(toolRunOutputs).values(rows);
}

export async function updateToolRun(w: WriteCtx, cur: ToolRun, next: ToolRun, mirror: AgentRun | null) {
  const id = uuidFor(next.id);
  const patch: Record<string, unknown> = {};
  if (cur.status !== next.status) patch.status = toolStatusToDb(next.status);
  if (cur.startedAt !== next.startedAt) patch.startedAt = toDate(next.startedAt);
  if (cur.finishedAt !== next.finishedAt) patch.finishedAt = toDate(next.finishedAt);
  if (cur.error !== next.error) patch.errorMessage = next.error;
  await updateRow(w, toolRuns, id, patch, { bump: false });
  if (cur.linkUrl !== next.linkUrl || !same(cur.artifacts, next.artifacts)) await writeOutputs(w, id, next);
  await writeExt(w, 'tool_runs', id, toolRunExt(next, mirror));
}

/** All app-run keys (used by seeding to keep reloads idempotent). */
export async function appRunKeys(w: WriteCtx): Promise<string[]> {
  const rows = await w.tx.select({ key: userSettings.key }).from(userSettings).where(and(eq(userSettings.ownerUserId, w.userId), like(userSettings.key, 'cc.ext/app_runs/%')));
  return rows.map((r) => r.key);
}
