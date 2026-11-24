'use client';
/**
 * One Outbox row (UI-SPEC §12; design v2): a configuration of the kit's ActionRow (01-ui-audit R10).
 *
 *   ▌ Slack · #channel · thread ······························· For: the task · drafted 9m ago
 *   ▌ [status] the message's first line, rendered from the payload ··········· Approve & send
 *
 * Pending and scheduled rows have a DASHED edge, so nothing looks sent before it is. The status badge is
 * the row's one colour (red failed, amber unverified, green verified, blue sending); a dry run says
 * "rendered, nothing sent". Space expands the message it replies to, the exact preview, the payload's history and
 * every attempt (the row's expansion). Click or Enter opens the draft in the docked panel (the composer, with its own
 * Send and confirm). "Open in Slack" / "Open in Gmail" (o, the row's source link) opens the message it answers
 * (tenet: Provenance on everything). The page's list keys (a, e, j/k) stay on the page (useListKeys).
 *
 * D-90 (W12-7) release items (./release.ts): the row carries the version, the channel or Drive folder and the sha256
 * short; the announcement's verb is the usual Approve & send; the upload hand-off's verbs are "Copy upload instructions"
 * then "Mark uploaded" (no tool call: it records that you put the files in Drive). A missing folder or channel is said
 * on the row, and its verb is off.
 */
import { AppLink } from '@/components/shell/AppLink';
import { useState, type ReactNode } from 'react';
import type { OutboxItem } from '@/contract';
import { destinationLabel, RecipientPreview } from '@/components/composer';
import { StatusBadge, type Indicator } from '@/components/domain';
import { ActionRow, type ActionRowOverflow } from '@/components/kit';
import { approveLabel, canApprove, lastDryRun, outboxStatus, sentResultUrl, stagedWhere } from '@/components/lists/outbox';
import { fmtAgo, fmtClock, fmtDay, Icon } from '@/ui';
import type { DocNode } from '@/lib/compose';
import { actionApp } from '@/lib/actions';
import { openInLabel } from '@/components/domain/lib/source-link';
import { ReplyingTo } from '@/components/detail/ReplyingTo';
import { openDeepLink } from '@/components/detail/nba/ClaudeLaunchPanel';
import { copySlackbotPrompt, OpenResult, useCanvasPromptOf } from '@/components/domain/ResultLinks';
import { handoffVerbs, releaseRowView } from './release';
import { copyInstructions, ReleaseFacts } from './ReleaseParts';

export interface RowFlow {
  phase: 'idle' | 'working' | 'error' | 'done';
  error?: string | null;
  retryable?: boolean;
  outcome?: 'dry_run' | 'staged' | 'sent' | null;
}

export interface OutboxRowProps {
  item: OutboxItem;
  dryRun: boolean;
  now: string;
  tz?: string;
  expanded: boolean;
  flow: RowFlow;
  busy: boolean;
  rowProps: Record<string, unknown>;
  selected: boolean;
  emphasis: boolean;
  inPanel: boolean;
  onApprove: () => void;
  /** REJECT-1: POST /drafts/:id/reject; the row leaves the Outbox, nothing is sent. */
  onReject: () => void;
  onEdit: () => void;
  onOpen: (mode: 'details' | 'page') => void;
  onExpand: () => void;
  onRetryFlow: () => void;
  onDismissFlow: () => void;
  /** D-90: "Mark uploaded" on a release upload hand-off (the page calls the server, then refetches). */
  onMarkUploaded?: () => void;
}

/** The message a row answers, as "Open in Slack" / "Open in Gmail" (null when nothing links back). */
export function rowSource(item: Pick<OutboxItem, 'source'>): { url: string; label: string; where: string } | null {
  const s = item.source;
  return s?.url ? { url: s.url, label: openInLabel(s.kind), where: s.label } : null;
}

const TONE_EDGE: Record<string, Indicator> = { risk: 'danger', warn: 'warning', ok: 'success', brand: 'now', neutral: 'none', ai: 'ai' };

export function OutboxRow({ item, dryRun, now, tz, expanded, flow, busy, rowProps, selected, emphasis, inPanel, onApprove, onReject, onEdit, onOpen, onExpand, onRetryFlow, onDismissFlow, onMarkUploaded }: OutboxRowProps) {
  const d = item.draft;
  const rel = releaseRowView(d);
  const [copied, setCopied] = useState(false);
  const status = outboxStatus(d, item.group, tz);
  const dry = lastDryRun(d);
  const approvable = canApprove(item.group);
  const sending = d.status === 'sending';
  // The message itself, on one line (a greeting alone says nothing): lines joined, cut by the row.
  const firstLine = rel ? rel.why : (item.previewText || d.plainText).split('\n').map((l) => l.trim()).filter(Boolean).join('  ');

  // One signal per row. Pending rows carry none (the section says "Approve"); a dry run is a neutral fact.
  const badge: ReactNode =
    flow.phase === 'error' ? (
      <StatusBadge tone="danger" icon="error">
        Not sent
      </StatusBadge>
    ) : item.group === 'pending_approval' && !sending ? (
      dry ? (
        <StatusBadge tone="neutral" icon="lock" title="The payload was rendered and recorded. Nothing was sent.">
          Dry run · rendered {fmtClock(dry.at, tz)}
        </StatusBadge>
      ) : null
    ) : sending ? (
      <StatusBadge tone="now">● Sending</StatusBadge>
    ) : rel?.kind === 'upload' && item.group === 'sent' ? (
      <StatusBadge tone="neutral" icon="check" title="You marked the files uploaded. The app sent nothing (its Drive access is read-only).">
        Handed off
      </StatusBadge>
    ) : (
      <StatusBadge tone={status.tone === 'risk' ? 'danger' : status.tone === 'warn' ? 'warning' : status.tone === 'ok' ? 'success' : 'neutral'} icon={status.tone === 'ok' ? 'check' : status.tone === 'risk' ? 'error' : status.tone === 'warn' ? 'warning' : item.group === 'scheduled' ? 'clock' : undefined}>
        {status.label}
      </StatusBadge>
    );
  const edge: Indicator = flow.phase === 'error' ? 'danger' : item.group === 'pending_approval' && !sending ? 'none' : sending ? 'now' : (TONE_EDGE[status.tone] ?? 'none');

  const src = rowSource(item);
  // An applied action (a canvas, a VDP change, the feedback post): where its result lives, and a canvas's Slackbot prompt
  const isAction = d.destination.kind === 'action';
  const applied = isAction && item.group === 'sent';
  const result = applied && d.resultUrl ? d.resultUrl : null;
  // A sent message (or a pushed draft): where it landed, beside the message it answered.
  const sentUrl = sentResultUrl(d, item.group);
  const sentWhere = d.status === 'staged' ? 'the draft' : 'what you sent';
  const prompt = useCanvasPromptOf()(d);
  const actionTitle = d.destination.kind === 'action' ? d.destination.target.label : '';
  // The source link is the row's own (on the why line, `o`); the rest are overflow verbs: three icons, then ⋯.
  const overflow: ActionRowOverflow[] = [
    ...(item.group !== 'sent' ? [{ id: 'edit', label: 'Edit in the panel', k: 'e', icon: 'edit', onClick: onEdit, testId: 'edit' }] : []),
    { id: 'preview', label: expanded ? 'Hide the preview' : 'Preview and history', k: 'Space', icon: 'preview', onClick: onExpand, testId: 'preview' },
    ...(approvable && item.group !== 'failed'
      ? [{ id: 'reject', label: 'Reject', icon: 'close', onClick: onReject, title: 'Reject: it leaves the Outbox, nothing is sent, the task stays open (Undo on the toast)', testId: 'reject' }]
      : []),
    ...(sentUrl ? [{ id: 'sent', label: 'View sent', icon: 'new_window', onClick: () => openDeepLink(sentUrl), title: `Open ${sentWhere} in ${d.destination.kind === 'slack' ? 'Slack' : 'Gmail'}`, testId: 'row-sent' }] : []),
    ...(result ? [{ id: 'result', label: 'Open the result', icon: 'new_window', onClick: () => openDeepLink(result), title: `Open it in ${d.destination.kind === 'action' ? actionApp(d.destination.action) : 'its app'}`, testId: 'row-result' }] : []),
    ...(applied && prompt ? [{ id: 'prompt', label: 'Copy Slackbot prompt', icon: 'copy', onClick: () => void copySlackbotPrompt(prompt, actionTitle), title: 'Copy the prompt that tells Slackbot to execute this canvas', testId: 'row-prompt' }] : []),
  ];

  // D-90: the release items' verbs (the hand-off never sends: Copy upload instructions, then Mark uploaded)
  const approveVerb = approvable
    ? {
        // an announcement is a post (sent), not an applied change
        label: rel?.kind === 'announce' && item.group !== 'failed' ? 'Approve & send' : approveLabel(d, item.group, false),
        kbd: 'a',
        loading: busy,
        onClick: onApprove,
        disabled: !!rel?.missing,
        title: rel?.missing ?? (dryRun ? 'Dry run: shows the exact payload, then renders it. Nothing is sent.' : 'Shows the exact payload first. Nothing is sent until you confirm.'),
      }
    : null;
  const hv = rel?.kind === 'upload' ? handoffVerbs(copied, rel.missing) : null;
  const copyVerb = { label: 'Copy upload instructions', icon: 'copy', onClick: () => void copyInstructions(d).then((ok) => ok && setCopied(true)), title: 'The exact prompt for Claude Code: upload the three files to the folder', testId: 'release-copy' };
  const markVerb = { label: 'Mark uploaded', kbd: 'a', loading: busy, disabled: hv?.markDisabled, onClick: () => onMarkUploaded?.(), title: rel?.missing ?? 'You put the files in Drive: the app records the hand-off. Nothing is sent.', testId: 'release-mark' };
  const verb = hv && approvable ? (hv.primary === 'mark' ? markVerb : copyVerb) : approveVerb;
  const altVerb = hv && approvable ? (hv.primary === 'mark' ? copyVerb : markVerb) : null;
  const chips = rel ? (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="release-chips">
      {rel.chips.map((c) => (
        <span key={c} className="rounded-sm bg-surface-muted px-1.5 text-caption text-muted tabular-nums">
          {c}
        </span>
      ))}
    </span>
  ) : undefined;

  return (
    <ActionRow
      id={d.id}
      data-testid="outbox-row"
      data-group={item.group}
      data-guide={item.group === 'pending_approval' ? 'outbox-ready' : undefined}
      data-draft-id={d.id}
      data-release={rel?.kind}
      {...rowProps}
      title={destinationLabel(d.destination)}
      why={<span data-testid="outbox-preview">{firstLine}</span>}
      whyTitle={firstLine}
      chips={chips}
      badge={badge}
      meta={
        <>
          {sentUrl ? (
            <a
              href={sentUrl}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="row-sent-link"
              title={`Open ${sentWhere} in ${d.destination.kind === 'slack' ? 'Slack' : 'Gmail'}`}
              className="inline-flex shrink-0 items-center gap-1 font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none"
            >
              View sent ↗
            </a>
          ) : null}
          {item.workItem ? (
            <AppLink href={`/work/${item.workItem.id}`} className="max-w-72 truncate text-muted hover:text-fg hover:underline" title={item.workItem.title}>
              For: {item.workItem.title}
            </AppLink>
          ) : null}
          {result ? <OpenResult href={result} label="Open" testId="row-result-link" /> : null}
          {/* a pushed draft waits in its app for you to send it: where to find it */}
          {item.group === 'sent' && d.status === 'staged' && stagedWhere(d.destination) ? <span data-testid="row-staged-where">find it {stagedWhere(d.destination)}</span> : null}
          {d.userTouched ? <span>edited by you</span> : null}
          <span className="tabular-nums" data-applied-by={d.appliedBy ?? undefined}>
            {item.group === 'sent' ? `${d.appliedBy === 'autopilot' ? 'Applied automatically' : isAction ? 'applied' : 'sent'} ${fmtAgo(d.updatedAt, new Date(now))}` : `drafted ${fmtAgo(d.createdAt, new Date(now))}`}
          </span>
        </>
      }
      source={src ? { label: src.label, url: src.url } : null}
      edge={edge}
      dashed={!status.left && item.group !== 'failed'}
      verb={verb}
      altVerb={altVerb}
      overflow={overflow}
      extra={
        rel?.missing && approvable && flow.phase !== 'error' ? (
          <p role="alert" data-testid="release-missing" className="pb-1 text-body text-danger-700">
            {rel.missing}
          </p>
        ) : (
          <Inline status={status.detail} tone={status.tone} flow={flow} where={stagedWhere(d.destination)} onRetry={onRetryFlow} onDismiss={onDismissFlow} />
        )
      }
      selected={selected}
      emphasis={emphasis}
      inPanel={inPanel}
      onOpen={onOpen}
      expanded={expanded}
      onExpandedChange={onExpand}
      expansion={
        <div className="grid gap-4 @container" data-testid="row-expansion">
          <div className="grid gap-4 @4xl:grid-cols-[minmax(0,44rem)_minmax(0,1fr)]">
            <section className="min-w-0">
              {d.destination.kind !== 'action' ? <ReplyingTo draftId={d.id} compact className="mb-3 max-w-[44rem]" /> : null}
              {rel ? (
                <ReleaseFacts draft={d} />
              ) : (
                <>
                  <h3 className="mb-1.5 text-caption font-bold text-muted">{d.destination.kind === 'action' ? `Exactly what changes in ${actionApp(d.destination.action)}` : `Exactly what ${d.destination.kind === 'slack' ? 'they' : 'the recipient'} will see`}</h3>
                  <RecipientPreview doc={d.doc as unknown as DocNode} destination={d.destination} className="max-w-[44rem]" />
                </>
              )}
            </section>
            <section className="min-w-0">
              <h3 className="mb-1.5 text-caption font-bold text-muted">History</h3>
              <ol aria-label="History" className="space-y-1">
                {item.history.map((h, i) => (
                  <li key={`${h.at}-${i}`} className="flex items-start gap-2 text-body">
                    <Icon name={/dry run/i.test(h.label) ? 'lock' : /verif|✓/i.test(h.label) ? 'success' : 'clock'} size="xs" className="mt-1.5 text-muted" />
                    <span className="min-w-0 flex-1 text-fg">{h.label}</span>
                    <time dateTime={h.at} className="shrink-0 text-caption text-muted tabular-nums">
                      {fmtDay(h.at, tz)} {fmtClock(h.at, tz)}
                    </time>
                  </li>
                ))}
                {d.attempts.map((a) => (
                  <li key={a.id} className="ml-5 text-caption text-muted">
                    {a.dryRun ? 'Dry run: ' : ''}
                    {a.detail ?? a.outcome}
                  </li>
                ))}
              </ol>
            </section>
          </div>
        </div>
      }
    />
  );
}

function Inline({ status, tone, flow, where, onRetry, onDismiss }: { status: string | null; tone: string; flow: RowFlow; where: string | null; onRetry: () => void; onDismiss: () => void }): ReactNode {
  if (flow.phase === 'error') {
    return (
      <p role="alert" data-testid="row-error" className="flex flex-wrap items-center gap-x-3 pb-1 text-body text-danger-700">
        <span className="min-w-0 max-w-[68ch]">{flow.error ?? 'Something went wrong.'} Nothing was sent.</span>
        {flow.retryable ? (
          <button type="button" onClick={onRetry} className="rounded-sm font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" title="A fresh preview and confirm: the old confirm is never reused">
            Retry
          </button>
        ) : null}
        <button type="button" onClick={onDismiss} className="rounded-sm text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-focus">
          Dismiss
        </button>
      </p>
    );
  }
  if (flow.phase === 'done' && flow.outcome === 'dry_run') {
    return (
      <p role="status" data-testid="dry-run-result" className="flex flex-wrap items-center gap-x-3 pb-1 text-body text-fg">
        <Icon name="lock" size="xs" className="text-muted" />
        <span>
          <b className="font-bold">Dry run:</b> payload rendered and recorded. Nothing left this machine.
        </span>
        <button type="button" onClick={onDismiss} className="rounded-sm text-caption text-muted hover:text-fg focus-visible:outline-none focus-visible:shadow-focus">
          Dismiss
        </button>
      </p>
    );
  }
  if (flow.phase === 'done' && flow.outcome) {
    return (
      <p role="status" className="pb-1 text-body text-fg">
        {flow.outcome === 'staged' ? `Draft saved${where ? `: find it ${where}` : ''}. Checking it landed…` : 'Sent. Checking it landed…'}
      </p>
    );
  }
  if (status && (tone === 'risk' || tone === 'warn')) {
    return (
      <p className={tone === 'risk' ? 'pb-1 text-body text-danger-700' : 'pb-1 text-body text-muted'} role={tone === 'risk' ? 'alert' : undefined} data-testid="row-detail">
        {status}
      </p>
    );
  }
  return null;
}
