// The Slack triage pass of AgentSdkSkillRunner. Split from skill-runner.ts (max-lines); the class is still exported from skill-runner.ts.
import type { ScannerStore } from '../scanner/types';
import type { ScanSkillRunResult } from '../scanner/runtime/contract-ext';
import { createCcHandlers, createRunState, type CcRunState } from './cc-tools';
import {
  conversationRefs, renderTriageBatch, selectSlackTriage, TRIAGE_CONTEXT, triageConversationKey, type PriorVerdict,
  type TriageBatch, type TriageConfig, type TriageLine,
} from '../scanner/triage/slack-triage';
import { SlackAutoRecorder } from './slack-rec';
import { Org62AutoRecorder } from './org62-rec';
import { errorText } from './errors';
import { addUsage } from './usage';
import type { CallMeasurement } from '../db/ledger';
import { safeLogText } from './redact';
import { trace } from '../scanner/trace';
import {
  type ScanSkillRunInput, type AgentSdkSkillRunnerOptions, TOOL_OVERHEAD_TOKENS, type ScanSkillRunResultWithPasses,
  type RunnerLogEvent, type SkillPassStat, EMPTY_ROW, actedOn, triageSkillKeyOf,
} from './skill-runner.shared';

/** The runner's options and the Slack triage pass; AgentSdkSkillRunner (skill-runner.ts) adds the traversal run. */
export abstract class AgentSdkSkillRunnerTriage {
  protected readonly o: Required<Pick<AgentSdkSkillRunnerOptions, 'timeoutMs' | 'prefixTripwireTokens'>> & AgentSdkSkillRunnerOptions;

  constructor(opts: AgentSdkSkillRunnerOptions = {}) {
    // 40 K: the fixed prefix (skill + bounded context pack + tool schemas) is ~34 K for Calendar with a real-sized
    // context pack, so 32 K tripped every Calendar run once (stress finding TRIP-1). A real blow-up is far larger.
    this.o = { timeoutMs: 180_000, prefixTripwireTokens: TOOL_OVERHEAD_TOKENS, toolDigest: process.env.CC_TOOL_DIGEST !== '0', promptGuard: process.env.CC_PROMPT_GUARD !== '0', ...opts };
  }

  /**
   * Triage pass: batches of this run's messages to / from me (DMs, group DMs, my threads), each message one verdict.
   * `unsure` verdicts (and messages left without any verdict or outcome) go to the escalation model; without one
   * they are flagged unlinked so they surface in Triage instead of vanishing.
   */
  protected async runTriage(input: ScanSkillRunInput, store: ScannerStore, state: CcRunState, out: ScanSkillRunResultWithPasses): Promise<void> {
    const cfg = input.triage!;
    const log = (e: Omit<RunnerLogEvent, 'runId'>) => this.o.logger?.({ runId: input.runId, ...e });
    const sel = await this.selectWithContext(input, store, state, cfg);
    const tri: SkillPassStat = { pass: 'triage', model: cfg.model, runs: 0, costUsd: 0, messages: sel.needing - sel.dropped, verdicts: { act: 0, noise: 0, unsure: 0, missing: 0 }, proposed: 0, linked: 0, errors: [] };
    out.passes!.push(tri);
    log({ event: 'start', code: 'triage', detail: `qualifying=${sel.qualifying} needing=${sel.needing} trivial=${sel.trivial} handled=${sel.handled} batches=${sel.batches.length} dropped=${sel.dropped}` });
    const ids = (xs: string[] | undefined) => (xs ?? []).slice(0, 200);
    trace(input.runId, 'triage_select', () => ({ qualifying: sel.qualifying, needing: sel.needing, trivial: sel.trivial, handled: sel.handled, batches: sel.batches.length, dropped: sel.dropped, model: cfg.model, escalateModel: cfg.escalateModel ?? null, trivialIds: ids(sel.decisions?.trivial), handledIds: ids(sel.decisions?.handled), skippedIds: ids(sel.decisions?.skipped), droppedIds: ids(sel.decisions?.dropped) }));
    if (!sel.batches.length) return;
    const unsure: Array<{ batch: TriageBatch; lines: Map<string, string | undefined> }> = [];
    const passInput = (pass: 'triage' | 'escalate', model: string, cap: number, instruction: string): ScanSkillRunInput => ({
      skillPath: cfg.skillPath,
      model,
      mcpServers: {},
      allowedTools: [],
      runId: input.runId,
      context: input.context,
      maxTurns: cfg.maxTurns,
      costCapUsd: cap,
      signal: input.signal,
      window: input.window,
      mode: pass,
      vars: input.vars,
      instruction,
      pass,
    });
    const absorb = (s: SkillPassStat, r: ScanSkillRunResult) => {
      s.runs += 1;
      s.costUsd += r.costUsd;
      s.proposed! += r.counts?.proposed ?? 0;
      s.linked! += r.counts?.linked ?? 0;
      if (!r.ok && r.error) s.errors!.push(safeLogText(r.error.message, 120));
      out.costUsd += r.costUsd;
      out.inputTokens += r.inputTokens;
      out.outputTokens += r.outputTokens;
      out.cacheReadTokens = (out.cacheReadTokens ?? 0) + (r.cacheReadTokens ?? 0);
      out.cacheWriteTokens = (out.cacheWriteTokens ?? 0) + (r.cacheWriteTokens ?? 0);
      out.usage = addUsage({ ...EMPTY_ROW, byModel: out.usage ?? [] }, { ...EMPTY_ROW, byModel: r.usage ?? [] }).byModel;
      out.turns += r.turns;
      if (out.counts && r.counts) {
        out.counts.proposed += r.counts.proposed;
        out.counts.linked += r.counts.linked;
        out.counts.unlinked += r.counts.unlinked;
      }
    };
    const needing = (b: TriageBatch) => b.conversations.flatMap((c) => c.lines.filter((l) => l.needs));
    for (const [i, b] of sel.batches.entries()) {
      if (input.signal.aborted) return;
      // 0027: items in = the batch's lines that need a verdict; the first batch also carries what rules settled
      // without the model (trivial lines, lines a run already acted on, verdicts carried forward).
      const extra: Partial<CallMeasurement> = { itemsIn: needing(b).length, ...(i === 0 ? { itemsDecidedByRules: sel.trivial + sel.handled } : {}) };
      const r = await this.runOnce(passInput('triage', cfg.model, cfg.costCapUsdPerBatch, renderTriageBatch(b, input.context, { index: i + 1, total: sel.batches.length })), store, state, () => extra);
      absorb(tri, r.result);
      const left = new Map<string, string | undefined>();
      for (const l of needing(b)) {
        const v = r.state.verdicts.get(l.sourceItemId);
        const acted = state.outcomes.get(l.sourceItemId)?.some((d) => !d.startsWith('context:'));
        if (v) tri.verdicts![v.v] += 1;
        else if (acted) tri.verdicts!.act += 1;
        else tri.verdicts!.missing += 1;
        if (v?.v === 'unsure' || (!v && !acted)) left.set(l.sourceItemId, v?.why);
        trace(input.runId, 'verdict', () => ({ pass: 'triage', batch: i + 1, ref: l.ref, v: v?.v ?? (acted ? 'act' : 'missing'), why: v?.why ?? null, acted: actedOn(state, l.sourceItemId), escalate: left.has(l.sourceItemId) && !!cfg.escalateModel, ok: r.result.ok }), { sourceItemId: l.sourceItemId });
      }
      if (left.size) unsure.push({ batch: b, lines: left });
      await this.saveVerdicts(store, r.state.verdicts, log);
    }
    const pending = unsure.reduce((a, u) => a + u.lines.size, 0);
    if (!pending) return;
    // D6: past today's escalation allowance, unsure lines go to Triage (flagged) instead of the stronger model.
    const overAllowance = !!cfg.escalateModel && cfg.escalateLeftUsd !== undefined && cfg.escalateLeftUsd < cfg.escalateCostCapUsd;
    if (overAllowance) {
      trace(input.runId, 'triage_select', () => ({ escalation: 'day_cap', leftUsd: cfg.escalateLeftUsd ?? null, pending }));
      await store.recordDecision?.({ skill: triageSkillKeyOf(cfg), kind: 'block', reason: 'escalation_day_cap', trigger: input.mode ?? null, subject: `${input.context.scope.connector}:${input.context.scope.scope}`, count: pending, detail: { leftUsd: cfg.escalateLeftUsd ?? null, runId: input.runId } });
    }
    if (!cfg.escalateModel || overAllowance) {
      const flag = createCcHandlers(store, { ...createRunState({ runId: input.runId, connector: state.connector, window: state.window, context: input.context }), pass: 'triage' } as CcRunState);
      for (const u of unsure) {
        for (const [sid, why] of u.lines) {
          await flag.cc_flag_unlinked({ sourceItemId: sid, reason: `unsure: ${why ?? 'triage could not tell whether this asks or promises something'}` }).catch(() => undefined);
          if (out.counts) out.counts.unlinked += 1;
        }
      }
      return;
    }
    // Escalation: the same conversations, only the unsure lines need a verdict, packed into batches again.
    const esc: SkillPassStat = { pass: 'escalate', model: cfg.escalateModel, runs: 0, costUsd: 0, messages: pending, verdicts: { act: 0, noise: 0, unsure: 0, missing: 0 }, proposed: 0, linked: 0, errors: [] };
    out.passes!.push(esc);
    const escBatches: TriageBatch[] = [];
    for (const u of unsure) {
      const conversations = u.batch.conversations
        .map((c) => ({ ...c, lines: c.lines.map((l): TriageLine => (u.lines.has(l.sourceItemId) ? { ...l, needs: true, unsureWhy: u.lines.get(l.sourceItemId) } : { ...l, needs: false })) }))
        .filter((c) => c.lines.some((l) => l.needs));
      const n = conversations.reduce((a, c) => a + c.lines.filter((l) => l.needs).length, 0);
      const last = escBatches[escBatches.length - 1];
      if (last && last.needs + n <= cfg.batchSize) {
        last.conversations.push(...conversations);
        last.needs += n;
      } else escBatches.push({ conversations, needs: n });
    }
    let escLeft = cfg.escalateLeftUsd ?? Infinity;
    for (const [i, b] of escBatches.entries()) {
      if (input.signal.aborted) return;
      if (escLeft < cfg.escalateCostCapUsd) {
        // D6: the allowance ran out mid-run: the remaining unsure lines go to Triage.
        const rest = escBatches.slice(i);
        const n = rest.reduce((a, x) => a + needing(x).length, 0);
        await store.recordDecision?.({ skill: triageSkillKeyOf(cfg), kind: 'block', reason: 'escalation_day_cap', trigger: input.mode ?? null, subject: `${input.context.scope.connector}:${input.context.scope.scope}`, count: n, detail: { leftUsd: escLeft, runId: input.runId } });
        const flag = createCcHandlers(store, { ...createRunState({ runId: input.runId, connector: state.connector, window: state.window, context: input.context }), pass: 'triage' } as CcRunState);
        for (const x of rest) for (const l of needing(x)) await flag.cc_flag_unlinked({ sourceItemId: l.sourceItemId, reason: `unsure: ${l.unsureWhy ?? 'triage could not tell whether this asks or promises something'}` }).catch(() => undefined);
        if (out.counts) out.counts.unlinked += n;
        break;
      }
      // D4 (0027): how many of the escalated lines the stronger model decided (act or noise, or acted on) where the
      // cheaper pass left them unsure or without a verdict: the changed-verdict rate the escalation policy is gated on.
      const changedOf = (st: CcRunState): Partial<CallMeasurement> => ({
        itemsIn: needing(b).length,
        escalationChangedItems: needing(b).filter((l) => {
          const v = st.verdicts.get(l.sourceItemId)?.v;
          return v === 'act' || v === 'noise' || (!v && !!state.outcomes.get(l.sourceItemId)?.some((d) => !d.startsWith('context:')));
        }).length,
      });
      const r = await this.runOnce(passInput('escalate', cfg.escalateModel, Math.min(cfg.escalateCostCapUsd, escLeft), renderTriageBatch(b, input.context, { index: i + 1, total: escBatches.length, escalate: true })), store, state, changedOf);
      absorb(esc, r.result);
      escLeft -= r.result.costUsd;
      for (const l of needing(b)) {
        const v = r.state.verdicts.get(l.sourceItemId);
        const acted = state.outcomes.get(l.sourceItemId)?.some((d) => !d.startsWith('context:'));
        if (v) esc.verdicts![v.v] += 1;
        else if (acted) esc.verdicts!.act += 1;
        else esc.verdicts!.missing += 1;
        trace(input.runId, 'verdict', () => ({ pass: 'escalate', batch: i + 1, ref: l.ref, v: v?.v ?? (acted ? 'act' : 'missing'), why: v?.why ?? null, acted: actedOn(state, l.sourceItemId), final: true, ok: r.result.ok }), { sourceItemId: l.sourceItemId });
      }
      await this.saveVerdicts(store, r.state.verdicts, log);
    }
    log({ event: 'result', code: 'escalate', detail: `escalated=${pending} batches=${escBatches.length}`, costUsd: esc.costUsd });
  }

  /**
   * TRI-NOISE + TRI-CTX: select with earlier runs' verdicts carried forward (a message called noise before is context
   * now), then add each selected conversation's lines from earlier runs (the last few before this run's first line and
   * the replies after its last, any window) and select again. A store without these reads gives the plain selection.
   */
  protected async selectWithContext(input: ScanSkillRunInput, store: ScannerStore, state: CcRunState, cfg: TriageConfig) {
    const ids = [...state.items.entries()].filter(([, it]) => it.connector === 'slack' && it.kind === 'message').map(([k]) => state.recorded.get(k)).filter((x): x is string => !!x);
    let prior: Map<string, PriorVerdict> | undefined;
    try {
      prior = ids.length ? await store.triageVerdicts?.(ids) : undefined;
    } catch {
      prior = undefined;
    }
    const first = selectSlackTriage(state.items, state.recorded, state.outcomes, input.context, cfg, { prior });
    if (!store.conversationLines || !first.batches.length) return first;
    const extra = new Map<string, TriageLine[]>();
    for (const c of conversationRefs(first)) {
      try {
        const rows = await store.conversationLines({ channelId: c.channelId, threadRef: c.threadRef, before: { at: c.firstAt, limit: TRIAGE_CONTEXT.before }, after: { at: c.lastAt, limit: TRIAGE_CONTEXT.after } });
        const lines = rows.filter((r) => triageConversationKey(r.item) === c.key).map((r): TriageLine => ({ ref: r.item.externalId, sourceItemId: r.sourceItemId, item: r.item, needs: false, earlier: true }));
        if (lines.length) extra.set(c.key, lines);
      } catch {
        /* context is best effort: the batch still has this run's lines */
      }
    }
    if (!extra.size) return first;
    trace(input.runId, 'triage_context', () => ({ conversations: extra.size, lines: [...extra.values()].reduce((a, l) => a + l.length, 0) }));
    return selectSlackTriage(state.items, state.recorded, state.outcomes, input.context, cfg, { prior, extra });
  }

  /** TRI-NOISE: a pass's verdicts go onto their messages (best effort: a failure never fails the run). */
  protected async saveVerdicts(store: ScannerStore, verdicts: Map<string, { v: 'act' | 'noise' | 'unsure'; why?: string }>, log: (e: Omit<RunnerLogEvent, 'runId'>) => void) {
    if (!store.recordTriageVerdicts || !verdicts.size) return;
    try {
      await store.recordTriageVerdicts([...verdicts].map(([sourceItemId, v]) => ({ sourceItemId, v: v.v, ...(v.why ? { why: v.why } : {}) })));
    } catch (err) {
      log({ event: 'error', code: 'triage_verdicts_not_saved', detail: safeLogText(errorText(err), 160) });
    }
  }

  /** The traversal's one query (AgentSdkSkillRunner.runOnce). */
  protected abstract runOnce(input: ScanSkillRunInput, store: ScannerStore, parent?: CcRunState, extra?: (state: CcRunState) => Partial<CallMeasurement>): Promise<{ result: ScanSkillRunResult; state: CcRunState; rec?: SlackAutoRecorder | Org62AutoRecorder }>;
}
