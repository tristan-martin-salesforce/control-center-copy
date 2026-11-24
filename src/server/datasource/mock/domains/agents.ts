/**
 * The mock DataSource, agents domain (R7: one file per domain; MockDataSource keeps one-line delegates).
 */
import type { MockCtx } from '../ctx';
import { id, uniq, I, Res } from '../shared';
import { nanoid } from 'nanoid';
import { type AgentRun, type ToolRun, type WorkItemRecord, requiredFieldKeys } from '@/contract';
import { validateInput } from '@/tools/manifest';
import { AppError, invalid } from '@/server/errors';
import { Store } from '../store';
import { agentsView, toolsView } from '@/server/views/agents';
import { PREPARED_LAUNCH_EVENT } from '../../types/agents';

function buildLaunchPrompt(item: WorkItemRecord, store: Store): string {
  const ini = item.initiativeId ? store.get('initiatives', item.initiativeId) : undefined;
  const acc = item.accountId ? store.get('accounts', item.accountId) : undefined;
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

export class MockAgents {
  constructor(private readonly ctx: MockCtx) {}

  async getAgents(_i: I<'getAgents'>): Promise<Res<'getAgents'>> {
    return agentsView(this.ctx.store);
  }

  async launchAgent({ body }: I<'launchAgent'>): Promise<Res<'launchAgent'>> {
    const item = body.workItemId ? this.ctx.item(body.workItemId) : undefined;
    const folder = body.folder ?? this.ctx.store.meta().repoFolder ?? process.cwd();
    let prompt = body.prompt ?? (item ? buildLaunchPrompt(item, this.ctx.store) : 'New session from Command Center');
    if (item && !prompt.includes(`[cc:${item.id}]`)) prompt = `${prompt}\n\n[cc:${item.id}]`;
    if (prompt.length > 14336) prompt = prompt.slice(0, 14336 - (item ? item.id.length + 8 : 0)) + (item ? `\n[cc:${item.id}]` : '');
    const url = `claude://code/new?folder=${encodeURIComponent(folder)}&q=${encodeURIComponent(prompt)}`;
    const run: AgentRun = {
      id: id('run'),
      kind: 'claude_session',
      title: body.title ?? item?.title ?? 'New Claude session',
      workItemId: item?.id ?? null,
      state: 'queued',
      startedAt: this.ctx.nowIso(),
      updatedAt: this.ctx.nowIso(),
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
    this.ctx.tx({ actor: 'user', action: 'agent.launch', summary: `Started in Claude: ${run.title}`, entity: { type: 'agent_run', id: run.id, label: run.title } }, (tx) => {
      tx.put('agentRuns', run);
      if (item) tx.put('workItems', this.ctx.bump({ ...item, state: item.state === 'open' || item.state === 'reopened' ? 'in_progress' : item.state, runIds: uniq([...item.runIds, run.id]) }));
    });
    this.ctx.later(this.ctx.delays.stepMs, () => {
      const cur = this.ctx.store.get('agentRuns', run.id);
      if (!cur || cur.state !== 'queued') return;
      const sessionId = `mock-${nanoid(8)}`;
      this.ctx.tx({ actor: 'system', action: 'run.running', summary: `${run.title}: running`, entity: { type: 'agent_run', id: run.id, label: run.title }, audit: false }, (tx) =>
        tx.put('agentRuns', { ...cur, state: 'running', sessionId, deepLink: `claude://code/continue?session=${sessionId}`, lastEvent: 'Session registered (mock)', updatedAt: this.ctx.nowIso() }),
      );
    });
    return { url, run };
  }

  async answerAgent({ params, body }: I<'answerAgent'>): Promise<Res<'answerAgent'>> {
    const run = this.ctx.store.must('agentRuns', params.id, 'Agent run');
    if (run.kind === 'claude_session') throw invalid('Claude sessions are answered in Claude: use Open in Claude');
    if (run.state !== 'waiting_on_you') throw invalid(`Run is ${run.state}, not waiting on you`);
    const next: AgentRun = { ...run, state: 'running', waiting: null, lastEvent: `You answered: ${body.answer}`, updatedAt: this.ctx.nowIso() };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'agent.answer', summary: `Answered: ${run.title}`, entity: { type: 'agent_run', id: run.id, label: run.title } }, (tx) => {
      tx.put('agentRuns', next);
      const item = run.workItemId ? this.ctx.store.get('workItems', run.workItemId) : undefined;
      if (item?.state === 'waiting_on_me') tx.put('workItems', this.ctx.bump({ ...item, state: 'in_progress', waiting: null }));
    });
    this.ctx.later(this.ctx.delays.stepMs * 2, () => {
      const cur = this.ctx.store.get('agentRuns', run.id);
      if (cur?.state === 'running') this.ctx.ds.engine.engineRunState(run.id, 'done_review', 'Finished · ready for review', undefined, { actor: 'system' });
    });
    return { entity: next, auditId: entry?.id ?? null };
  }

  async cancelAgent({ params }: I<'cancelAgent'>): Promise<Res<'cancelAgent'>> {
    const run = this.ctx.store.must('agentRuns', params.id, 'Agent run');
    if (run.kind === 'claude_session') throw invalid('Stop Claude sessions in Claude');
    if (!['queued', 'running', 'waiting_on_you', 'stale'].includes(run.state)) throw invalid(`Run is ${run.state}`);
    const next: AgentRun = { ...run, state: 'failed', error: 'Cancelled by you', lastEvent: 'Cancelled', updatedAt: this.ctx.nowIso(), finishedAt: this.ctx.nowIso() };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'agent.cancel', summary: `Cancelled: ${run.title}`, entity: { type: 'agent_run', id: run.id, label: run.title } }, (tx) => {
      tx.put('agentRuns', next);
      if (run.toolRunId) {
        const tr = this.ctx.store.get('toolRuns', run.toolRunId);
        if (tr) tx.put('toolRuns', { ...tr, status: 'cancelled', finishedAt: this.ctx.nowIso(), error: 'Cancelled by you' });
      }
    });
    return { entity: next, auditId: entry?.id ?? null };
  }

  async getTools(_i: I<'getTools'>): Promise<Res<'getTools'>> {
    return toolsView(this.ctx.store);
  }

  async startToolRun({ params, body }: I<'startToolRun'>): Promise<Res<'startToolRun'>> {
    const adapter = this.ctx.store.must('toolAdapters', params.id, 'Tool');
    if (!adapter.enabled) throw invalid(`${adapter.name} is disabled`);
    if (adapter.health.state === 'down') throw new AppError('upstream_unavailable', `${adapter.name} is not running (health check failed). Start it from Agents ▸ Tools, then run again.`);
    const missing = requiredFieldKeys(adapter).filter((k) => body.inputs[k] === undefined || body.inputs[k] === '');
    if (missing.length) throw invalid(`Missing inputs: ${missing.join(', ')}`, { missing });
    const checked = validateInput({ input: { fields: adapter.fields } }, body.inputs);
    if (!checked.ok) throw invalid(`Invalid inputs: ${checked.errors.join('; ')}`, { errors: checked.errors });
    const runId = id('tr');
    const agentRunId = id('run');
    const steps = 3;
    const tr: ToolRun = { id: runId, adapterId: adapter.id, workItemId: body.workItemId ?? null, nbaId: body.nbaId ?? null, inputs: body.inputs, status: 'queued', progress: { done: 0, total: steps, label: 'Queued' }, linkUrl: null, linkLabel: null, artifacts: [], startedAt: this.ctx.nowIso(), finishedAt: null, error: null, agentRunId };
    const ar: AgentRun = { id: agentRunId, kind: 'tool_run', title: `${adapter.name}${body.inputs.name ? `: ${String(body.inputs.name)}` : ''}`, workItemId: body.workItemId ?? null, state: 'queued', startedAt: this.ctx.nowIso(), updatedAt: this.ctx.nowIso(), finishedAt: null, lastEvent: 'Queued', waiting: null, deepLink: `/agents?run=${agentRunId}`, sessionId: null, cwd: null, bgAgents: 0, toolRunId: runId, progress: tr.progress, resultUrl: null, error: null, costUsd: null, scheduled: false };
    const { entry } = this.ctx.tx({ actor: 'user', action: 'tool.run', summary: `Ran ${adapter.name}`, entity: { type: 'tool_run', id: runId, label: ar.title } }, (tx) => {
      tx.put('toolRuns', tr);
      tx.put('agentRuns', ar);
      tx.put('toolAdapters', { ...adapter, recentRunIds: [runId, ...adapter.recentRunIds].slice(0, 10) });
      const item = body.workItemId ? this.ctx.store.get('workItems', body.workItemId) : undefined;
      if (item) tx.put('workItems', this.ctx.bump({ ...item, state: item.state === 'open' ? 'in_progress' : item.state, runIds: uniq([...item.runIds, agentRunId]) }));
    });
    const step = (n: number) => {
      const cur = this.ctx.store.get('toolRuns', runId);
      const run = this.ctx.store.get('agentRuns', agentRunId);
      if (!cur || !run || cur.status === 'cancelled' || cur.status === 'failed') return;
      const done = n >= steps;
      // The (compatibility) manifest's link template, else an in-app link to the run.
      const tpl = adapter.manifest.output.link;
      const link = tpl ? { url: tpl.url.replace(/\{\{\s*[\w.]+\s*\}\}/g, runId), label: tpl.label } : { url: `/agents?toolRun=${runId}`, label: 'Open run' };
      const progress = { done: n, total: steps, label: done ? 'Done' : `Step ${n} of ${steps}` };
      this.ctx.tx({ actor: 'system', action: done ? 'tool.succeeded' : 'tool.progress', summary: `${ar.title}: ${progress.label}`, entity: { type: 'tool_run', id: runId, label: ar.title }, audit: false, notify: done ? { channel: 'toast', title: `${adapter.name} finished`, tone: 'ok', href: link.url } : undefined }, (tx) => {
        tx.put('toolRuns', { ...cur, status: done ? 'succeeded' : n === 0 ? 'starting' : 'running', progress, ...(done ? { finishedAt: this.ctx.nowIso(), linkUrl: link.url, linkLabel: link.label } : {}) });
        tx.put('agentRuns', { ...run, state: done ? 'done_review' : 'running', progress, lastEvent: progress.label, updatedAt: this.ctx.nowIso(), ...(done ? { finishedAt: this.ctx.nowIso(), resultUrl: link.url } : {}) });
      });
      if (!done) this.ctx.later(this.ctx.delays.stepMs, () => step(n + 1));
    };
    this.ctx.later(this.ctx.delays.stepMs / 3, () => step(0));
    return { entity: tr, auditId: entry?.id ?? null };
  }

  async getToolRun({ params }: I<'getToolRun'>): Promise<Res<'getToolRun'>> {
    return this.ctx.store.must('toolRuns', params.id, 'Tool run');
  }
}
