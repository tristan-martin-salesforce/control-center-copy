'use client';
// NbaCard's small parts: the new dot, status line, why popover and plan block. Split from NbaCard.tsx (max-lines).
import { useState, type ReactNode } from 'react';

import type { AgentRun, NbaCard as NbaCardVm, SourceRef, WorkItem } from '@/contract';
import { cn, Icon, Kbd } from '@/ui';
import { AiMark, SourceChip } from './lib';
import { dur, minutesBetween } from './lib/time';
import { toolName } from './derive';
import { RunGlyph } from './RunGlyph';
import type { NbaCardProps } from './NbaCard.types';

export const SOURCE_LABEL: Record<SourceRef['kind'], string> = {
  slack: 'Slack',
  gmail: 'Gmail',
  calendar: 'Calendar',
  drive: 'Drive',
  gemini: 'Notes',
  org62: 'Org62',
  vdp: 'VDP',
  claude: 'Claude',
  manual: 'Source',
};
/** Collapsed cards show at most two alternatives; the expanded card shows three. */
export function expandedFor(p: NbaCardProps): boolean {
  return p.expanded ?? p.defaultExpanded ?? false;
}
/** "· 2 new": new evidence is information, not a call to act, so it stays neutral. */
export function NewDot({ count }: { count: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5 text-caption text-muted tabular-nums" title={`${count} new evidence`}>
      <span className="size-1.5 rounded-full bg-muted" />
      {count} new
    </span>
  );
}
export function StatusLine({ tone, icon, glyph, children }: { tone: 'warn' | 'ai' | 'ready' | 'neutral'; icon?: string; glyph?: ReactNode; children: ReactNode }) {
  const mark = { warn: 'text-warning-700', ai: 'text-ai-700', ready: 'text-success-700', neutral: 'text-muted' }[tone];
  return (
    <p className="flex items-start gap-2 rounded-md bg-surface-muted px-3 py-1.5 text-caption">
      <span className={cn('mt-0.5 shrink-0', mark)}>{glyph ?? (icon ? <Icon name={icon} size="xs" /> : null)}</span>
      <span className="min-w-0 text-fg">{children}</span>
    </p>
  );
}
export function WhyPopover({
  id,
  pinned,
  detail,
  item,
  sources,
  onOpenSource,
}: {
  id: string;
  pinned: boolean;
  detail: string | null | undefined;
  item: WorkItem;
  sources: SourceRef[];
  onOpenSource?: (s: SourceRef) => void;
}) {
  // caps audit F-13: the four strongest reasons first, "+N more reasons" for the rest (the popover is clickable once pinned)
  const [allReasons, setAllReasons] = useState(false);
  const sorted = [...item.rankReasons].sort((a, b) => b.contribution - a.contribution);
  const reasons = allReasons ? sorted : sorted.slice(0, 4);
  const moreReasons = sorted.length - reasons.length;
  const max = Math.max(1, ...reasons.map((r) => Math.abs(r.contribution)));
  return (
    <div
      id={id}
      role="tooltip"
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'absolute left-0 top-full z-30 mt-1 w-[min(32rem,100%)] cursor-default rounded-md border border-line bg-surface-overlay p-4 shadow-pop transition-[opacity,visibility] duration-100',
        pinned ? 'visible opacity-100' : 'invisible opacity-0 group-hover/why:visible group-hover/why:opacity-100 group-hover/why:delay-500',
      )}
    >
      {detail ? <p className="max-w-[68ch] text-body text-fg">{detail}</p> : <p className="text-body text-muted">{item.why}</p>}
      {reasons.length ? (
        <div className="mt-3">
          <p className="text-caption font-bold text-fg-heading">{item.rank ? `Why it's #${item.rank} for you` : 'Why it ranks'}</p>
          <ul className="mt-1.5 space-y-1">
            {reasons.map((r) => (
              <li key={r.key} className="grid grid-cols-[minmax(0,1fr)_5rem] items-center gap-2 text-caption">
                <span className="truncate text-fg">{r.label}</span>
                <span className="h-1.5 rounded-full bg-surface-sunken">
                  <span className={cn('block h-full rounded-full', r.contribution >= 0 ? 'bg-fg' : 'bg-faint')} style={{ width: `${(Math.abs(r.contribution) / max) * 100}%` }} />
                </span>
              </li>
            ))}
          </ul>
          {moreReasons > 0 ? (
            <button type="button" className="mt-1 text-caption font-bold text-link hover:underline" onClick={() => setAllReasons(true)} data-more-reasons>
              +{moreReasons} more reason{moreReasons === 1 ? '' : 's'}
            </button>
          ) : null}
        </div>
      ) : null}
      {sources.length ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {sources.map((s) => (
            <SourceChip key={`${s.kind}${s.label}`} source={s} onOpen={onOpenSource} />
          ))}
        </div>
      ) : null}
      <p className="mt-2 text-micro text-faint">
        <Kbd>?</Kbd> pins this · <Kbd>o</Kbd> opens the source
      </p>
    </div>
  );
}
export function PlanBlock({ nba, run, now }: { nba: NbaCardVm; run: AgentRun | null; now: string }) {
  const kind = nba.verb === 'run_tool' ? toolName(nba.toolAdapterId) : run?.kind === 'tool_run' ? 'Tool run' : 'Claude session';
  // caps audit F-13: three inputs first, "+N more inputs" for the rest
  const [allInputs, setAllInputs] = useState(false);
  const readable = nba.toolInputs ? Object.entries(nba.toolInputs).filter(([k, v]) => !/id$/i.test(k) && !(typeof v === 'string' && /^[a-z]+_[a-z0-9_]+$/.test(v))) : [];
  const inputs = allInputs ? readable : readable.slice(0, 3);
  const moreInputs = readable.length - inputs.length;
  const pct = run?.progress ? Math.round((run.progress.done / Math.max(1, run.progress.total)) * 100) : null;
  return (
    <div className="rounded-md border-agentic p-3">
      <div className="flex items-center gap-2">
        <AiMark>Plan</AiMark>
        <span className="text-caption text-muted">· {kind}</span>
        {nba.claudeLaunch ? <span className="ml-auto truncate font-mono text-micro text-faint">{nba.claudeLaunch.folder.replace(/^\/Users\/[^/]+/, '~')}</span> : null}
      </div>
      {nba.claudeLaunch ? <p className="mt-1 line-clamp-2 max-w-[68ch] text-body text-fg">{nba.claudeLaunch.promptPreview.replace(/\s*\[cc:[^\]]+\]/g, '')}</p> : null}
      {inputs.length ? (
        <dl className="mt-1.5 grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 text-caption">
          {inputs.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="truncate text-fg">{typeof v === 'string' ? v : JSON.stringify(v)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {moreInputs > 0 ? (
        <button type="button" className="mt-1 text-caption font-bold text-link hover:underline" onClick={() => setAllInputs(true)} data-more-inputs>
          +{moreInputs} more input{moreInputs === 1 ? '' : 's'}
        </button>
      ) : null}
      {!nba.claudeLaunch && !inputs.length ? <p className="mt-1 max-w-[68ch] text-body text-fg">{nba.why}</p> : null}
      {run ? (
        <div className="mt-2 flex items-center gap-2 border-t border-line pt-2 text-caption">
          <RunGlyph state={run.state} size={14} />
          <span className="font-bold text-fg">{run.state === 'running' ? 'Running in the background' : run.state.replace(/_/g, ' ')}</span>
          {run.startedAt ? <span className="text-muted tabular-nums">{dur(minutesBetween(run.startedAt, now))}</span> : null}
          <span className="min-w-0 flex-1 truncate text-muted">{run.lastEvent}</span>
          {pct !== null ? (
            <span className="h-1.5 w-16 shrink-0 rounded-full bg-surface-sunken" title={`${run.progress!.done}/${run.progress!.total}`}>
              <span className="block h-full rounded-full bg-ai-500" style={{ width: `${pct}%` }} />
            </span>
          ) : null}
          {run.bgAgents ? <span className="shrink-0 text-muted">+{run.bgAgents} background</span> : null}
        </div>
      ) : null}
    </div>
  );
}
