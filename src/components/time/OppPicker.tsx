'use client';
/**
 * The Opportunity field of a Time row (Needs you, Log it, the week's rows, the Ledger, a row's details): a combobox
 * over GET /time/opps, in groups (./opp-picker-derive.ts): the row's suggestion first (an opp, or internal work, with
 * its reason), then "Internal (no opportunity)" as a first-class choice, then the opps of the account the app thinks
 * the row is for (its own, else the suggestion's), what you used lately, then the rest. Typing filters (the row's
 * account first); "Search Org62 for '…'" runs one read-only Org62 lookup (POST /time/opps/org62-search) and lists the
 * hits in place under "From Org62", the first choice when nothing in the app matches. A hit the app has sets the row
 * like any opp; one it lacks is added from Org62 with its account and set, in one undoable change (POST
 * /activity/:id/org62-opp, Undo in the toast). The list loads on hover or focus, so it is there when it opens.
 * D-64: "Internal (no opportunity)" (when the caller offers it) makes the row internal-only work: no opportunity, an
 * internal task type, Related To empty in Org62; an internal row shows it, and picking an opportunity takes it back.
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import type { ActivityEntry, Org62OppHit, Org62OppSearch } from '@/contract';
import { api, ApiError } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { cn, Combobox, Icon, Spinner } from '@/ui';
import { INTERNAL_LABEL, MAX_LISTED, pickerList, type PickerItem } from './opp-picker-derive';
import { pct } from './rows-derive';
import { hasTarget } from '@/lib/time-internal';

export { INTERNAL_LABEL } from './opp-picker-derive';

type Opt = PickerItem | { key: string; label: string; group?: string; disabled?: boolean; kind: 'hit'; hit: Org62OppHit };

export interface OppPickerProps {
  entry: ActivityEntry;
  disabled?: boolean;
  className?: string;
  /** An opp the app has: the row's autosave sets it (name and account shown at once). */
  onPick: (oppId: string | null, shown: { oppName: string | null; accountName: string | null }) => void;
  /**
   * Bulk use (Needs you ▸ "Set the opportunity for 6 rows"): the trigger's text, in place of the row's opp. The list is
   * still ranked for `entry` (the first selected row).
   */
  triggerLabel?: ReactNode;
  /** An Org62 hit the app lacked was added and set on `entry`: the rest of a bulk pick follows with its opp. */
  onAdded?: (entity: ActivityEntry) => void;
  /** D-64: offer "Internal (no opportunity)" (the row, or a bulk pick's rows, become internal-only work). */
  onInternal?: () => void;
  /** The closed field's prompt when the row has no opp (default "Needs opp…"). */
  placeholder?: string;
  /** An Org62 account hit the app has: the row logs to the account itself (no opportunity). Absent: account hits are not offered. */
  onAccount?: (accountId: string, accountName: string) => void;
}

const fmtClose = (d: string | null) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : null);
const WHY: Record<string, string> = { account: 'This account', evidence: 'From its evidence', related: 'Account in its evidence', recent: 'Used lately' };

function Meta({ parts }: { parts: Array<string | null | undefined> }) {
  const text = parts.filter(Boolean).join(' · ');
  // 2026-11-13 audit C5: a cut why line reads in full on hover
  return (
    <span className="block truncate text-caption text-muted" title={text || undefined}>
      {text}
    </span>
  );
}

export function OppPicker({ entry, disabled, className, onPick, triggerLabel, onAdded, onInternal, placeholder, onAccount }: OppPickerProps) {
  const [open, setOpen] = useState(false);
  const [intent, setIntent] = useState(false);
  const [q, setQ] = useState('');
  const [search, setSearch] = useState<{ q: string; state: 'loading' | 'done' | 'error'; result?: Org62OppSearch; error?: string } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const seq = useRef(0);
  const opts = useApi('getOppOptions', { query: { entryId: entry.id } }, { enabled: open || intent, staleTime: 60_000 });
  const add = useOptimisticMutation({
    route: 'pickOrg62Opp',
    topics: ['time', 'deals'],
    optimistic: (input, cache) => {
      const hit = search?.result?.hits.find((h) => h.org62Id === input.body?.org62Id);
      if (hit) cache.patchEntity(entry.id, (e) => ({ ...e, oppName: hit.name, accountName: hit.accountName ?? e.accountName }));
    },
    toast: (r) => ({ title: `Added from Org62: ${r.entity.oppName ?? 'opportunity'}`, body: 'The row logs to it; Undo removes it from the app again.' }),
    onSuccess: (r) => {
      setAdding(null);
      onAdded?.(r.entity);
    },
    onError: () => setAdding(null),
  });

  const term = q.trim();
  const found = search && search.q === term ? search : null;
  const suggestion = triggerLabel ? null : entry.suggestion;
  const options = useMemo<Opt[]>(() => {
    const list: Opt[] = pickerList({ opps: opts.data?.opps ?? [], q, entry: { ...entry, suggestion }, internal: !!onInternal, bulk: !!triggerLabel, searched: found?.state === 'done', searching: found?.state === 'loading' });
    if (term.length >= 2 && found?.state === 'done') {
      const inList = new Set(list.flatMap((o) => (o.kind === 'opp' ? [o.opp.id] : [])));
      for (const h of found.result!.hits) {
        // an account hit logs the row to the account itself: only when the caller offers it and the app has the account
        if (h.kind === 'account') {
          if (onAccount) list.push({ key: `o62a:${h.org62Id}`, label: `${h.name} (the account, Org62)`, kind: 'hit', hit: h, group: 'Accounts in Org62', disabled: !h.accountId });
          continue;
        }
        if (!h.oppId || !inList.has(h.oppId)) list.push({ key: `o62:${h.org62Id}`, label: `${h.name}${h.accountName ? `, ${h.accountName}` : ''} (Org62)`, kind: 'hit', hit: h, group: 'From Org62' });
      }
    }
    return list;
  }, [opts.data, q, term, entry, suggestion, found, triggerLabel, onInternal, onAccount]);

  const runSearch = (text: string) => {
    const my = ++seq.current;
    setSearch({ q: text, state: 'loading' });
    api('searchOrg62Opps', { body: { q: text } })
      .then((result) => my === seq.current && setSearch({ q: text, state: 'done', result }))
      .catch((e: unknown) => my === seq.current && setSearch({ q: text, state: 'error', error: e instanceof ApiError ? e.message : 'The Org62 search failed' }));
  };

  const onPickOpt = (o: Opt): void | 'keep' => {
    if (o.kind === 'search') {
      runSearch(o.q);
      return 'keep';
    }
    if (o.kind === 'more') return 'keep';
    if (o.kind === 'internal') return onInternal?.();
    if (o.kind === 'clear') return onPick(null, { oppName: null, accountName: entry.accountName });
    if (o.kind === 'opp') return onPick(o.opp.id, { oppName: o.opp.name, accountName: o.opp.accountName });
    if (o.hit.kind === 'account') return o.hit.accountId ? onAccount?.(o.hit.accountId, o.hit.name) : 'keep';
    if (o.hit.oppId) return onPick(o.hit.oppId, { oppName: o.hit.name, accountName: o.hit.accountName });
    setAdding(o.hit.name);
    add.mutate({ params: { id: entry.id }, body: { ifVersion: add.versionOf(entry.id) ?? entry.version, org62Id: o.hit.org62Id } });
  };

  const firstHit = found?.state === 'done' ? options.find((o) => o.kind === 'hit')?.key : undefined;
  const hits = found?.state === 'done' ? found.result!.hits.length : null;
  const status = opts.isLoading ? (
    <span className="inline-flex items-center gap-1.5">
      <Spinner size="xs" /> Loading opportunities…
    </span>
  ) : found?.state === 'loading' ? (
    <span className="inline-flex items-center gap-1.5">
      <Spinner size="xs" /> Searching Org62 for “{found.q}” (read only)…
    </span>
  ) : found?.state === 'error' ? (
    <span className="text-danger-700">{found.error}</span>
  ) : found?.state === 'done' ? (
    [hits ? `${hits} in Org62 for “${found.q}”: pick one to set it (one the app lacks is added from Org62).` : `Nothing in Org62 matches “${found.q}”.`, ...found.result!.notes].join(' ')
  ) : term.length === 1 ? (
    'Type one more letter to search Org62 too.'
  ) : !term ? (
    'Type to filter, or to search Org62 for an opportunity the app doesn’t have.'
  ) : null;

  const needsOpp = !hasTarget(entry);
  const value = adding ? (
    <span className="inline-flex items-center gap-1.5">
      <Spinner size="xs" /> {adding}
    </span>
  ) : triggerLabel ? (
    triggerLabel
  ) : entry.internal && !entry.oppId ? (
    <span className="text-muted">{INTERNAL_LABEL}</span>
  ) : entry.accountId && !entry.oppId ? (
    // D-103 (c): the row logs to the account itself
    <span className="line-clamp-2 break-words whitespace-normal">{`${entry.accountName ?? 'The account'} (the account)`}</span>
  ) : needsOpp ? (
    (placeholder ?? 'Needs opp…')
  ) : (
    // the name wraps to two lines (the full name and account are the tooltip): never cut off mid-word in one line
    <span className="line-clamp-2 break-words whitespace-normal">{entry.oppName ?? entry.oppId}</span>
  );

  return (
    <Combobox<Opt>
      label="Opportunity"
      data-testid="opp-picker"
      value={value}
      title={triggerLabel ? undefined : entry.oppName ? `${entry.oppName}${entry.accountName ? ` · ${entry.accountName}` : ''}` : (entry.accountName ?? undefined)}
      disabled={disabled}
      triggerClassName={className}
      options={options}
      query={q}
      width="min(38rem, 92vw)"
      onQueryChange={(v) => setQ(v)}
      onPick={onPickOpt}
      selectedKey={entry.oppId ? `opp:${entry.oppId}` : entry.internal && !triggerLabel ? 'internal' : null}
      activeKey={firstHit ?? null}
      placeholder="Find an opportunity or account, or search Org62"
      onIntent={() => setIntent(true)}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch(null);
      }}
      status={status}
      empty={opts.isLoading ? null : 'No opportunity matches. Type two letters to search Org62.'}
      renderOption={(o, s) => {
        if (o.kind === 'search')
          return (
            <span className={cn('flex min-w-0 flex-1 items-center gap-2', o.disabled ? 'text-faint' : 'text-link')} data-option="org62-search">
              <Icon name="search" size="xs" />
              <span className="truncate">
                Search Org62 for “<span className="font-bold">{o.q}</span>”
              </span>
              <span className="ml-auto shrink-0 text-caption text-muted">read only</span>
            </span>
          );
        if (o.kind === 'more') return <span className="min-w-0 flex-1 text-caption text-muted">{`Showing ${MAX_LISTED} of ${o.total}: type a few letters of the opp or account to narrow (${o.n} more match)`}</span>;
        if (o.kind === 'clear') return <span className="min-w-0 flex-1 truncate text-muted">No opportunity (the row needs one to be logged)</span>;
        if (o.kind === 'internal')
          return (
            <span className="flex min-w-0 flex-1 items-center gap-3" data-option="internal">
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fg', s.active && 'font-bold')}>{INTERNAL_LABEL}</span>
                <Meta parts={o.suggested && suggestion ? [suggestion.reason] : ['Work for no customer: Related To empty in Org62', 'an internal task type (Asset Creation…)']} />
              </span>
              {o.suggested && suggestion ? <SuggestedTag c={suggestion.confidence} /> : null}
            </span>
          );
        if (o.kind === 'hit' && o.hit.kind === 'account') {
          const h = o.hit;
          return (
            <span className="flex min-w-0 flex-1 items-center gap-3" data-option="org62-account">
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fg', s.active && 'font-bold')} title={h.name}>
                  {h.name}
                </span>
                <Meta parts={['Log it to the account itself (no opportunity)', h.owner]} />
              </span>
              <span className={cn('shrink-0 text-caption', h.accountId ? 'text-link' : 'text-faint')}>{h.accountId ? 'Logs to the account' : 'Not in the app yet'}</span>
            </span>
          );
        }
        if (o.kind === 'hit') {
          const h = o.hit;
          return (
            <span className="flex min-w-0 flex-1 items-center gap-3">
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate text-fg', s.active && 'font-bold')} title={h.name}>
                  {h.name}
                </span>
                <Meta parts={[h.accountName, h.stage, h.closeDate ? `closes ${fmtClose(h.closeDate)}` : null, h.owner]} />
              </span>
              <span className={cn('shrink-0 text-caption', h.oppId ? 'text-muted' : 'text-link')}>{h.oppId ? 'In the app' : h.accountId ? 'Adds the opp' : 'Adds opp + account'}</span>
            </span>
          );
        }
        const op = o.opp;
        return (
          <span className="flex min-w-0 flex-1 items-center gap-3">
            <span className="min-w-0 flex-1">
              <span className={cn('block truncate text-fg', s.active && 'font-bold')} title={op.name}>
                {op.name}
              </span>
              <Meta parts={o.suggested && suggestion ? [suggestion.reason] : [op.accountName, op.stage || null, op.closeDate ? `${op.isOpen ? 'closes' : 'closed'} ${fmtClose(op.closeDate)}` : null]} />
            </span>
            {o.suggested && suggestion ? <SuggestedTag c={suggestion.confidence} /> : op.why[0] ? <span className="shrink-0 text-caption text-faint">{WHY[op.why[0]]}</span> : null}
          </span>
        );
      }}
    />
  );
}

/** "✦ 86%": the app's suggestion, in the AI color. */
function SuggestedTag({ c }: { c: number }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 text-caption font-bold text-ai-700 tabular-nums">
      <span aria-hidden>✦</span>
      {pct(c)}
    </span>
  );
}
