'use client';
/**
 * The system-state popovers behind the sidebar footer (they replace the v1 utility bar):
 *
 *   StatusPopover  "7/8 sources live · dry run" → Sources (catch-up per connector), Sending (Dry run ⇄
 *                  Live send, with a confirm), and Since you left. Opens for utility ids catchup,
 *                  dryrun and since, scrolled to that section.
 *   SpendPopover   "$0.64 of $5 today" → today's LLM spend against the soft budget and hard cap.
 *
 * Live send is the risky state, so it's the loud one (amber word); a quiet line means nothing needs you.
 */
import { RaiseCapButton } from '@/components/health/RaiseCap';
import { AppLink } from './AppLink';
import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import type { Connector, HealthPayload, SinceDigest } from '@/contract';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Dialog } from '@/ui/Dialog';
import { fmtAgo, fmtUsd } from '@/ui/format';
import { StatePill } from '@/ui/badges';
import { EmptyState } from '@/ui/states';
import { TONE_DOT } from '@/ui/tones';
import { CONNECTOR_STATE_LABEL, connectorTone } from './data';
import { useShell, type UtilityId } from './ShellContext';
import { UtilityPanel } from './UtilityPanel';

function SectionHead({ children, extra }: { children: string; extra?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-2 px-4 pt-3 pb-1.5">
      <h3 className="text-caption font-bold text-fg-heading">{children}</h3>
      {extra ? <span className="ml-auto text-caption text-muted">{extra}</span> : null}
    </div>
  );
}

// ── Sources ─────────────────────────────────────────────────────────────────────────────────

export function SourcesList({ connectors }: { connectors?: Connector[] }) {
  const cs = connectors ?? [];
  if (!cs.length) return <p className="px-4 pb-3 text-caption text-muted">Waiting for the first scan.</p>;
  return (
    <ul className="pb-1">
      {cs.map((c) => (
        <li key={c.id} className="flex min-h-9 items-center gap-3 px-4 py-1 text-body">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', TONE_DOT[connectorTone(c.state)])} />
          <span className="w-20 shrink-0 truncate font-bold text-fg">{c.label}</span>
          <span className="min-w-0 flex-1 truncate text-caption text-muted">{c.state === 'catching_up' ? `Catching up · ${c.catchUpPct ?? 0}%` : c.cursor.label}</span>
          {c.state === 'ok' ? null : <StatePill size="xs" tone={connectorTone(c.state)} label={CONNECTOR_STATE_LABEL[c.state]} />}
        </li>
      ))}
    </ul>
  );
}

// ── Sending (Dry run / Live send) ───────────────────────────────────────────────────────────

export function SendingSection({ dryRun, onDone }: { dryRun?: boolean; onDone?: () => void }) {
  const settings = useApi('getSettings');
  const [confirm, setConfirm] = useState(false);
  const patch = useOptimisticMutation({
    route: 'patchSettings',
    topics: ['settings', 'health', 'today'],
    toast: (res) => ({ title: res.entity.sending.dryRun ? 'Dry run on' : 'Live send on' }),
  });
  const on = dryRun ?? true;
  const version = settings.data?.sending.version;
  const set = async (dry: boolean) => {
    if (!version) return;
    const ok = await patch
      .mutateAsync({ params: { section: 'sending' }, body: { ifVersion: version, value: { dryRun: dry }, confirm: dry ? undefined : true } })
      .then(() => true)
      .catch(() => false);
    setConfirm(false);
    // On failure the popover stays open with the inline error.
    if (ok) onDone?.();
  };
  return (
    <div className="space-y-3 px-4 pb-4 text-body">
      {on ? (
        <p className="text-muted">
          <span className="font-bold text-fg">Dry run is on.</span> Sends only render their payload. Nothing leaves this machine, even after you approve it.
        </p>
      ) : (
        <p className="text-muted">
          <span className="font-bold text-warning-700">Live send is on.</span> Approved sends leave this machine. Each one still needs Preview, then Confirm, then a 10 s undo window.
        </p>
      )}
      {patch.error ? <p className="text-caption text-danger-700">Couldn&apos;t change it: {patch.error.message}</p> : null}
      <div className="flex items-center gap-2">
        {on ? (
          <Button size="sm" variant="secondary" onClick={() => setConfirm(true)} disabled={!version}>
            Turn on live send…
          </Button>
        ) : (
          <Button size="sm" variant="primary" icon="lock" onClick={() => void set(true)} loading={patch.isPending}>
            Turn dry run back on
          </Button>
        )}
        <AppLink href="/settings?section=sending" className="ml-auto text-caption font-bold">
          Sending settings
        </AppLink>
      </div>
      <Dialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Turn on live send?"
        description="Approved drafts will post to Slack and Gmail for real. Each send still needs Preview and Confirm, with a 10 s undo window."
        confirmLabel="Turn on live send"
        tone="danger"
        busy={patch.isPending}
        onConfirm={() => set(false)}
      />
    </div>
  );
}

// ── Since you left ──────────────────────────────────────────────────────────────────────────

/** MIN-27: the server's start (moved by the browser's `x-cc-away-since`), the same one Home and Today count from. */
export function useSinceDigest(): SinceDigest | undefined {
  return useApi('getSince').data;
}

/** Since you left shows 8 changes, then "See all N" (2026-11-13 audit C8: the list never stops silently). */
export const SINCE_SHOWN = 8;

export function SinceList({ digest: d }: { digest: SinceDigest }) {
  const [all, setAll] = useState(false);
  const shown = all ? d.entries : d.entries.slice(0, SINCE_SHOWN);
  return (
    <>
      <div className="flex gap-4 px-4 pb-2 text-caption text-muted">
        {(['changed', 'closed', 'new', 'reopened'] as const).map((k) => (
          <span key={k}>
            <span className="font-bold text-fg tabular-nums">{d.counts[k]}</span> {k}
          </span>
        ))}
      </div>
      {d.entries.length ? (
        <ul className="pb-2">
          {shown.map((e, i) => (
            <li key={`${e.ref.id}-${i}`} className="flex items-start gap-2 px-4 py-1.5 text-body">
              <StatePill size="xs" tone={e.kind === 'closed' ? 'ok' : e.kind === 'reopened' || e.kind === 'waiting' ? 'warn' : e.kind === 'failed' ? 'risk' : 'neutral'} label={e.kind} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-fg">{e.title}</span>
                {e.detail ? <span className="block truncate text-caption text-muted">{e.detail}</span> : null}
              </span>
              <span className="shrink-0 text-caption text-faint">{fmtAgo(e.at, new Date(d.until))}</span>
            </li>
          ))}
          {d.entries.length > SINCE_SHOWN ? (
            <li className="px-4 pt-1">
              <button type="button" onClick={() => setAll((v) => !v)} className="rounded-sm text-caption font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus" data-testid="since-see-all">
                {all ? 'Show fewer' : `See all ${d.entries.length}`}
              </button>
            </li>
          ) : null}
        </ul>
      ) : (
        <EmptyState size="panel" title="Quiet while you were away" />
      )}
    </>
  );
}

// ── The two popovers ────────────────────────────────────────────────────────────────────────

const STATUS_IDS: Array<Exclude<UtilityId, null>> = ['catchup', 'dryrun', 'since'];

function StatusBody({ health, openedAs, close }: { health?: HealthPayload; openedAs: Exclude<UtilityId, null>; close: () => void }) {
  const since = useSinceDigest();
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    ref.current?.querySelector(`[data-section="${openedAs}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [openedAs]);
  const s = health?.summary;
  return (
    <div ref={ref} className="divide-y divide-line">
      <section data-section="catchup" aria-label="Sources">
        <SectionHead extra={s ? `${s.ok}/${s.total} live` : undefined}>Sources</SectionHead>
        <SourcesList connectors={health?.connectors} />
        <div className="px-4 pb-3 text-right">
          <AppLink href="/health" onClick={close} className="text-caption font-bold">
            Open Health
          </AppLink>
        </div>
      </section>
      <section data-section="dryrun" aria-label="Sending">
        <SectionHead>Sending</SectionHead>
        <SendingSection dryRun={health?.dryRun} onDone={close} />
      </section>
      {since?.show ? (
        <section data-section="since" aria-label="Since you left">
          <SectionHead extra={`away ${Math.round(since.awayMinutes / 60)}h`}>Since you left</SectionHead>
          <SinceList digest={since} />
        </section>
      ) : null}
    </div>
  );
}

export function StatusPopover({ health, trigger }: { health?: HealthPayload; trigger: ReactElement }) {
  return (
    <UtilityPanel id={STATUS_IDS} title="Sources and sending" width={440} trigger={trigger}>
      {(close, openedAs) => <StatusBody health={health} openedAs={openedAs} close={close} />}
    </UtilityPanel>
  );
}

export function SpendPopover({ spend, trigger }: { spend?: HealthPayload['spend']; trigger: ReactElement }) {
  const shell = useShell();
  const pct = spend ? Math.min(100, Math.round(spend.today.pct)) : 0;
  return (
    <UtilityPanel id="spend" title="AI spend today" width={360} trigger={trigger}>
      {spend ? (
        <div className="space-y-3 p-4 text-body">
          <div>
            <div className="flex items-baseline justify-between">
              <span className="text-heading font-bold text-fg-heading tabular-nums">{fmtUsd(spend.today.usd)}</span>
              <span className="text-caption text-muted">
                soft {fmtUsd(spend.today.softBudgetUsd)} · cap {fmtUsd(spend.today.hardCapUsd)}
              </span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-sunken" role="meter" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Share of soft budget">
              <div className={cn('h-full rounded-full', spend.state === 'ok' ? 'bg-accent' : spend.state === 'capped' ? 'bg-danger-500' : 'bg-warning-500')} style={{ width: `${pct}%` }} />
            </div>
          </div>
          {spend.byScanner.length ? (
            <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-1 text-caption">
              {spend.byScanner.slice(0, 6).map((s) => (
                <div key={s.name} className="contents">
                  <dt className="truncate text-muted">{s.name}</dt>
                  <dd className="text-right text-fg tabular-nums">{fmtUsd(s.usd)}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          <div className="flex items-center gap-2">
            {spend.state !== 'ok' ? <RaiseCapButton spend={spend} size="xs" variant={spend.state === 'capped' ? 'primary' : 'secondary'} /> : null}
            <AppLink href="/health?tab=spend" onClick={() => shell.setUtility(null)} className="ml-auto text-caption font-bold">
              Spend details
            </AppLink>
          </div>
        </div>
      ) : (
        <EmptyState size="panel" title="No spend yet today" />
      )}
    </UtilityPanel>
  );
}
