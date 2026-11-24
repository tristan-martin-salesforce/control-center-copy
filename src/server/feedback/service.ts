/**
 * The feedback routes (D-56), shared by both DataSources through `FeedbackHost`:
 *
 *   feedbackState   GET  /feedback            channel, dry run, post live, server build, reporter, agent on/off
 *   diagnoseFeedback POST /feedback/diagnose  scrub the text → the read-only agent (or the fallback) → scrub the report
 *                                             → the Slack message the user edits. Nothing is sent or written (spend only).
 *   stageFeedback   POST /feedback/reports    scrub the edited message again → ONE Outbox item (feedback.post, ready) to
 *                                             the server-resolved channel → its preview + confirm token.
 *
 * Send is the existing `POST /drafts/:id/dispatch` with that token: the confirm proof binds this exact payload, global
 * dry run applies (and "Post live" off), and the live relay posts only to the configured channel.
 */
import { ledgerHash } from '@/db/ledger';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { FeedbackContextInput, type DiagnoseFeedbackRequest, type DiagnoseFeedbackResult, type FeedbackChannelState, type FeedbackReport, type FeedbackState, type MutationResult, type Settings, type StageFeedbackRequest, type StageFeedbackResult } from '@/contract';
import { feedbackActionFor } from '@/lib/feedback/payload';
import { loadSkill } from '@/llm/skill-loader';
import { personaOf } from '@/personas';
import { invalid } from '@/server/errors';
import { buildInfo } from '@/server/version';

import { FEEDBACK_CAP_USD, FEEDBACK_MODEL, FEEDBACK_SKILL, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, type FinishOutput } from './agent';
import { readTeamConfig, resolveFeedbackChannel } from './channel';
import { fallbackReport, pageFilesFor, reportContext } from './fallback';
import { collectDiagnostics, diagnosticsBlock } from './diagnostics';
import { buildFlags, firstName, formatFeedbackMessage } from './format';
import { serverVersion, type FeedbackHost } from './host';
import { feedbackReads } from './reads';
import { Scrubber } from './scrub';
import { holdGate, PAUSED_FOR_SPEND } from '@/llm/spend';

/** Below this the agent is not worth starting: the fallback report runs. */
export const MIN_AGENT_USD = 0.05;
const REPORTER_LINE = /\n*_Reported by [^\n]*_\s*$/;

async function settingsOf(h: FeedbackHost): Promise<Settings> {
  return (await h.ds.getSettings({} as never)) as Settings;
}

function channelOf(h: FeedbackHost, s: Settings): FeedbackChannelState {
  return resolveFeedbackChannel(s.feedback, s.sending, (h.team ?? (() => readTeamConfig()))());
}

const personaLabel = (s: Settings) => {
  const p = personaOf(s);
  return p.levelLabel || p.label;
};

export async function feedbackState(h: FeedbackHost): Promise<FeedbackState> {
  const s = await settingsOf(h);
  const v = serverVersion(h.repoRoot);
  const b = h.agent ? await h.budget() : { capUsd: 0, note: null };
  return { channel: channelOf(h, s), version: v.version, sha: v.sha, reporter: firstName(await h.me()), agent: !!h.agent, capUsd: h.agent ? Math.max(0, Math.min(FEEDBACK_CAP_USD, b.capUsd)) : 0 };
}

/** The context with the server's build and persona filled in where the browser had none, and every string scrubbed. */
function safeContext(raw: FeedbackContextInput, s: Settings, sc: Scrubber, repoRoot?: string): FeedbackContextInput {
  const v = serverVersion(repoRoot);
  return {
    page: sc.scrub(raw.page),
    route: sc.scrubRoute(raw.route),
    lookingAt: raw.lookingAt ? { kind: raw.lookingAt.kind, id: sc.scrubRoute(raw.lookingAt.id), label: sc.scrub(raw.lookingAt.label) } : null,
    version: raw.version || v.version,
    sha: raw.sha ?? v.sha,
    persona: raw.persona ?? personaLabel(s),
    clientErrors: raw.clientErrors.map((e) => sc.scrub(e).slice(0, 400)),
    viewport: raw.viewport,
  };
}

/** PKG-8: the source tree is on this machine (a git checkout), so the agent may read code; a packaged build has none. */
export function hasSourceTree(repoRoot: string | undefined): boolean {
  try {
    return fs.existsSync(path.join(repoRoot ?? process.cwd(), 'src'));
  } catch {
    return false;
  }
}

function runPrompt(kind: string, text: string, ctx: FeedbackContextInput, o: { source: boolean; codes?: string } = { source: true }): string {
  const lines = [
    `Kind: ${kind}`,
    `Page: ${[ctx.page, ctx.route].filter(Boolean).join(' · ') || '(unknown)'}`,
    ctx.lookingAt ? `Looking at: ${ctx.lookingAt.kind.replace(/_/g, ' ')}${ctx.lookingAt.label ? ` "${ctx.lookingAt.label}"` : ''} (use feedback_entity${ctx.lookingAt.kind === 'work_item' ? ' and feedback_trace' : ''})` : 'Looking at: nothing in particular',
    `Persona: ${ctx.persona ?? '(unknown)'} · version ${ctx.version || '?'}${ctx.sha ? ` (${ctx.sha.slice(0, 7)})` : ''}${buildFlags(buildInfo()).map((f) => ` · ${f}`).join('')}`,
    ctx.viewport ? `Viewport: ${ctx.viewport}` : null,
    ctx.clientErrors.length ? `Browser errors (newest last):\n${ctx.clientErrors.map((e) => `- ${e}`).join('\n')}` : 'Browser errors: none',
    o.source && pageFilesFor(ctx.route).length ? `The page's code starts at: ${pageFilesFor(ctx.route).join(', ')}` : null,
    o.source ? null : 'The source code is not on this machine (a packaged build): diagnose from the feedback_* reads only. Read, Grep and Glob are not available; leave diagnosis.files empty.',
    o.codes ? `Error codes on this install (from the Diagnostics block): ${o.codes}` : null,
    '',
    'The user wrote:',
    '"""',
    text,
    '"""',
    '',
    'Diagnose it and call feedback_finish once.',
  ];
  return lines.filter((l) => l !== null).join('\n');
}

function reportFrom(out: FinishOutput, kind: FeedbackReport['kind'], ctx: FeedbackContextInput): FeedbackReport {
  return {
    title: out.title,
    kind,
    summary: out.summary,
    steps: out.steps,
    expected: out.expected,
    actual: out.actual,
    diagnosis: { cause: out.diagnosis.cause, files: [...new Set(out.diagnosis.files.map((f) => f.replace(/^\.\//, '')))].slice(0, 8), confidence: out.diagnosis.confidence },
    context: reportContext(ctx),
  };
}

/** Every string of the report through the scrubber (the second pass), and the context kept as built. */
export function scrubReport(r: FeedbackReport, sc: Scrubber): FeedbackReport {
  const { context, ...rest } = r;
  return { ...sc.scrubValue(rest), context: { ...context, page: sc.scrubRoute(context.page) } };
}

export async function diagnoseFeedback(h: FeedbackHost, body: DiagnoseFeedbackRequest, opts: { signal?: AbortSignal } = {}): Promise<DiagnoseFeedbackResult> {
  const s = await settingsOf(h);
  const channel = channelOf(h, s);
  const sc = new Scrubber(await h.terms());
  const raw = FeedbackContextInput.parse(body.context ?? {});
  // Pass 1: the user's own words and the captured context, before anything (agent, fallback, log) sees them.
  const text = sc.scrub(body.text);
  const ctx = safeContext(raw, s, sc, h.repoRoot);
  // The reads use the real ids (to find the entity) and scrub what they return.
  const reads = feedbackReads(h.ds, raw, sc);
  // PKG-8 / R8: the machine diagnostics (codes, states, redacted log tail) that go into the post, and the agent's mode
  const source = hasSourceTree(h.repoRoot);
  const diag = await collectDiagnostics(h).catch(() => null);

  let report: FeedbackReport | null = null;
  let diagnosedBy: DiagnoseFeedbackResult['diagnosedBy'] = 'fallback';
  let model: string | null = null;
  let costUsd = 0;
  let note: string | null = h.agent ? null : 'Diagnosed without a model call (the Assistant’s model is off here)';
  if (h.agent) {
    const b = await h.budget();
    const cap = Math.min(FEEDBACK_CAP_USD, b.capUsd);
    if (cap < MIN_AGENT_USD) note = b.note ?? 'The Assistant’s daily limit is used up, so this was diagnosed without a model call';
    else {
      const skill = loadSkill(FEEDBACK_SKILL);
      const prompt = runPrompt(body.kind, text, ctx, { source, codes: diag ? [...diag.events.map((e) => e.code), ...diag.connectors.flatMap((c) => (c.code ? [c.code] : []))].filter((c, i, a) => a.indexOf(c) === i).slice(0, 10).join(', ') : '' });
      // F-4: the report holds its estimate (the governor); past it the run asks in Health ▸ Spend and waits for you
      const gov = h.spend ? await h.spend().catch(() => null) : null;
      const held = gov ? await gov.estimate({ scope: 'feedback', jobKey: 'feedback', skill: 'feedback-diagnose' }).then((est) => gov.hold({ scope: 'feedback', jobKey: `feedback:${randomUUID()}`, skill: 'feedback-diagnose', model: FEEDBACK_MODEL }, est)).catch(() => null) : null;
      const gate = gov && held?.ok ? holdGate(gov, held.hold, { minCeilingUsd: cap }) : null;
      const run = await h.agent.run({
        runId: `fb_${randomUUID().slice(0, 8)}`,
        model: FEEDBACK_MODEL,
        systemPrompt: [skill.body, SYSTEM_PROMPT_DYNAMIC_BOUNDARY, `Today is ${h.now().toISOString().slice(0, 10)}. The working directory is the app's repo folder.`],
        prompt,
        reads,
        repoRoot: h.repoRoot ?? process.cwd(),
        codeTools: source,
        costCapUsd: cap,
        ...(gate ? { spend: gate, userLineUsd: b.capUsd } : {}),
        signal: opts.signal ?? new AbortController().signal,
      }).finally(async () => {
        if (gate && gov) await gov.settle(gate.hold, gate.hold.spentUsd).catch(() => undefined);
      });
      model = run.model;
      costUsd = run.costUsd;
      await h.recordSpend({ model: run.model, skill: skill.versionTag, costUsd: run.costUsd, inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens ?? 0, cacheWriteTokens: run.cacheWriteTokens ?? 0, contentHash: ledgerHash(run.model, skill.versionTag, skill.body, prompt), ok: run.ok, ...(run.error ? { errorCode: run.error.code } : {}), latencyMs: run.latencyMs }).catch(() => undefined);
      if (run.ok && run.output) {
        report = reportFrom(run.output, body.kind, ctx);
        diagnosedBy = 'agent';
      } else if (run.error?.code === PAUSED_FOR_SPEND) note = 'The diagnose run reached its spend estimate and no more was allowed, so this report is the app’s own reading';
      else note = `The diagnose run stopped (${run.error?.code ?? 'no report'}), so this report is the app’s own reading`;
    }
  }
  report ??= await fallbackReport({ kind: body.kind, text, ctx, reads });
  // Pass 2: the report itself, whatever wrote it.
  report = scrubReport(report, sc);
  // PKG-4: modified + channel; PKG-8: the scrubbed Diagnostics block (the user sees and edits it all before Send)
  const message = formatFeedbackMessage(report, await h.me(), buildInfo(), diag ? diagnosticsBlock(diag, sc) : null);
  return { report, message, scrubbed: sc.stats.count, diagnosedBy, model, costUsd, note, channel };
}

export async function stageFeedback(h: FeedbackHost, body: StageFeedbackRequest): Promise<MutationResult<StageFeedbackResult>> {
  const s = await settingsOf(h);
  const channel = channelOf(h, s);
  if (!channel.id) throw invalid('No feedback channel is set: add its id in Settings ▸ Feedback (or config/team.json)', { field: 'channelId' });
  const sc = new Scrubber(await h.terms());
  // Pass 3: the edited message and the stored report. The reporter line is the server's own (first name only).
  const report = scrubReport(body.report, sc);
  const bodyText = sc.scrub(body.message.replace(REPORTER_LINE, '').trimEnd());
  const who = firstName(await h.me());
  const text = who ? `${bodyText}\n\n_Reported by ${who}_` : bodyText;
  if (body.replaces) {
    // The user went back and edited: the earlier item leaves the Outbox (nothing was sent from it).
    try {
      const prev = await h.ds.getDraft({ params: { id: body.replaces } } as never);
      if (prev.destination.kind === 'action' && prev.destination.action === 'feedback.post' && prev.status === 'ready') {
        await h.ds.rejectDraft({ params: { id: prev.id }, body: { reason: 'Replaced by an edited report' } } as never);
      }
    } catch {
      /* gone already */
    }
  }
  const dest = feedbackActionFor({ channelId: channel.id, channelName: channel.name, text, title: report.title, kind: report.kind, report });
  const { draft, auditId } = await h.insertAction(dest, { action: 'feedback.stage', summary: `Feedback for ${dest.target.label}: ${report.title}`.slice(0, 200) });
  const preview = await h.ds.previewDraft({ params: { id: draft.id }, body: { mode: 'send' } } as never);
  return { entity: { draft, preview: { ...preview, dryRun: preview.dryRun || !channel.postLive }, channel, scrubbed: sc.stats.count }, auditId };
}
