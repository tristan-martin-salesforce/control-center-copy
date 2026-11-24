'use client';
/**
 * The NBA section of the item detail (UI-SPEC §5.1 anatomy, §12): the next step with the ready-to-go
 * body for its verb:
 *   send / nudge with a draft → the Composer (its Send/Push is the view's one primary);
 *   start_in_claude          → the context pack + Start in Claude (claude:// opened only on click);
 *   run_tool                 → the tool's input form + Run;
 *   answer                   → the waiting run's choices + Answer;
 *   others                   → their single primary.
 * Low confidence shows up to three alternatives instead of one primary. A version line
 * ("v3 · updated 09:58 · why · diff") opens the NBA history. The why line and its evidence live in the
 * detail's Why section (panel/sections.tsx), above this one.
 *
 * v2: `variant="panel"` renders it as the Plan (your steps vs agent steps, agent time in its own
 * background lane) or the draft, and publishes the primary to the panel's sticky footer instead of drawing
 * it (lib/primary.tsx). Sheet and page keep the primary in place.
 */
import { useState, type ReactNode, type RefObject } from 'react';
import type { AgentRun, Draft, NbaAlternative, NbaCard, NbaVerb, Person, WorkItem } from '@/contract';
import { api, type ApiError } from '@/client/api';
import { Composer, type ComposerHandle, type ComposerPrimaryState } from '@/components/composer';
import { RunGlyph, VERB_LABEL } from '@/components/domain';
import { useOptimisticMutation } from '@/client/optimistic';
import { Button, cn, ConfidenceWord, Icon, Popover, Spinner } from '@/ui';
import { fmtWhen } from '../lib/tz';
import { isEnriching } from '../lib/enrichment-state';
import { failFromUrl } from '../lib/mutations';
import { planSteps, planSummary } from '../lib/panel-derive';
import { usePublishPrimary } from '../lib/primary';
import { DetailSection } from '../panel/bits';
import { PlanSteps } from '../panel/sections';
import { ClaudeLaunchPanel, openDeepLink } from './ClaudeLaunchPanel';
import { useLaunchReview } from '@/components/agents/LaunchReview';
import { ToolRunForm } from './ToolRunForm';
import { navigate } from '@/components/shell/router';

export interface NbaSectionProps {
  item: WorkItem;
  nba: NbaCard | null;
  draft: Draft | null;
  runs: AgentRun[];
  people: Person[];
  now: string;
  tz?: string;
  variant: 'sheet' | 'page' | 'panel';
  composerRef?: RefObject<ComposerHandle | null>;
  onConfirmDone: () => void;
  onSnoozeTomorrow: () => void;
  onOpenUrl: (url: string) => void;
  onAskChat: () => void;
  /** Review with related-work chips waiting: move focus to them. Returns false when there's nothing to review. */
  onReviewRelated?: () => boolean;
}

const DRAFT_VERBS: ReadonlySet<NbaVerb> = new Set(['send', 'nudge']);

/** "v3 · updated 09:58 · why · diff", with every version in a popover. */
export function VersionLine({ nba, now, tz, align = 'end' }: { nba: NbaCard; now: string; tz?: string; align?: 'start' | 'end' }) {
  const [diff, setDiff] = useState(false);
  const versions = [...nba.versions].sort((a, b) => b.version - a.version);
  const latest = versions[0];
  const at = latest?.at ?? nba.generatedAt;
  return (
    <div className={cn('flex min-w-0 flex-col gap-1', align === 'end' ? 'items-end' : 'items-start')} data-nba-version>
      <span className="flex min-w-0 items-center gap-1 text-caption text-muted">
        <Popover
          placement={align === 'end' ? 'bottom-end' : 'bottom-start'}
          width={360}
          label="Next-step versions"
          trigger={
            <button type="button" className="rounded-sm font-bold text-fg tabular-nums hover:underline focus-visible:shadow-focus focus-visible:outline-none">
              v{nba.version}
            </button>
          }
        >
          <div className="max-h-80 overflow-y-auto p-3">
            <p className="text-caption font-bold text-muted">Versions</p>
            <ol className="mt-1.5 space-y-2">
              {versions.map((v) => (
                <li key={v.version} className="text-caption">
                  <span className="font-bold text-fg tabular-nums">v{v.version}</span> <span className="text-muted">· {fmtWhen(v.at, now, tz, { today: true })}</span>
                  <p className="text-body text-fg">{v.reason}</p>
                  {v.diffSummary ? <DiffBlock text={v.diffSummary} /> : null}
                </li>
              ))}
              {!versions.length ? <li className="text-caption text-muted">First version.</li> : null}
            </ol>
          </div>
        </Popover>
        <span className="text-faint">·</span>
        <span className="tabular-nums">updated {fmtWhen(at, now, tz)}</span>
        {latest?.reason ? (
          <>
            <span className="text-faint">·</span>
            <span className="max-w-[28ch] truncate" title={latest.reason}>
              {latest.reason}
            </span>
          </>
        ) : null}
        {latest?.diffSummary ? (
          <>
            <span className="text-faint">·</span>
            <button type="button" aria-expanded={diff} onClick={() => setDiff((v) => !v)} className="inline-flex items-center gap-0.5 text-link hover:underline">
              diff <Icon name={diff ? 'chevrondown' : 'chevronright'} size="xs" />
            </button>
          </>
        ) : null}
      </span>
      {diff && latest?.diffSummary ? <DiffBlock text={latest.diffSummary} /> : null}
    </div>
  );
}

function DiffBlock({ text }: { text: string }) {
  return (
    <pre className="mt-1 max-w-full rounded-sm bg-surface-muted px-2 py-1 font-sans text-caption whitespace-pre-wrap">
      {text.split('\n').map((l, i) => (
        <span key={i} className={cn('block', l.startsWith('+') ? 'text-success-700' : l.startsWith('-') ? 'text-danger-700 line-through' : 'text-muted')}>
          {l}
        </span>
      ))}
    </pre>
  );
}

function UpdateStrip({ nba, now, tz }: { nba: NbaCard; now: string; tz?: string }) {
  const u = nba.update;
  if (!u || u.kind !== 'revised' || Date.parse(now) - Date.parse(u.at) > 24 * 3_600_000) return null;
  return (
    <p className="flex items-center gap-1.5 rounded-md bg-surface-muted px-3 py-2 text-caption">
      <Icon name="refresh" size="xs" className="text-ai-700" />
      <span className="text-fg">
        <span className="font-bold">Updated {fmtWhen(u.at, now, tz)}:</span> {u.reason}
      </span>
    </p>
  );
}

function AnswerPanel({ run }: { run: AgentRun }) {
  const [answer, setAnswer] = useState('');
  const send = useOptimisticMutation({ route: 'answerAgent', topics: ['agents', 'item', 'today'], toast: () => ({ title: `Answered: ${run.title}` }), fail: failFromUrl });
  const choices = run.waiting?.choices ?? [];
  const submit = () => answer.trim() && send.mutate({ params: { id: run.id }, body: { answer: answer.trim() } });
  const session = run.kind === 'claude_session';
  const { review, dialog } = useLaunchReview(openDeepLink); // P25-4: a claude://code/new link is reviewed first; a resume opens at once
  const external = usePublishPrimary(
    session
      ? run.deepLink
        ? { label: 'Open in Claude', icon: 'new_window', kbd: 'mod+enter', run: () => review(run.deepLink!, run.title) }
        : null
      : { label: 'Answer', disabled: !answer.trim(), loading: send.isPending, kbd: 'mod+enter', run: () => void submit() },
  );
  if (session) {
    return (
      <div className="rounded-md border border-warning-200 bg-warning-50 px-4 py-3">
        <p className="flex items-center gap-1.5 text-body text-fg">
          <RunGlyph state="waiting_on_you" size={12} />
          <span className="font-bold">Session asked:</span> {run.waiting?.question ?? run.waiting?.reason ?? 'Input needed'}
        </p>
        {run.deepLink && !external ? (
          <Button variant="primary" size="sm" className="mt-2" icon="new_window" onClick={() => review(run.deepLink!, run.title)} data-nba-primary>
            Open in Claude
          </Button>
        ) : null}
        {dialog}
      </div>
    );
  }
  return (
    <div className="rounded-md border border-line bg-surface px-4 py-3" data-answer-panel>
      <p className="text-caption font-bold text-muted">Answer · {run.title}</p>
      <p className="mt-1 max-w-[68ch] text-body text-fg">{run.waiting?.question ?? run.waiting?.reason}</p>
      {choices.length ? (
        <div role="radiogroup" aria-label="Choices" className="mt-2 flex flex-wrap gap-1.5">
          {choices.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={answer === c}
              onClick={() => setAnswer(answer === c ? '' : c)}
              className={cn('h-8 rounded-md border px-3 text-body', answer === c ? 'border-accent bg-selected text-fg-heading' : 'border-line-input bg-surface text-fg hover:bg-surface-muted')}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <input
          value={choices.includes(answer) ? '' : answer}
          onChange={(e) => setAnswer(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), submit())}
          placeholder="Or type a reply…"
          aria-label="Reply"
          className="h-9 min-w-0 flex-1 rounded-md border border-line-input bg-surface-input px-3 text-body placeholder:text-faint focus:border-focus focus:outline-none"
        />
        {!external ? (
          <Button variant="primary" size="sm" kbd="mod+enter" disabled={!answer.trim()} loading={send.isPending} onClick={submit} data-nba-primary>
            Answer
          </Button>
        ) : null}
      </div>
      {send.error ? <p className="mt-1.5 text-caption text-danger-700">Couldn&apos;t send the answer: {send.error.message}</p> : null}
    </div>
  );
}

/** The verb's single primary, in place (sheet, page) or published to the panel footer. */
function VerbPrimary({ label, actionable, onRun }: { label: string; actionable: boolean; onRun: () => void }) {
  const external = usePublishPrimary({ label, disabled: !actionable, hint: actionable ? null : 'Nothing to open yet', kbd: 'mod+enter', run: onRun });
  if (external) return !actionable ? <p className="text-caption text-muted">Nothing to open yet.</p> : null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" kbd="mod+enter" onClick={onRun} disabled={!actionable} data-nba-primary>
        {label}
      </Button>
      {!actionable ? <span className="text-caption text-muted">Nothing to open yet.</span> : null}
    </div>
  );
}

/** Panel: the composer without its own Send; Send/Push and the countdown's Undo go to the footer. */
function PanelComposer({ draft, people, composerRef }: { draft: Draft; people: Person[]; composerRef?: RefObject<ComposerHandle | null> }) {
  const [p, setP] = useState<ComposerPrimaryState | null>(null);
  usePublishPrimary(
    p && !p.hidden
      ? {
          label: p.label,
          icon: p.icon,
          disabled: p.disabled,
          loading: p.loading,
          hint: p.blockedReason,
          kbd: 'mod+enter',
          busyLabel: p.busyLabel,
          countdown: p.countdown ? { ...p.countdown, onUndo: () => composerRef?.current?.undo() } : null,
          run: () => composerRef?.current?.send(),
        }
      : null,
  );
  return <Composer key={draft.id} draft={draft} people={people} ref={composerRef} variant="inline" primaryPlacement="external" onPrimaryChange={setP} />;
}

export function NbaSection(props: NbaSectionProps) {
  const { item, nba, draft, runs, people, now, tz, variant, composerRef } = props;
  const [regen, setRegen] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const panel = variant === 'panel';
  // past the wait an enrichment that never finished (no db enrich worker yet) stops holding the next step
  const enriching = isEnriching(item.enrichment, Date.parse(now)) || item.reevaluating;

  if (!nba) {
    const empty = enriching ? (
      <p className="flex items-center gap-2 text-body text-muted">
        <Spinner size="xs" /> Finding related work. The next step fills in when it&apos;s found.
      </p>
    ) : (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <p className="text-body text-muted">
          <span className="font-bold text-fg">No next step yet.</span> Ask the assistant to propose one, or work it from the evidence.
        </p>
        <Button size="xs" variant="ghost" icon="chat" onClick={props.onAskChat}>
          Ask the assistant
        </Button>
      </div>
    );
    if (panel) {
      const steps = planSteps(item, null, runs);
      return (
        <section aria-label="Plan" data-nba-section="empty">
          <DetailSection title="Plan" suffix={planSummary(item, steps.some((s) => s.who === 'agent'))}>
            <PlanSteps steps={steps} />
            <div className="mt-3">{empty}</div>
          </DetailSection>
        </section>
      );
    }
    return (
      <section aria-label="Next best action" data-nba-section="empty" className="rounded-lg border border-dashed border-line-strong bg-surface px-4 py-3">
        <p className="mb-1.5 flex items-center gap-1.5 text-body font-bold text-fg-heading">
          <Icon name="sparkles" size="xs" className="text-ai-700" />
          Next step
        </p>
        {empty}
      </section>
    );
  }

  const waitingRun = runs.find((r) => r.id === nba.runId) ?? runs.find((r) => r.state === 'waiting_on_you') ?? null;
  const claudeRun = runs.find((r) => r.kind === 'claude_session' && r.state !== 'done') ?? null;
  const alternatives: NbaAlternative[] = nba.confidence === 'guess' ? nba.alternatives.slice(0, 3) : [];
  const useComposer = !!draft && (DRAFT_VERBS.has(nba.verb) || !!nba.draftId);
  const label = nba.primaryLabel || VERB_LABEL[nba.verb];
  const target = item.deliverable?.url ?? item.sources.find((s) => s.url)?.url ?? nba.sources.find((s) => s.url)?.url ?? null;
  const chipsToReview = nba.verb === 'review' && (item.enrichment?.chips.length ?? 0) > 0;
  const actionable = ['confirm_done', 'wait', 'log'].includes(nba.verb) || !!target || chipsToReview;

  const regenerate = async () => {
    setRegen({ busy: true, error: null });
    try {
      await api('regenerateNba', { params: { id: nba.id }, body: { ifVersion: nba.version, instruction: 'regenerate' } }, { fail: failFromUrl() });
      setRegen({ busy: false, error: null });
    } catch (e) {
      setRegen({ busy: false, error: (e as ApiError).message });
    }
  };

  const runVerb = (verb: NbaVerb) => {
    if (verb === 'confirm_done') props.onConfirmDone();
    else if (verb === 'wait') props.onSnoozeTomorrow();
    else if (verb === 'log') navigate('/activity');
    else if ((verb === 'send' || verb === 'nudge') && useComposer) composerRef?.current?.focus();
    else if (verb === 'review' && chipsToReview && props.onReviewRelated?.()) return;
    else if (target) props.onOpenUrl(target);
  };

  let body: ReactNode = null;
  if (useComposer) {
    body = panel ? <PanelComposer draft={draft!} people={people} composerRef={composerRef} /> : <Composer key={draft!.id} draft={draft!} people={people} ref={composerRef} />;
  } else if (nba.verb === 'start_in_claude') {
    body = <ClaudeLaunchPanel item={item} nba={nba} run={claudeRun} now={now} />;
  } else if (nba.verb === 'run_tool' && nba.toolAdapterId) {
    body = <ToolRunForm adapterId={nba.toolAdapterId} item={item} nba={nba} />;
  } else if (nba.verb === 'answer' && waitingRun) {
    body = <AnswerPanel run={waitingRun} />;
  } else if (alternatives.length) {
    body = (
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Alternatives">
        <span className="text-caption text-muted">Not sure. Pick one:</span>
        {alternatives.map((a) => (
          <Button key={a.label} size="sm" variant="secondary" title={a.reason} onClick={() => runVerb(a.verb)}>
            {a.label}
          </Button>
        ))}
      </div>
    );
  } else {
    body = <VerbPrimary label={label} actionable={actionable} onRun={() => runVerb(nba.verb)} />;
  }

  const steps = useComposer ? [] : planSteps(item, nba, runs);
  const hasAgent = steps.some((s) => s.who === 'agent');
  const regenerating = nba.status === 'generating' || item.reevaluating;

  const meta = (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Button size="xs" variant="ghost" icon="refresh" loading={regen.busy} onClick={() => void regenerate()} title="Ask the engine for a fresh next step (a touched draft gets a proposal, never an overwrite)">
        Regenerate
      </Button>
      {regen.error ? (
        <span role="alert" className="text-caption text-danger-700">
          Couldn&apos;t regenerate: {regen.error}
        </span>
      ) : null}
      <span className="ml-auto min-w-0">
        <VersionLine nba={nba} now={now} tz={tz} />
      </span>
    </div>
  );

  if (panel) {
    return (
      <section aria-label="Plan" data-nba-section={nba.verb} className="space-y-3">
        <DetailSection
          title={useComposer ? 'Draft' : 'Plan'}
          suffix={
            <>
              {useComposer ? planSummary(item, false) : planSummary(item, hasAgent)}
              {regenerating ? (
                <span className="ml-2 inline-flex items-center gap-1 text-ai-700">
                  <Spinner size="xs" /> re-evaluating…
                </span>
              ) : null}
            </>
          }
        >
          {steps.length ? <PlanSteps steps={steps} /> : null}
          {!useComposer ? <UpdateStrip nba={nba} now={now} tz={tz} /> : null}
          {body ? <div className={cn(steps.length && 'mt-3')}>{body}</div> : null}
        </DetailSection>
        {meta}
      </section>
    );
  }

  return (
    <section aria-label="Next best action" data-nba-section={nba.verb} className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className="text-body font-bold text-fg-heading">Next step</h3>
        {/* Violet marks what the engine proposed (DESIGN-V2: AI). */}
        <span className="inline-flex items-center gap-1 text-caption font-bold text-ai-700">
          <Icon name="sparkles" size="xs" />
          {VERB_LABEL[nba.verb]}
        </span>
        <ConfidenceWord value={nba.confidence} />
        {regenerating ? (
          <span className="inline-flex items-center gap-1 text-caption text-ai-700">
            <Spinner size="xs" /> re-evaluating…
          </span>
        ) : null}
      </div>
      <p className="max-w-[68ch] text-body-lg font-bold text-fg-heading">{nba.title}</p>
      {steps.length ? <PlanSteps steps={steps} /> : null}
      {!useComposer ? <UpdateStrip nba={nba} now={now} tz={tz} /> : null}
      {body}
      {meta}
    </section>
  );
}
