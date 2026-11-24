'use client';
/**
 * v2 action cards for what chat prepared but never executes on its own:
 *   DraftCard    a drafted reply: preview, Open in composer, Add to Outbox. Chat never sends.
 *   SessionCard  a Claude Code session: Open in Claude is the one primary and needs a click; a status
 *                line follows it. A claude:// link never opens by itself.
 *   ScanRow      /rescan progress, then what it found.
 */
import { AppLink } from '@/components/shell/AppLink';
import { useState, type KeyboardEvent } from 'react';
import type { AgentRun, ChatResource, Draft } from '@/contract';
import { adminDraftHref } from '@/contract';
import { actionKindLabel } from '@/lib/actions';
import { useApi } from '@/client/hooks';
import { Button } from '@/ui';
import { destinationLabel } from '@/components/composer/destination';
import { useAssistantSurface } from './assistant-context';
import { fmtTime } from './format';
import { ChatIcon } from './icons';
import { fmtMin, type ScanView } from './thread-model';
import { useChatUi } from './ui-context';
import s from './assistant.module.css';
import { navigate } from '@/components/shell/router';

/** Open a deep link (claude://, https://) from a click handler. Never called on render or on a timer. */
export function openDeepLink(url: string): void {
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  a.dataset.ccDeepLink = '1';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

const minutesSince = (iso: string | null | undefined, now = Date.now()) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60_000)) : null);

// ── Draft ────────────────────────────────────────────────────────────────────────────────────

const DRAFT_STATE: Record<string, { label: string; tone?: 'good' | 'warn' | 'bad' }> = {
  drafting: { label: 'Not in the Outbox yet' },
  ready: { label: '✓ In the Outbox · waiting for your approval', tone: 'good' },
  scheduled: { label: '◷ Scheduled', tone: 'warn' },
  sending: { label: 'Sending…' },
  staged: { label: '✓ Draft saved', tone: 'good' },
  sent: { label: '✓ Sent', tone: 'good' },
  verified: { label: '✓ Sent · verified', tone: 'good' },
  verify_failed: { label: '▲ Sent · not verified', tone: 'warn' },
  failed: { label: '✕ Failed', tone: 'bad' },
};

export function DraftCard({ resource, draft: preloaded }: { resource: ChatResource; draft?: Draft }) {
  const surface = useAssistantSurface();
  const ui = useChatUi();
  const q = useApi('getDraft', { params: { id: resource.id } }, { initialData: preloaded, staleTime: 15_000 });
  const settings = useApi('getSettings', undefined, { staleTime: 60_000 });
  const [queueing, setQueueing] = useState<'idle' | 'pending' | 'error'>('idle');
  const d = q.data;
  const dryRun = settings.data?.sending.dryRun ?? true;
  const inPane = surface.openDraftId === resource.id;

  if (!d) {
    return (
      <div className={`${s.card} ${s.draftCard}`} data-draft={resource.id} aria-busy={q.isPending || undefined}>
        <header className={s.cardHead}>
          <span className={s.aiMark}>Draft</span>
          <span>{resource.label}</span>
        </header>
        {q.isError && !q.data ? (
          <p className={s.err} role="alert">
            This draft couldn’t load: {q.error.message}{' '}
            <button type="button" className={s.more} onClick={() => void q.refetch()}>
              Retry
            </button>
          </p>
        ) : (
          <div className={s.skelLine} style={{ width: '70%' }} aria-hidden />
        )}
      </div>
    );
  }

  // a staged admin item (a logging canvas, a VDP change): its live status and, once applied, the link to it
  if (d.destination.kind === 'action') return <ActionDraftCard d={d} label={resource.label} href={resource.href} />;

  const st = DRAFT_STATE[d.status] ?? { label: d.status };
  const open = () => surface.openDraft(d);
  const canQueue = d.status === 'drafting' && !!surface.addToOutbox;
  const queue = async () => {
    if (!surface.addToOutbox) return;
    setQueueing('pending');
    try {
      await surface.addToOutbox(d);
      setQueueing('idle');
    } catch {
      setQueueing('error');
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'e' && !e.metaKey && !e.ctrlKey && !e.altKey && e.target === e.currentTarget) {
      e.preventDefault();
      open();
    }
  };

  return (
    <div className={`${s.card} ${s.draftCard}`} tabIndex={0} onKeyDown={onKeyDown} data-draft={d.id} data-draft-status={d.status} data-in-pane={inPane || undefined} aria-label={`Draft: ${resource.label}`}>
      <header className={`${s.cardHead} ${s.one}`}>
        <span className={s.aiMark}>Draft</span>
        <span className={s.dest} title={`${destinationLabel(d.destination)} · as you`}>
          {destinationLabel(d.destination)} · as you
        </span>
        <span className={s.r}>
          Saved {fmtTime(d.savedAt ?? d.updatedAt, ui.timeZone)}
          {inPane ? ' · open in the composer →' : ''}
        </span>
      </header>
      <div className={s.draft}>{d.plainText || 'Empty draft'}</div>
      <div className={s.status}>
        <span className={`${s.badge} ${st.tone ? s[st.tone] : ''}`}>{st.label}</span>
        {d.status === 'scheduled' && d.scheduledFor ? <span>{fmtTime(d.scheduledFor, ui.timeZone)}</span> : null}
      </div>
      <div className={s.acts}>
        {canQueue ? (
          <>
            <Button variant="primary" size="sm" onClick={() => void queue()} loading={queueing === 'pending'} data-primary data-add-outbox>
              Add to Outbox
            </Button>
            <Button variant="ghost" size="sm" kbd="e" onClick={open} data-open-composer>
              Open in composer
            </Button>
          </>
        ) : d.status === 'ready' ? (
          <>
            <Button variant="primary" size="sm" onClick={() => navigate(`/outbox?draft=${encodeURIComponent(d.id)}`)} data-primary>
              Review in Outbox
            </Button>
            <Button variant="ghost" size="sm" kbd="e" onClick={open} data-open-composer>
              Open in composer
            </Button>
          </>
        ) : d.status === 'drafting' ? (
          <Button variant="primary" size="sm" kbd="e" onClick={open} data-primary data-open-composer>
            Open in composer
          </Button>
        ) : (
          <Button variant="ghost" size="sm" kbd="e" onClick={open} data-open-composer>
            Open in composer
          </Button>
        )}
      </div>
      {queueing === 'error' ? (
        <p className={s.err} role="alert">
          Couldn’t add it to the Outbox. Nothing was sent.
        </p>
      ) : null}
      <p className={s.note}>
        Chat never sends. Sending happens in the Outbox, after you confirm.{dryRun ? ' Dry run is on.' : ''}
      </p>
    </div>
  );
}

// ── A staged admin item (logging canvas, VDP change) ────────────────────────────────────────

const ACTION_STATE: Record<string, { label: string; tone?: 'good' | 'warn' | 'bad' }> = {
  ready: { label: 'Waiting for your Apply on Activity' },
  scheduled: { label: 'Waiting for your Apply on Activity' },
  sending: { label: 'Applying…' },
  sent: { label: '✓ Applied', tone: 'good' },
  staged: { label: '✓ Applied', tone: 'good' },
  verified: { label: '✓ Applied · verified', tone: 'good' },
  verify_failed: { label: '▲ Applied · not verified', tone: 'warn' },
  failed: { label: '✕ Apply failed: retry on Activity', tone: 'bad' },
  rejected: { label: 'Rejected: nothing was created' },
  discarded: { label: 'Discarded: nothing was created' },
};

/** The live card of an admin item the Assistant staged: status from GET /drafts/:id, Apply on Time, Open ↗ once applied. */
function ActionDraftCard({ d, label, href }: { d: Draft; label: string; href: string }) {
  const dest = d.destination.kind === 'action' ? d.destination : null;
  const st = ACTION_STATE[d.status] ?? { label: d.status };
  const dry = d.status === 'ready' && d.attempts.some((a) => a.dryRun);
  const where = adminDraftHref(d);
  return (
    <div className={`${s.card} ${s.draftCard}`} data-draft={d.id} data-draft-status={d.status} aria-label={`${dest ? actionKindLabel(dest) : 'Action'}: ${dest?.target.label ?? label}`}>
      <header className={`${s.cardHead} ${s.one}`}>
        <span className={s.aiMark}>{dest ? actionKindLabel(dest) : 'Action'}</span>
        <span className={s.dest} title={dest?.target.label ?? label}>
          {dest?.target.label ?? label}
        </span>
      </header>
      <div className={s.status}>
        <span className={`${s.badge} ${st.tone ? s[st.tone] : ''}`}>{st.label}</span>
        {dry ? <span>Dry run rendered: nothing was created</span> : null}
      </div>
      <div className={s.acts}>
        {d.status === 'ready' || d.status === 'failed' || d.status === 'scheduled' ? (
          <Button variant="primary" size="sm" onClick={() => navigate(where || href)} data-primary>
            Review & apply on Activity
          </Button>
        ) : null}
        {d.resultUrl ? (
          <a href={d.resultUrl} target="_blank" rel="noopener noreferrer" className={s.more} data-result-link>
            Open ↗
          </a>
        ) : null}
      </div>
      <p className={s.note}>Chat never applies. Apply happens on Activity, after you confirm.</p>
    </div>
  );
}

// ── Claude session ───────────────────────────────────────────────────────────────────────────

function sessionStatus(run: AgentRun, now: number, tz?: string): { dot: string; word: string; tone?: 'warn' | 'bad' | 'good'; rest: string } {
  const since = minutesSince(run.startedAt, now);
  switch (run.state) {
    case 'queued':
      return { dot: '', word: 'Ready', rest: 'opens when you click Open in Claude' };
    case 'running':
      return { dot: s.run, word: 'Running', rest: `${since !== null ? `· ${fmtMin(since)} ` : ''}· waiting on you: no${run.bgAgents ? ` · ${run.bgAgents} background agent${run.bgAgents === 1 ? '' : 's'}` : ''}` };
    case 'waiting_on_you':
      return { dot: s.warn, word: 'Waiting on you', tone: 'warn', rest: `· ${run.waiting?.reason ?? 'input needed'}` };
    case 'done_review':
      return { dot: s.good, word: 'Done', tone: 'good', rest: '· ready for your review' };
    case 'done':
      return { dot: s.good, word: 'Done', tone: 'good', rest: run.finishedAt ? `· ${fmtTime(run.finishedAt, tz)}` : '' };
    case 'failed':
      return { dot: s.bad, word: 'Failed', tone: 'bad', rest: run.error ? `· ${run.error}` : '' };
    case 'stale':
      return { dot: s.warn, word: 'No updates', tone: 'warn', rest: `· last heard ${fmtMin(minutesSince(run.updatedAt, now) ?? 0)} ago` };
  }
}

function promptOf(deepLink: string | null): string | null {
  if (!deepLink) return null;
  try {
    return new URL(deepLink).searchParams.get('q');
  } catch {
    return null;
  }
}

export function SessionCard({ resource }: { resource: ChatResource }) {
  const ui = useChatUi();
  const agents = useApi('getAgents', undefined, { staleTime: 10_000 });
  const run = agents.data?.runs.find((r) => r.id === resource.id) ?? null;
  const [clickedAt, setClickedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // SEC-10: the session runs with your permissions, so the first click shows the whole prompt; the next one opens it
  const [reviewed, setReviewed] = useState(false);
  const now = Date.now();
  // the preview drops the session's report-back tag; the review shows every character the session starts with
  const whole = promptOf(run?.deepLink ?? null);
  const prompt = whole?.replace(/\s*\[cc:[^\]]+\]\s*$/, '') ?? null;
  const wholeLines = whole ? whole.replace(/\r\n/g, '\n').split('\n').length : 0;
  const folder = run?.cwd?.replace(/^\/Users\/[^/]+/, '~') ?? null;
  const status = run ? sessionStatus(run, now, ui.timeZone) : null;

  const openInClaude = () => {
    if (!run?.deepLink) return;
    if (prompt && !reviewed) return setReviewed(true);
    setClickedAt(Date.now());
    openDeepLink(run.deepLink);
  };

  return (
    <div className={s.card} data-session={resource.id} data-session-state={run?.state ?? 'unknown'}>
      <header className={s.cardHead}>
        <ChatIcon name="term" size={14} />
        <span>Claude Code · {run?.state === 'queued' ? 'new session' : 'session'}</span>
        {folder ? <span className={`${s.r} ${s.mono}`}>{folder}</span> : null}
      </header>
      <div className={s.cardTitle}>{run?.title ?? resource.label}</div>
      {prompt && reviewed ? (
        <>
          <p className={s.note}>{`The whole prompt · ${wholeLines} line${wholeLines === 1 ? '' : 's'}`}</p>
          <p className={`${s.prompt} ${s.promptWhole}`} data-prompt-whole>
            {whole}
          </p>
          {!clickedAt ? (
            <p className={s.note} data-launch-permissions>
              This is the whole prompt the Assistant wrote in this thread. Claude Code runs it with your permissions: open it only if it is what you want.
            </p>
          ) : null}
        </>
      ) : prompt ? (
        <p className={s.prompt}>{prompt}</p>
      ) : run?.lastEvent ? <p className={s.note}>{run.lastEvent}</p> : null}
      {status ? (
        <div className={s.status} data-session-status>
          <span className={`${s.dot} ${status.dot}`} aria-hidden />
          <b className={status.tone ? s[status.tone] : undefined}>{status.word}</b>
          <span>{status.rest}</span>
        </div>
      ) : agents.isError ? (
        <p className={s.err}>Couldn’t read the session’s status.</p>
      ) : null}
      <div className={s.acts}>
        {run?.deepLink ? (
          <Button variant="primary" size="sm" onClick={openInClaude} data-open-claude={prompt && !reviewed ? 'review' : 'open'} data-primary>
            {prompt && !reviewed ? 'Review prompt' : 'Open in Claude'}
          </Button>
        ) : null}
        {prompt ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              void navigator.clipboard?.writeText(prompt).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy prompt'}
          </Button>
        ) : null}
        <AppLink href={resource.href} className={s.more}>
          Open in Agents
        </AppLink>
      </div>
      {reviewed && !clickedAt ? null : (
        <p className={s.note}>
          {clickedAt
            ? `Opened in Claude at ${fmtTime(new Date(clickedAt).toISOString(), ui.timeZone)} when you clicked. It reports back here.`
            : run?.state === 'queued'
              ? 'Opens only when you click. Sessions never start on their own.'
              : 'Runs in the background; it doesn’t count against your day. It never opens on its own.'}
        </p>
      )}
    </div>
  );
}

// ── Scan ─────────────────────────────────────────────────────────────────────────────────────

export function ScanRow({ scan }: { scan: ScanView }) {
  if (scan.status === 'running') {
    return (
      <div className={s.scan} role="status" data-scan="running">
        <ChatIcon name="scan" />
        <div>
          <div className={s.t}>{scan.title}</div>
          <div className={s.meter} role="progressbar" aria-label={scan.title} aria-valuetext="Scanning">
            <i />
          </div>
        </div>
        <span className={s.note}>Read-only</span>
      </div>
    );
  }
  if (scan.status === 'failed') {
    return (
      <div className={`${s.scan} ${s.failed}`} role="status" data-scan="failed">
        <ChatIcon name="alert" />
        <div>
          <div className={s.t}>{scan.title}</div>
          {scan.detail ? <div className={s.s}>{scan.detail}</div> : null}
        </div>
        <AppLink href="/health" className={s.more}>
          Open Health
        </AppLink>
      </div>
    );
  }
  return (
    <>
      <p className={s.scanned}>
        ✦ Scanned {scan.source}
        {scan.window ? ` · ${scan.window}` : ''} · read-only
      </p>
      <div className={`${s.scan} ${s.done}`} role="status" data-scan="done">
        <ChatIcon name="check" />
        <div>
          <div className={s.t}>{scan.title}</div>
          {scan.detail ? <div className={s.s}>{scan.detail}</div> : null}
        </div>
        <AppLink href="/triage" className={s.more}>
          Open in Triage
        </AppLink>
      </div>
    </>
  );
}
