'use client';
/**
 * The v2 topbar (64 px, inside main, spanning the content and the docked panel):
 *
 *   Page title · <NavStrip> slot · ⌘K search field ········ next meeting · + Capture · Feedback · ✦ Assistant ⌘J
 *
 * The title comes from the route map or a page's usePageTitle(). Below ~1,000 px of topbar the
 * next-meeting chip folds away; the buttons keep their labels until ~760 px.
 */
import type { TodayPayload } from '@/contract';
import { Button } from '@/ui/Button';
import { useNow, useTimeZone } from '@/ui/clock';
import { cn } from '@/ui/cn';
import { fmtClock } from '@/ui/format';
import { Icon } from '@/ui/Icon';
import { KbdHint } from '@/ui/Kbd';
import { Tooltip } from '@/ui/Tooltip';
import { PageHelpButton } from '@/guide/PageHelp';
import { CaptureBody } from './CapturePanel';
import { TopbarFeedback } from './FeedbackButton';
import { useChromeData } from './data';
import { usePanelInternals, useRightPanel } from './panel';
import { useShellOptional } from './ShellContext';
import { usePendingPath } from './nav-pending';
import { pageTitleFor, usePageTitle } from './titles';
import { UtilityPanel } from './UtilityPanel';

/** The search field gives way first (shrink 8) so the next meeting chip keeps its title at 1440 (it read "1:1 …"). */
export function SearchField({ onOpen, className }: { onOpen?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      // named by what it shows (WCAG 2.5.3); the longer phrase is the tooltip, the shortcut announced from here
      title="Search or run a command"
      aria-keyshortcuts="Meta+K"
      className={cn(
        'flex h-10 min-w-[12rem] flex-[0_8_27.5rem] items-center gap-2.5 rounded-md border border-line-strong bg-surface-input px-3 text-body text-faint transition-colors hover:border-line-input hover:text-muted focus-visible:outline-none focus-visible:shadow-focus',
        className,
      )}
    >
      <Icon name="search" size="md" />
      <span className="min-w-0 flex-1 truncate text-left">Search or ask…</span>
      <KbdHint combo="mod+k" tone="quiet" decorative />
    </button>
  );
}

function untilLabel(minutes: number): string {
  if (minutes <= 0) return 'now';
  if (minutes < 60) return `in ${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `in ${h}h ${m}m` : `in ${h}h`;
}

/** "Next 10:00 Team sync · in 1h 38m". Blue only when it's (nearly) now. */
export function NextMeetingChip({ next, className }: { next: NonNullable<TodayPayload['header']['nextMeeting']>; className?: string }) {
  const now = useNow(30_000);
  const tz = useTimeZone();
  const start = new Date(next.start);
  const minutes = Math.ceil((start.getTime() - now.getTime()) / 60_000);
  const soon = minutes <= 10;
  const when = fmtClock(start, tz);
  const until = untilLabel(minutes);
  return (
    <div
      role="status"
      aria-label={`Next meeting ${when}: ${next.title}, ${until}`}
      title={next.title}
      className={cn('flex h-10 max-w-[32rem] min-w-0 items-center gap-2.5 rounded-md border border-line bg-surface px-3.5 text-caption whitespace-nowrap text-muted', className)}
    >
      <span aria-hidden className={cn('size-2 shrink-0 rounded-full', soon ? 'bg-accent' : 'bg-faint')} />
      <span className="shrink-0">
        {minutes <= 0 ? 'Now' : 'Next'} <b className="font-bold text-fg">{when}</b>
      </span>
      <span className="-ml-1 min-w-0 truncate">{next.title}</span>
      <span className={cn('-ml-1 shrink-0', soon && 'font-bold text-link')}>· {until}</span>
    </div>
  );
}

export interface TopbarProps {
  /** Kit specimens: render without claiming the NavStrip slot or the shell's popovers. */
  specimen?: boolean;
  /** Title override (specimens). */
  title?: string;
  className?: string;
}

export function Topbar({ specimen, title: titleProp, className }: TopbarProps) {
  const shell = useShellOptional();
  const panel = useRightPanel();
  const { today } = useChromeData();
  const routeTitle = usePageTitle();
  // A pending navigation shows its destination's title at once, with its skeleton.
  const pendingPath = usePendingPath();
  const title = titleProp ?? (pendingPath ? pageTitleFor(pendingPath) : routeTitle);
  const next = today.data?.header.nextMeeting ?? null;
  const { visible } = usePanelInternals();
  const assistantOpen = visible && panel.tab === 'assistant';

  const capture = (
    <Button variant="secondary" size="sm" icon="add" aria-keyshortcuts="c" aria-label="Capture a to-do">
      <span className="@max-[760px]/topbar:sr-only">Capture</span>
    </Button>
  );

  return (
    <header className={cn('@container/topbar relative z-10 flex h-16 shrink-0 items-center gap-4 border-b border-line px-6', className)}>
      <h1 className="shrink-0 truncate text-title font-bold text-fg-heading">{title}</h1>
      {specimen ? null : <PageHelpButton />}
      <div ref={specimen ? undefined : shell?.setNavStrip} data-slot="nav-strip" className="flex min-w-0 shrink items-center gap-5 overflow-hidden empty:hidden" />
      <SearchField onOpen={() => shell?.setPaletteOpen(true)} />
      <span className="min-w-0 flex-1" />
      {next ? <NextMeetingChip next={next} className="hidden @min-[1000px]/topbar:flex" /> : null}
      {specimen || !shell ? (
        capture
      ) : (
        <UtilityPanel id="capture" title="Capture" width={480} placement="bottom-end" offset={8} trigger={capture}>
          {(close) => <CaptureBody close={close} />}
        </UtilityPanel>
      )}
      {specimen || !shell ? null : <TopbarFeedback />}
      <Tooltip content={<span className="inline-flex items-center gap-1.5">{assistantOpen ? 'Close the assistant' : 'Open the assistant'} <KbdHint combo="mod+j" tone="inverse" /></span>} side="bottom">
        <Button
          variant="secondary"
          size="sm"
          aria-keyshortcuts="Meta+J"
          aria-pressed={assistantOpen}
          onClick={() => (assistantOpen ? panel.toggleAssistant() : shell && !specimen ? shell.focusChat() : panel.openAssistant())}
          className={cn(assistantOpen && 'bg-selected')}
        >
          <Icon name="sparkles" size="sm" className="text-ai-700" />
          {/* the name comes from this label (still read when it folds to sr-only) */}
          <span className="@max-[760px]/topbar:sr-only">Assistant</span>
          <KbdHint combo="mod+j" tone="quiet" decorative className="@max-[760px]/topbar:hidden" />
        </Button>
      </Tooltip>
    </header>
  );
}
