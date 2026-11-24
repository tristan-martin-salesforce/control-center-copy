/**
 * The db DataSource, agents domain (R7: one file per domain; DbDataSource keeps one-line delegates).
 */
import type { DbCtx } from '../ctx';
import { WHOLE, I, Res, uniq } from '../shared';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { type AgentRun, type ToolRun, type WorkItemRecord, requiredFieldKeys } from '@/contract';
import { validateInput } from '@/tools/manifest';
import { enqueueJob } from '@/db/queue';
import { changeSets, jobs } from '@/db/schema';
import { AppError, invalid, notFound } from '@/server/errors';
import type { ReadModel } from '../model';
import { AGENTS } from '../reads/scope';
import { insertSession, insertToolRun, updateSession, updateToolAdapterRecent, updateToolRun, writeAppRun } from '../store/agents';
import type { WriteCtx } from '../store/common';
import { logTransition } from '../store/work';
import { agentsView, toolsView } from '@/server/views/agents';
import { PREPARED_LAUNCH_EVENT } from '../../types/agents';

function buildLaunchPrompt(item: WorkItemRecord, m: ReadModel): string {
  const ini = item.initiativeId ? m.get('initiatives', item.initiativeId) : undefined;
  const acc = item.accountId ? m.get('accounts', item.accountId) : undefined;
  return [
    `Task: ${item.title}`,
    item.purpose ? `Purpose: ${item.purpose}` : null,
    ini ? `Initiative: ${ini.title} — ${ini.summary}` : null,
    acc ? `Account: ${acc.name}` : null,
    `Why now: ${item.why}`,
    item.sources.length ? `Sources: ${item.sources.map((s) => s.label).join('; ')}` : null,
    item.notes ? `Notes: ${item.notes}` : null,
    'Read-only research is fine. Do not send, post or write to any external system.',
  ]
    .filter(Boolean)
    .join('\n');
}

export class DbAgents {
  constructor(private readonly ctx: DbCtx) {}

  async getAgents(_i: I<'getAgents'>): Promise<Res<'getAgents'>> {
    return this.ctx.read(AGENTS, (m) => agentsView(m));
  }

  /** Records the launch (a `launching` session the Claude-session watcher picks up); opening Claude is the client's job. */
  async launchAgent({ body }: I<'launchAgent'>): Promise<Res<'launchAgent'>> {
    let url = '';
    const runId = crypto.randomUUID();
    await this.ctx.mutate({ action: 'agent.launch', summary: 'Started in Claude', entity: { type: 'agent_run', id: runId } }, async (w, model) => {
      const item = body.workItemId ? this.ctx.item(model, body.workItemId) : undefined;
      const folder = body.folder ?? model.meta().repoFolder ?? process.cwd();
      let prompt = body.prompt ?? (item ? buildLaunchPrompt(item, model) : 'New session from Command Center');
      if (item && !prompt.includes(`[cc:${item.id}]`)) prompt = `${prompt}\n\n[cc:${item.id}]`;
      if (prompt.length > 14336) prompt = prompt.slice(0, 14336 - (item ? item.id.length + 8 : 0)) + (item ? `\n[cc:${item.id}]` : '');
      url = `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}`;
      const run: AgentRun = {
        id: runId,
        kind: 'claude_session',
        title: body.title ?? item?.title ?? 'New Claude session',
        workItemId: item?.id ?? null,
        state: 'queued',
        startedAt: w.now.toISOString(),
        updatedAt: w.now.toISOString(),
        finishedAt: null,
        lastEvent: PREPARED_LAUNCH_EVENT,
        waiting: null,
        deepLink: url,
        sessionId: null,
        cwd: folder,
        bgAgents: 0,
        toolRunId: null,
        progress: null,
        resultUrl: null,
        error: null,
        costUsd: null,
        scheduled: false,
      };
      await w.tx.update(changeSets).set({ summary: `Started in Claude: ${run.title}` }).where(eq(changeSets.id, w.cs.id));
      await insertSession(w, run, { launchedByApp: true, launchPrompt: prompt });
      model.put('agentRuns', run);
      if (item) {
        const next = { ...item, state: item.state === 'open' || item.state === 'reopened' ? ('in_progress' as const) : item.state, runIds: uniq([...item.runIds, run.id]) };
        await this.ctx.writeItem(w, model, item, next, { bump: true });
        await logTransition(w, item.id, item.state, next.state, 'Started in Claude');
      }
    });
    const m = await this.ctx.model(WHOLE);
    return { url, run: m.get('agentRuns', runId)! };
  }

  async answerAgent({ params, body }: I<'answerAgent'>): Promise<Res<'answerAgent'>> {
    const r = await this.ctx.mutate({ action: 'agent.answer', summary: 'Answered', entity: { type: 'agent_run', id: params.id } }, async (w, model) => {
      const run = model.get('agentRuns', params.id);
      if (!run) throw notFound('Agent run', params.id);
      if (run.kind === 'claude_session') throw invalid('Claude sessions are answered in Claude: use Open in Claude');
      if (run.state !== 'waiting_on_you') throw invalid(`Run is ${run.state}, not waiting on you`);
      const next: AgentRun = { ...run, state: 'running', waiting: null, lastEvent: `You answered: ${body.answer}`, updatedAt: w.now.toISOString() };
      await w.tx.update(changeSets).set({ summary: `Answered: ${run.title}` }).where(eq(changeSets.id, w.cs.id));
      await this.writeRun(w, model, run, next);
      const item = run.workItemId ? model.get('workItems', run.workItemId) : undefined;
      if (item?.state === 'waiting_on_me') {
        await this.ctx.writeItem(w, model, item, { ...item, state: 'in_progress', waiting: null }, { bump: true });
        await logTransition(w, item.id, item.state, 'in_progress', 'Answered');
      }
      // HYG-1: the answer is recorded on the run itself. No worker handles an `agent.answer` job (it only dead-lettered).
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('agentRuns', params.id)!, auditId: r.auditId };
  }

  /** Persist an agent run in whichever store it lives (session row, app-run ext, tool-run mirror). */
  private async writeRun(w: WriteCtx, model: ReadModel, cur: AgentRun, next: AgentRun) {
    if (cur.kind === 'claude_session') await updateSession(w, cur, next);
    else if (cur.kind === 'app_run') await writeAppRun(w, next);
    else {
      const tr = model.all('toolRuns').find((t) => t.agentRunId === cur.id);
      if (tr) await updateToolRun(w, tr, tr, next);
    }
    model.put('agentRuns', next);
  }

  async cancelAgent({ params }: I<'cancelAgent'>): Promise<Res<'cancelAgent'>> {
    const r = await this.ctx.mutate({ action: 'agent.cancel', summary: 'Cancelled', entity: { type: 'agent_run', id: params.id } }, async (w, model) => {
      const run = model.get('agentRuns', params.id);
      if (!run) throw notFound('Agent run', params.id);
      if (run.kind === 'claude_session') throw invalid('Stop Claude sessions in Claude');
      if (!['queued', 'running', 'waiting_on_you', 'stale'].includes(run.state)) throw invalid(`Run is ${run.state}`);
      const next: AgentRun = { ...run, state: 'failed', error: 'Cancelled by you', lastEvent: 'Cancelled', updatedAt: w.now.toISOString(), finishedAt: w.now.toISOString() };
      await w.tx.update(changeSets).set({ summary: `Cancelled: ${run.title}` }).where(eq(changeSets.id, w.cs.id));
      if (run.toolRunId) {
        const tr = model.get('toolRuns', run.toolRunId);
        if (tr) {
          await updateToolRun(w, tr, { ...tr, status: 'cancelled', finishedAt: w.now.toISOString(), error: 'Cancelled by you' }, next);
          await w.tx.update(jobs).set({ cancelRequestedAt: w.now, cancelReason: 'cancelled by user' }).where(and(eq(jobs.ownerUserId, w.userId), sql`${jobs.payload} ->> 'toolRunId' = ${tr.id}`, inArray(jobs.status, ['queued', 'running'])));
        }
      } else await this.writeRun(w, model, run, next);
    });
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('agentRuns', params.id)!, auditId: r.auditId };
  }

  async getTools(_i: I<'getTools'>): Promise<Res<'getTools'>> {
    return this.ctx.read(AGENTS, (m) => toolsView(m));
  }

  /** Records a queued tool run (+ its Agents mirror) and enqueues `tool.run` for the worker's adapter runner. */
  async startToolRun({ params, body }: I<'startToolRun'>): Promise<Res<'startToolRun'>> {
    const m0 = await this.ctx.model(WHOLE);
    const adapter = m0.get('toolAdapters', params.id);
    if (!adapter) throw notFound('Tool', params.id);
    if (!adapter.enabled) throw invalid(`${adapter.name} is disabled`);
    if (adapter.health.state === 'down') throw new AppError('upstream_unavailable', `${adapter.name} is not running (health check failed). Start it from Agents ▸ Tools, then run again.`);
    const missing = requiredFieldKeys(adapter).filter((k) => body.inputs[k] === undefined || body.inputs[k] === '');
    if (missing.length) throw invalid(`Missing inputs: ${missing.join(', ')}`, { missing });
    const checked = validateInput({ input: { fields: adapter.fields } }, body.inputs);
    if (!checked.ok) throw invalid(`Invalid inputs: ${checked.errors.join('; ')}`, { errors: checked.errors });
    const runId = crypto.randomUUID();
    const agentRunId = crypto.randomUUID();
    const r = await this.ctx.mutate({ action: 'tool.run', summary: `Ran ${adapter.name}`, entity: { type: 'tool_run', id: runId } }, async (w, model) => {
      const steps = 3;
      const tr: ToolRun = { id: runId, adapterId: adapter.id, workItemId: body.workItemId ?? null, nbaId: body.nbaId ?? null, inputs: body.inputs, status: 'queued', progress: { done: 0, total: steps, label: 'Queued' }, linkUrl: null, linkLabel: null, artifacts: [], startedAt: w.now.toISOString(), finishedAt: null, error: null, agentRunId };
      const ar: AgentRun = { id: agentRunId, kind: 'tool_run', title: `${adapter.name}${body.inputs.name ? `: ${String(body.inputs.name)}` : ''}`, workItemId: body.workItemId ?? null, state: 'queued', startedAt: w.now.toISOString(), updatedAt: w.now.toISOString(), finishedAt: null, lastEvent: 'Queued', waiting: null, deepLink: `/agents?run=${agentRunId}`, sessionId: null, cwd: null, bgAgents: 0, toolRunId: runId, progress: tr.progress, resultUrl: null, error: null, costUsd: null, scheduled: false };
      const adapterRow = model.extra.adapterRowId.get(adapter.id)!;
      await insertToolRun(w, tr, adapterRow, adapter.manifest.capabilities[0] ?? 'run', ar);
      await updateToolAdapterRecent(w, adapterRow, [runId, ...adapter.recentRunIds].slice(0, 10));
      model.put('toolRuns', tr);
      model.put('agentRuns', ar);
      const item = body.workItemId ? model.get('workItems', body.workItemId) : undefined;
      if (item) {
        const next = { ...item, state: item.state === 'open' ? ('in_progress' as const) : item.state, runIds: uniq([...item.runIds, agentRunId]) };
        await this.ctx.writeItem(w, model, item, next, { bump: true });
        await logTransition(w, item.id, item.state, next.state, `Ran ${adapter.name}`);
      }
      const job = await enqueueJob(w.tx, { ownerUserId: w.userId, kind: 'tool.run', payload: { toolRunId: runId, adapter: adapter.id } });
      await w.tx.execute(sql`update tool_runs set job_id = ${job.id} where id = ${runId}`);
    });
    this.ctx.bus.publishTables(['jobs', 'tool_runs'], [runId], 'tool.run');
    const m = await this.ctx.model(WHOLE);
    return { entity: m.get('toolRuns', runId)!, auditId: r.auditId };
  }

  async getToolRun({ params }: I<'getToolRun'>): Promise<Res<'getToolRun'>> {
    const m = await this.ctx.model(WHOLE);
    const tr = m.get('toolRuns', params.id);
    if (!tr) throw notFound('Tool run', params.id);
    return tr;
  }
}
