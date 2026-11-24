'use client';
/**
 * Activity ▸ Org62 ▸ Use cases (D-70, docs/design/landings.md): every use case with its account and opportunity, where
 * it landed ("Org62 ✓ · VDP —": neither, one or both), what goes on the next canvas, and, one click deeper, both
 * landings with their values, the fields that differ (pick the right value: the other side is corrected, an Org62
 * UPDATE on the next canvas or a VDP change to push), its assets (VDP only) and every write that put it there.
 *
 * GET /activity/use-cases · POST /activity/use-cases/:key/pick · POST /activity/use-cases/:key/fix. Nothing is sent
 * from here: corrections ride the next canvas or the next VDP push, each with its own Apply.
 */
import { useState } from 'react';
import type { UseCaseDifference, UseCaseLanding } from '@/contract';
import { api } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { useDetails } from '@/components/deals/context-frame';
import { ActionRow } from '@/components/kit';
import { AppLink } from '@/components/shell/AppLink';
import { errorText } from '@/lib/error-text';
import { Button, cn, EmptyState, Skeleton, StatePill } from '@/ui';

import { LandingPill, LandingPills, WriteList } from './LandingParts';
import { ucGroups, UC_FILTERS, whereLine, type UcFilter } from './landing-derive';
import { plainWords } from './plain';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * To log ▸ Use cases: every use case, filtered (all · in both · Org62 only · VDP only · neither · differ · ready ·
 * questions), grouped by company; a row opens both systems side by side.
 */
export function UseCaseList() {
  const q = useApi('getUseCaseLandings', undefined);
  const [filter, setFilter] = useState<UcFilter>('all');
  const [open, setOpen] = useState<string | null>(null);
  const d = q.data;
  const c = d?.counts;
  const groups = d ? ucGroups(d.items, filter) : [];
  return (
    <div className="flex min-w-0 shrink-0 flex-col gap-4" data-testid="use-cases">
      {c ? (
        <p className="max-w-[72ch] text-caption text-muted" data-testid="use-cases-summary">
          {`${plural(d!.items.length, 'use case')}: ${c.both} in both · ${c.org62} in Org62 only · ${c.vdp} in VDP only · ${c.neither} in neither${c.differs ? ` · ${c.differs} differ` : ''}. Each should be in Org62 (on its opportunity) and in VDP. Open one to see both side by side and pick the right value where they differ.`}
        </p>
      ) : null}
      <div role="radiogroup" aria-label="Show" className="flex flex-wrap gap-1.5" data-testid="use-case-filters">
        {UC_FILTERS.map((f) => {
          const n = !d ? null : f.value === 'all' ? d.items.length : f.value === 'differs' ? c!.differs : f.value === 'ready' ? c!.ready : f.value === 'questions' ? c!.questions : c![f.value];
          return (
            <button key={f.value} type="button" role="radio" aria-checked={filter === f.value} onClick={() => setFilter(f.value)} className={cn('h-7 rounded-full border px-3 text-caption font-bold transition-colors focus-visible:outline-none focus-visible:shadow-focus', filter === f.value ? 'border-accent bg-selected text-fg' : 'border-line bg-surface text-muted hover:bg-surface-muted')}>
              {f.label}
              {n !== null ? <span className="ml-1 tabular-nums">{n}</span> : null}
            </button>
          );
        })}
      </div>
      {q.isLoading ? <Skeleton variant="block" className="h-64 w-full" /> : null}
      {d && !d.items.length ? <EmptyState icon="clock" title="No use cases yet" body="Use cases come from your VDPs and from the use cases on your opportunities in Org62. They show here after the next VDP read or Org62 check finds them." /> : null}
      {d && d.items.length && !groups.length ? <p className="text-caption text-muted">None match this filter.</p> : null}
      {groups.map((g) => (
        <section key={g.company} className="min-w-0 rounded-lg bg-surface" aria-label={g.company}>
          <h3 className="px-4 pt-3 pb-1 text-body-lg font-bold text-fg-heading">{g.company}</h3>
          <div role="grid" aria-label={`Use cases at ${g.company}`} className="min-w-0 px-1">
            {g.items.map((x) => (
              <UseCaseRow key={x.key} x={x} open={open === x.key} onToggle={() => setOpen((cur) => (cur === x.key ? null : x.key))} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

/** One use case, an ActionRow: its name, where it landed as the badge, what goes next as the why; Space or the row opens both sides. */
function UseCaseRow({ x, open, onToggle }: { x: UseCaseLanding; open: boolean; onToggle: () => void }) {
  return (
    <ActionRow
      id={x.key}
      data-testid="use-case-row"
      data-use-case={x.key}
      title={x.title}
      aria-expanded={open}
      edge={x.question ? 'warning' : x.differences.length ? 'warning' : 'none'}
      badge={
        <span className="flex flex-wrap items-center gap-1.5">
          <LandingPills org62={x.org62} vdp={x.vdp} />
          {x.differences.length ? <StatePill tone="warn" size="xs" label={`${x.differences.length} differ`} icon={false} /> : null}
          {x.ready ? <StatePill tone="neutral" size="xs" dashed label="next batch" icon={false} /> : null}
          {x.question ? <StatePill tone="warn" size="xs" label="needs you" icon={false} /> : null}
        </span>
      }
      why={plainWords([x.oppName ?? 'No opportunity yet', x.accountName, x.sends ?? x.why].filter(Boolean).join(' · '))}
      altVerb={{ label: open ? 'Hide' : 'Both sides', onClick: onToggle }}
      expanded={open}
      onExpandedChange={() => onToggle()}
      expansion={<UseCaseDetail x={x} />}
      onOpen={() => onToggle()}
    />
  );
}

/** One use case, one click deeper: both landings, the differences with pick, the question, assets, writes. */
export function UseCaseDetail({ x }: { x: UseCaseLanding }) {
  const { open: openPanel } = useDetails();
  return (
    <div className="grid min-w-0 gap-4" data-testid="use-case-detail">
      <div className="grid min-w-0 gap-3 @container md:grid-cols-2">
        <LandingCard title="Org62" dest="org62" x={x} />
        <LandingCard title="VDP" dest="vdp" x={x} />
      </div>
      {x.question ? <QuestionBox x={x} /> : null}
      {x.differences.length ? <Differences x={x} /> : null}
      <div className="min-w-0">
        <h4 className="mb-1 text-caption font-bold text-fg-heading">Assets (VDP only)</h4>
        {x.assets.length ? (
          <ul className="min-w-0 space-y-1 text-caption" data-testid="use-case-assets">
            {x.assets.map((a) => (
              <li key={a.id} className="flex min-w-0 flex-wrap items-baseline gap-2">
                <LandingPill dest="vdp" landing={{ state: a.state, url: null }} />
                <a href={a.url} target="_blank" rel="noreferrer" className="min-w-0 font-bold break-words text-link hover:underline">
                  {a.title}
                </a>
                <span className="text-muted">{[a.kind, a.words].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-caption text-muted">No assets on its VDP yet (Activity ▸ VDP finds and adds them).</p>
        )}
      </div>
      <div className="min-w-0">
        <h4 className="mb-1 text-caption font-bold text-fg-heading">Writes that put it there</h4>
        <WriteList writes={x.writes} showLabel={false} showCanvas onCanvas={(id) => openPanel({ kind: 'draft', id, label: 'Logging batch' })} empty="None yet: nothing the app staged has written it." />
      </div>
    </div>
  );
}

const VALUE_LABEL: Record<string, string> = { Use_Case_Name__c: 'Name', Product__c: 'Product', Stage__c: 'Stage', Go_Live_Date__c: 'Go-Live', Opportunity__c: 'Opportunity', Account__c: 'Account', title: 'Name', track: 'Track', execution_phase: 'Phase', execution_target_date: 'Target date' };

function LandingCard({ title, dest, x }: { title: string; dest: 'org62' | 'vdp'; x: UseCaseLanding }) {
  const l = dest === 'org62' ? x.org62 : x.vdp;
  const vals = Object.entries(l?.remoteValues ?? {}).filter(([k]) => VALUE_LABEL[k]);
  return (
    <section className="min-w-0 rounded-md bg-surface p-3" aria-label={title} data-testid={`use-case-${dest}`}>
      <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
        <h4 className="text-caption font-bold text-fg-heading">{title}</h4>
        <LandingPill dest={dest} landing={l} size="sm" />
        {l?.url ? (
          <a href={l.url} target="_blank" rel="noreferrer" className="text-caption text-link hover:underline">
            {`Open in ${title} ↗`}
          </a>
        ) : null}
      </div>
      {vals.length ? (
        <dl className="grid grid-cols-[minmax(6rem,max-content)_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-caption">
          {vals.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{VALUE_LABEL[k]}</dt>
              <dd className="min-w-0 break-words text-fg">{v || '(empty)'}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-caption text-muted">{l?.state === 'staged' ? 'In a batch or item waiting for your Apply.' : l?.state === 'sent' ? 'Sent: waiting for the next read.' : l?.state === 'missing' ? 'Not found there any more.' : `Not in ${title}.`}</p>
      )}
    </section>
  );
}

function Differences({ x }: { x: UseCaseLanding }) {
  const [busy, setBusy] = useState<string | null>(null);
  const pick = async (d: UseCaseDifference, take: 'org62' | 'vdp' | null) => {
    setBusy(d.field);
    try {
      const r = await api('pickUseCaseValue', { params: { key: x.key }, body: { field: d.field, take } });
      toast({
        key: `uc-pick:${x.key}:${d.field}`,
        tone: 'success',
        title: take ? `${x.title}: ${take === 'org62' ? 'Org62' : 'VDP'}’s ${d.label} is right` : `${x.title}: pick cleared`,
        body: take === 'vdp' ? 'Org62 gets it in your next batch (an UPDATE row you Apply).' : take === 'org62' ? 'VDP gets it on your next push (Activity ▸ VDP ▸ Changes).' : undefined,
        undo: r.auditId ? { auditId: r.auditId } : undefined,
      });
    } catch (err) {
      toast({ key: `uc-pick:${x.key}`, tone: 'error', title: 'Couldn’t save that pick', body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="min-w-0" data-testid="use-case-differences">
      <h4 className="mb-1 text-caption font-bold text-fg-heading">Where Org62 and VDP differ</h4>
      <p className="mb-2 text-caption text-muted">The same use case is kept in both, so a difference is a duplicate that drifted. Pick the right value: the other side is corrected the next time you log (Org62) or push (VDP). Nothing changes on its own.</p>
      <div className="min-w-0 overflow-x-auto">
        <table className="w-full min-w-[36rem] text-caption">
          <thead>
            <tr className="text-left text-muted">
              <th className="py-1 pr-3 font-bold">Field</th>
              <th className="py-1 pr-3 font-bold">Org62</th>
              <th className="py-1 pr-3 font-bold">VDP</th>
              <th className="py-1 pr-3 font-bold">Changed since they agreed</th>
              <th className="py-1 font-bold">Right value</th>
            </tr>
          </thead>
          <tbody>
            {x.differences.map((d) => (
              <tr key={d.field} className="border-t border-line align-top" data-testid="use-case-difference" data-field={d.field}>
                <td className="py-1.5 pr-3 font-bold text-fg">{d.label}</td>
                <td className={cn('py-1.5 pr-3 break-words', d.pick === 'org62' ? 'font-bold text-fg' : 'text-fg')}>{d.org62 || '(empty)'}</td>
                <td className={cn('py-1.5 pr-3 break-words', d.pick === 'vdp' ? 'font-bold text-fg' : 'text-fg')}>{d.vdp || '(empty)'}</td>
                <td className="py-1.5 pr-3 text-muted">{d.changed === 'unknown' ? 'They never agreed' : d.changed === 'both' ? 'Both' : d.changed === 'org62' ? 'Org62' : 'VDP'}</td>
                <td className="py-1.5">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Button size="xs" variant={d.pick === 'org62' ? 'secondary' : 'quiet'} disabled={!!d.take.org62 || busy === d.field} title={d.take.org62 ?? 'Org62’s value is right: VDP is corrected on your next push'} onClick={() => void pick(d, d.pick === 'org62' ? null : 'org62')} data-testid="pick-org62">
                      {d.pick === 'org62' ? 'Org62’s ✓' : 'Use Org62’s'}
                    </Button>
                    <Button size="xs" variant={d.pick === 'vdp' ? 'secondary' : 'quiet'} disabled={!!d.take.vdp || busy === d.field} title={d.take.vdp ?? 'VDP’s value is right: Org62 is corrected in your next batch'} onClick={() => void pick(d, d.pick === 'vdp' ? null : 'vdp')} data-testid="pick-vdp">
                      {d.pick === 'vdp' ? 'VDP’s ✓' : 'Use VDP’s'}
                    </Button>
                  </div>
                  <p className="mt-0.5 text-muted">{d.next}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** A use case's question, answered in place: the opp it goes on, a name, or leave it out of Org62. */
function QuestionBox({ x, inline = false }: { x: UseCaseLanding; inline?: boolean }) {
  const q = x.question!;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const fix = async (body: { opportunityId?: string; name?: string; leave?: boolean }, title: string) => {
    setBusy(true);
    try {
      const r = await api('fixUseCase', { params: { key: x.key }, body });
      toast({ key: `uc-fix:${x.key}`, tone: 'success', title, undo: r.auditId ? { auditId: r.auditId } : undefined });
    } catch (err) {
      toast({ key: `uc-fix:${x.key}`, tone: 'error', title: 'Couldn’t save that', body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-w-0 rounded-md border border-warning-200 bg-surface p-3" data-testid="use-case-question">
      <p className="text-caption font-bold text-fg">{q.text}</p>
      <p className="mt-0.5 text-caption text-muted">{plainWords(x.why)}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        {q.code === 'pick_opp' || q.code === 'no_account'
          ? q.opps.map((o) => (
              <Button key={o.org62Id} size="xs" variant="secondary" disabled={busy} onClick={() => void fix({ opportunityId: o.org62Id }, `${x.title} goes on ${o.name}`)}>
                {o.name}
              </Button>
            ))
          : null}
        {q.code === 'no_title' ? (
          <form
            className="flex items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (name.trim()) void fix({ name: name.trim() }, `Named it “${name.trim()}”`);
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Its name in Org62" aria-label="Use case name" className="h-7 w-56 rounded-md border border-line bg-surface px-2 text-caption text-fg" />
            <Button size="xs" variant="secondary" type="submit" disabled={busy || !name.trim()}>
              Name it
            </Button>
          </form>
        ) : null}
        {q.code === 'waiting_dc' ? (
          <AppLink href="/deals/dcs" className="text-caption font-bold text-link hover:underline">
            Claim your DC (Deals ▸ DCs)
          </AppLink>
        ) : null}

        {q.code !== 'pick_value' ? (
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void fix({ leave: true }, `${x.title}: left out of Org62`)}>
            Leave it out of Org62
          </Button>
        ) : null}
        {x.vdpUrl ? (
          <a href={x.vdpUrl} target="_blank" rel="noreferrer" className="text-caption text-link hover:underline">
            Open in VDP ↗
          </a>
        ) : null}
      </div>
      {/* a value to pick: the differences, answered right here */}
      {q.code === 'pick_value' && inline ? (
        <div className="mt-2">
          <Differences x={x} />
        </div>
      ) : null}
    </div>
  );
}

/** Needs you ▸ Use cases: the ones with a question, each answered in place (they move to To log ▸ Ready to log). */
export function UseCaseQuestions({ items }: { items: readonly UseCaseLanding[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <ul className="min-w-0 rounded-lg bg-surface" data-testid="needs-use-cases">
      {items.map((x) => (
        <li key={x.key} className="min-w-0 border-t border-line px-4 py-2.5 first:border-t-0">
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 font-bold break-words text-fg">{x.title}</span>
            <span className="text-caption text-muted">{[x.companyName, x.oppName].filter(Boolean).join(' · ')}</span>
            <span className="text-caption text-muted">{whereLine(x)}</span>
            <button type="button" className="text-caption font-bold text-link hover:underline" onClick={() => setOpen((c) => (c === x.key ? null : x.key))} aria-expanded={open === x.key}>
              {open === x.key ? 'Hide details' : 'Details'}
            </button>
          </div>
          <div className="mt-2">{open === x.key ? <UseCaseDetail x={x} /> : <QuestionBox x={x} inline />}</div>
        </li>
      ))}
    </ul>
  );
}
