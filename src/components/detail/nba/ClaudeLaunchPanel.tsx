'use client';
/**
 * Start in Claude (UI-SPEC §12 Agents, R-UI-13): the context pack the session starts with, and the one
 * primary. The click records the run (POST /agents/launch, which tags the prompt with [cc:<item>] so the
 * session reports back to this task), then Review prompt shows the whole prompt it carries ("runs with your
 * permissions", SEC-10, components/agents/LaunchReview); only its Open in Claude opens the claude:// link.
 * Nothing opens by itself. A running or waiting session for the item turns the primary into Open in Claude.
 */
import { useState } from 'react';
import type { AgentRun, NbaCard, WorkItem } from '@/contract';
import { useOptimisticMutation } from '@/client/optimistic';
import { RunGlyph, RUN_META } from '@/components/domain';
import { Button, Icon } from '@/ui';
import { useLaunchReview } from '@/components/agents/LaunchReview';
import { stripCcTag } from '../lib/derive';
import { failFromUrl } from '../lib/mutations';
import { usePublishPrimary } from '../lib/primary';

/** Open a deep link (claude://, slack://, https://) from a click handler. Never called on render. */
export function openDeepLink(url: string) {
  if (/^https?:\/\//i.test(url)) {
    window.open(url, '_blank', 'noopener,noreferrer');
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** The full context pack: the `q` of the NBA's claude:// link (the preview field is truncated). */
export function fullPrompt(launch: { url: string; promptPreview: string } | null): string | null {
  if (!launch) return null;
  try {
    const q = new URL(launch.url).searchParams.get('q');
    if (q && q.length >= launch.promptPreview.replace(/…$/, '').length) return q;
  } catch {
    /* not a parseable URL: fall back to the preview */
  }
  return launch.promptPreview;
}

export function ClaudeLaunchPanel({ item, nba, run, now }: { item: WorkItem; nba: NbaCard; run: AgentRun | null; now: string }) {
  const launch = nba.claudeLaunch;
  const [full, setFull] = useState(false);
  // SEC-10: a claude://code/new link is reviewed first; a resume link opens on the click
  const { review, dialog } = useLaunchReview(openDeepLink);
  const start = useOptimisticMutation({
    route: 'launchAgent',
    topics: ['agents', 'item', 'today'],
    writeBack: false,
    entityId: () => undefined,
    onSuccess: (res) => review(res.url, res.run.title),
    toast: (res) => ({ title: `Prepared: ${res.run.title}`, body: 'Review the prompt, then Open in Claude. The session reports back to this task.' }),
    fail: failFromUrl,
  });
  const pack = fullPrompt(launch);
  const prompt = pack ? stripCcTag(pack) : null;
  const folder = launch?.folder.replace(/^\/Users\/[^/]+/, '~');
  const live = !!run && (run.state === 'running' || run.state === 'waiting_on_you' || run.state === 'queued');
  // A session that exists (live, or done and waiting for review) continues in Claude; otherwise start one.
  const resumable = !!run?.deepLink && (live || run.state === 'done_review' || run.state === 'failed' || run.state === 'stale');
  const elapsed = run?.startedAt ? Math.max(0, Math.round((Date.parse(now) - Date.parse(run.startedAt)) / 60_000)) : null;
  const startSession = () => start.mutate({ body: { workItemId: item.id, title: nba.title, prompt: pack && pack.length <= 14336 ? pack : undefined, folder: launch?.folder } });
  // In the docked panel the filled button lives in the footer (lib/primary.tsx); here it's drawn in place.
  const external = usePublishPrimary(
    resumable
      ? { label: run!.state === 'done_review' ? 'Review in Claude' : 'Open in Claude', icon: 'new_window', kbd: 'mod+enter', run: () => review(run!.deepLink!, run!.title) }
      : { label: 'Start in Claude', icon: 'agent_session', kbd: 'mod+enter', loading: start.isPending, run: startSession },
  );

  return (
    <div className="rounded-lg border-agentic bg-surface px-4 py-3" data-claude-launch>
      {dialog}
      <div className="flex items-center gap-1.5">
        <Icon name="agent_session" size="sm" className="text-ai-700" />
        <span className="text-caption font-bold text-ai-700">Context pack</span>
        {folder ? (
          <span className="ml-auto truncate font-mono text-micro text-muted" title={launch?.folder}>
            {folder}
          </span>
        ) : null}
      </div>
      {prompt ? (
        <div className="mt-2">
          <p className={full ? 'max-h-72 overflow-y-auto whitespace-pre-wrap text-body text-fg cc-scroll' : 'line-clamp-4 max-w-[68ch] whitespace-pre-wrap text-body text-fg'}>{prompt}</p>
          {prompt.length > 280 ? (
            <button type="button" onClick={() => setFull((v) => !v)} className="mt-1 inline-flex items-center gap-0.5 text-caption text-link hover:underline">
              {full ? 'Show less' : 'Show the whole prompt'} <Icon name={full ? 'chevrondown' : 'chevronright'} size="xs" />
            </button>
          ) : null}
          <p className="mt-1.5 text-caption text-muted">
            Tagged <span className="font-mono text-micro">[cc:{item.id}]</span>, so the session links back here and can close the task when it finishes.
          </p>
        </div>
      ) : (
        <p className="mt-2 text-body text-muted">The session starts from this task&apos;s title, purpose, evidence and assets.</p>
      )}
      {run ? (
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-caption" data-run-state={run.state}>
          <RunGlyph state={run.state} size={12} />
          <span className="font-bold text-fg">{RUN_META[run.state].label}</span>
          {elapsed !== null && live ? <span className="text-muted tabular-nums">{elapsed}m</span> : null}
          <span className="min-w-0 flex-1 truncate text-muted">{run.waiting?.question ?? run.lastEvent}</span>
        </div>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {resumable ? (
          <>
            {!external ? (
              <Button variant="primary" icon="new_window" kbd="mod+enter" onClick={() => review(run!.deepLink!, run!.title)} data-nba-primary>
                {run!.state === 'done_review' ? 'Review in Claude' : 'Open in Claude'}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" icon="add" loading={start.isPending} onClick={startSession}>
              New session
            </Button>
          </>
        ) : !external ? (
          <Button variant="primary" icon="agent_session" kbd="mod+enter" loading={start.isPending} data-nba-primary onClick={startSession}>
            Start in Claude
          </Button>
        ) : null}
        <span className="text-caption text-muted">Opens the Claude app. You stay in control there.</span>
      </div>
      {start.error ? (
        <p role="alert" className="mt-2 text-caption text-danger-700">
          Couldn&apos;t start the session: {start.error.message}{' '}
          <button type="button" onClick={start.retry} className="font-bold hover:underline">
            Retry
          </button>
        </p>
      ) : null}
    </div>
  );
}
