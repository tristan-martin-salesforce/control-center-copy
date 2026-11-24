'use client';
/**
 * Settings ▸ Time (onsite lane): onsite days and travel. Explicit save, like the other sections.
 *
 *   Detect onsite days       On     a trip, an onsite event or in-person customer meetings make the day an onsite day
 *   Onsite hours             08:00–17:00 in the trip's time zone: the frame that fills the gaps between sessions
 *   Airport buffer           before each flight (120 min) and after it lands (60 min), logged as Travel; two fields
 *                            (2026-11-14: the engine reads airportBufferBeforeMin / airportBufferAfterMin, and a legacy
 *                            symmetric airportBufferMin still applies to a side never set)
 *   Customer dinners         count as customer-facing (off: not counted)
 *   Overlapping meetings     Log every accepted meeting (default) / Count overlapping time once (D-18 amended)
 *   Dismissed sources        D-64: every "Dismiss all from <source>" rule (a repo, unmapped Drive docs, a recurring
 *                            series) with Remove (its rows come back as proposals; Undo in the toast). Saves at once.
 *   AEs I cover              the attribution engine: AEs whose deals discovery, attribution and DC suggestions include,
 *                            each toggled on or off; a lookup over the app's people, then one read-only Org62 User read
 *   DC suggestions           the products a DC counts for (dcProducts), the default split, how often Org62 discovery runs
 *   Learned rules            every rule the engine learned from your corrections, with Off and Remove. Saves at once.
 * Corrections on the Time and History day chips always apply, whatever is set here.
 */
import { attributionSettingsOf, DEFAULT_LOGGING_SETTINGS, type CoveredAe, type CoveredAeHit, type CoveredAeLookupResult, type MappingRuleView, type TimeDismissRule, type TimeOverlaps, type TimeSettings } from '@/contract';
import { useState } from 'react';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { featureActive, type ResolvedPersona } from '@/personas';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { Button, SegmentedToggle, Skeleton } from '@/ui';
import { airportBuffers } from '@/engines/activity/onsite';
import { Block, Row, Section, SaveActions, SaveFeedback, useSectionForm } from './form';
import { NumberInput, Select, Switch, TextInput } from './controls';
import { CoverageRowFields, coverageWords } from './CoverageRow';
import s from './settings.module.css';

const Loading = () => <Skeleton variant="block" className="mt-6 h-48 w-full" />;
const TIME_KEYS = ['detectOnsite', 'onsiteHours', 'airportBufferMin', 'airportBufferBeforeMin', 'airportBufferAfterMin', 'dinnersCustomerFacing', 'overlaps', 'logging', 'coveredAes', 'dcProducts', 'dcSplit', 'discovery'] as const;

/** A buffer side is 0–360 minutes (the contract's bound). */
export function bufferError(n: number | undefined): string | null {
  return n === undefined || !Number.isFinite(n) || n < 0 || n > 360 ? 'Between 0 and 360 minutes.' : null;
}

/** Settings ▸ Time ▸ Overlapping meetings: the two choices, the default first. */
export const OVERLAP_OPTIONS: readonly { value: TimeOverlaps; label: string }[] = [
  { value: 'log_all_accepted', label: 'Log every accepted meeting (default)' },
  { value: 'count_once', label: 'Count overlapping time once' },
];

export function useTimeForm() {
  return useSectionForm('time', TIME_KEYS, 'Time', 'time');
}

/** "08:00–17:00", the label beside the nav item. */
export function timeSummary(t: Omit<TimeSettings, 'version'> | undefined): string {
  if (!t) return '';
  if (!t.detectOnsite) return 'Onsite detection off';
  const b = airportBuffers(t);
  return `Onsite ${t.onsiteHours.start}–${t.onsiteHours.end} · airport ${b.beforeMin} / ${b.afterMin} min`;
}

/**
 * D-55: the persona's words for Logging to Org62's "Include complete proposed rows" (an AE's Sales Events take no
 * task type) and Org62 discovery's "whose deals" (an SE's opp teams and covered AEs, an AE's own opportunities).
 */
export function completeRowsHelp(p: ResolvedPersona | null): string {
  const needs = p && !p.logging.taskTypeRequired ? 'an opportunity (or account)' : 'a task type and an opportunity (or account)';
  return `A batch also takes proposed rows that have ${needs}, and approves them. Rows that need input are listed, never guessed. Internal rows (no opportunity) always wait for your Log on Activity.`;
}

export function discoveryHelp(p: ResolvedPersona | null): string {
  const whose = !p || p.org62Book === 'team_member' ? 'Your opp teams, the AEs you cover' : p.org62Book === 'owner' ? 'The opportunities you own' : 'The opportunities you own or are on the team of';
  return `${whose} and the accounts you worked on lately: one read-only read, at most 20 lookups a day. New deals become suggestions the same day.`;
}

export function TimeSection() {
  const f = useTimeForm();
  const persona = usePersona();
  const d = f.draft;
  const hours = d.onsiteHours ?? { start: '08:00', end: '17:00' };
  const hoursErr = hours.end <= hours.start ? 'The end has to be after the start.' : null;
  // What the engine uses now (a side never set falls back to the legacy symmetric value, else 120 / 60).
  const buf = airportBuffers(d);
  const beforeErr = bufferError(buf.beforeMin);
  const afterErr = bufferError(buf.afterMin);
  const bufferErr = beforeErr ?? afterErr;
  // Editing one side pins both, so the other never changes under you when the legacy value is dropped later.
  const setBuffer = (side: 'before' | 'after', n: number) => {
    f.set('airportBufferBeforeMin', side === 'before' ? n : buf.beforeMin);
    f.set('airportBufferAfterMin', side === 'after' ? n : buf.afterMin);
  };
  const log = d.logging ?? DEFAULT_LOGGING_SETTINGS;
  const setLog = (patch: Partial<typeof log>) => f.set('logging', { ...log, ...patch });
  const canvasUrl = log.workOrderCanvasUrl ?? '';
  const canvasErr: string | null = canvasUrl && !/^https:\/\/\S+$/.test(canvasUrl.trim()) ? 'A link starts with https:// (copy it from Slack: Copy link).' : null;
  return (
    <Section
      id="time"
      title="Time"
      meta="Onsite days, travel and overlapping meetings. Every session keeps its own row; one onsite frame per day, never overnight."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={!!hoursErr || !!bufferErr || !!canvasErr} testId="save-time" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Loading />
      ) : (
        <Block>
          <Row label="Detect onsite days" htmlFor="t-detect" help="From your trips (hotel and flights), onsite events and in-person customer meetings. Your corrections on a day always apply." edited={f.changed('detectOnsite')}>
            <Switch id="t-detect" label="Detect onsite days" checked={d.detectOnsite ?? true} onChange={(v) => f.set('detectOnsite', v)} testId="t-detect" />
          </Row>
          <Row label="Onsite hours" htmlFor="t-start" help="In the trip's time zone. On the day you fly in or home, the frame starts at your first session or ends at your last." edited={f.changed('onsiteHours')} error={hoursErr}>
            <TextInput id="t-start" type="time" width="sm" value={hours.start} onChange={(e) => f.set('onsiteHours', { ...hours, start: e.target.value })} aria-label="Onsite hours from" />
            <span className={s.unit}>to</span>
            <TextInput id="t-end" type="time" width="sm" value={hours.end} onChange={(e) => f.set('onsiteHours', { ...hours, end: e.target.value })} aria-label="Onsite hours until" aria-invalid={!!hoursErr} />
          </Row>
          <Row label="Airport buffer before a flight" htmlFor="t-buffer-before" help="Travel before each departure (getting to the airport, security), logged as Travel on the trip's account. Duplicate flight entries count once." edited={f.changed('airportBufferBeforeMin')} error={beforeErr}>
            <NumberInput id="t-buffer-before" min={0} max={360} step={15} width={88} value={buf.beforeMin} onValue={(n) => setBuffer('before', n)} data-testid="t-buffer-before" />
            <span className={s.unit}>min</span>
          </Row>
          <Row label="Airport buffer after landing" htmlFor="t-buffer-after" help="Travel after each flight lands (bags, the ride out), logged as Travel on the trip's account." edited={f.changed('airportBufferAfterMin')} error={afterErr}>
            <NumberInput id="t-buffer-after" min={0} max={360} step={15} width={88} value={buf.afterMin} onValue={(n) => setBuffer('after', n)} data-testid="t-buffer-after" />
            <span className={s.unit}>min</span>
          </Row>
          <Row label="Customer dinners count as customer-facing" htmlFor="t-dinner" help="A dinner with customers at the table. Off: it is not counted." edited={f.changed('dinnersCustomerFacing')}>
            <Switch id="t-dinner" label="Customer dinners count as customer-facing" checked={d.dinnersCustomerFacing ?? true} onChange={(v) => f.set('dinnersCustomerFacing', v)} testId="t-dinner" />
          </Row>
          <Row
            label="Overlapping meetings"
            htmlFor="t-overlaps"
            help="Every meeting you accepted logs, even when two overlap (each row says what it overlaps), and an onsite day logs in full with the meetings during it, so a day can total more than the clock. Count once: the meeting that ranks higher keeps the time and onsite hours fill only the gaps. Estimated time (Claude, Drive, Slack) never overlaps either way."
            edited={f.changed('overlaps')}
          >
            <Select id="t-overlaps" value={d.overlaps ?? 'log_all_accepted'} onChange={(e) => f.set('overlaps', e.target.value as TimeOverlaps)} data-testid="t-overlaps">
              {OVERLAP_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Row>
        </Block>
      )}
      {!f.server ? null : (
        <Block title="Logging to Org62">
          <Row label="When to log" htmlFor="t-log-mode" help="On demand: a batch only when you start one (Log to Slackbot on Activity, or ask the Assistant). Automatic: every weekday at the time below the batch is staged by itself, ready for your one-click Apply on Activity. Either way the app checks Org62 and flags anything that didn't land." edited={f.changed('logging')}>
            <SegmentedToggle label="When to log" value={log.mode} onChange={(v) => setLog({ mode: v })} options={[{ value: 'on_demand', label: 'On demand' }, { value: 'automatic', label: 'Automatic' }]} />
          </Row>
          <Row label="Automatic batch time" htmlFor="t-log-at" help="The weekday time (your time zone) the batch is staged when When to log is Automatic. Default 17:30." edited={f.changed('logging')}>
            <TextInput id="t-log-at" type="time" width="sm" value={log.autoAt} disabled={log.mode !== 'automatic'} onChange={(e) => e.target.value && setLog({ autoAt: e.target.value })} aria-label="Automatic batch time" data-testid="t-log-at" />
          </Row>
          <Row label="Canvas" htmlFor="t-log-canvas" help="Each batch becomes a new private canvas Slackbot runs as a work order: Apply it on Activity, open it in Slack and tell Slackbot &ldquo;Execute this canvas&rdquo;. Applied canvases are listed on Activity with their link." edited={f.changed('logging')}>
            <span className={s.unit}>A new private canvas per batch</span>
          </Row>
          <Row label="Work-order canvas link" htmlFor="t-log-canvas-url" help="Your Slackbot work-order canvas, so Time can link to it before your first batch (and build a canvas link when Slack returns only its id). In Slack: open the canvas, Copy link. Empty: no link." edited={f.changed('logging')} error={canvasErr}>
            <TextInput id="t-log-canvas-url" type="url" placeholder="https://your-workspace.slack.com/docs/…" value={canvasUrl} onChange={(e) => setLog({ workOrderCanvasUrl: e.target.value.trim() ? e.target.value : null })} aria-invalid={!!canvasErr} data-testid="t-log-canvas-url" />
          </Row>
          <Row label="Include complete proposed rows" htmlFor="t-log-approve" help={completeRowsHelp(persona)} edited={f.changed('logging')}>
            <Switch id="t-log-approve" label="Include complete proposed rows" checked={log.approveComplete} onChange={(v) => setLog({ approveComplete: v })} testId="t-log-approve" />
          </Row>
        </Block>
      )}
      {!f.server ? null : <DismissedSources />}
      {/* D-55: an SE's list; a persona whose book is its own opps (the Specialist AE) declares none (SectionExtras' CoverageSlot) */}
      {!f.server || (persona && persona.org62Book !== 'team_member') ? null : <CoveredAes f={f} />}
      {!f.server ? null : <DcSettings f={f} persona={persona} />}
      {!f.server ? null : <LearnedRules />}
    </Section>
  );
}

const KIND_WORD: Record<TimeDismissRule['kind'], string> = { repo: 'Repo', docs: 'Drive docs', series: 'Recurring meeting' };

/**
 * D-64: Settings ▸ Time ▸ Dismissed sources: the remembered "Dismiss all from <source>" rules. Remove brings the
 * source's rows back as proposals (one change, Undo in the toast); nothing else here needs Save.
 */
function DismissedSources() {
  const q = useApi('listTimeDismissRules');
  const remove = useOptimisticMutation({
    route: 'removeTimeDismissRule',
    topics: ['time', 'settings'],
    toast: (_r, input) => ({ title: 'Rule removed: its rows are back', body: `Rows from ${q.data?.rules.find((r) => r.key === input.body?.key)?.label ?? 'that source'} are proposed again on Activity.` }),
  });
  const rules = q.data?.rules ?? [];
  return (
    <Block title="Dismissed sources">
      {!rules.length ? (
        <p className="px-1 text-caption text-muted" data-testid="t-dismissed-none">
          None. On Time, More ▸ Dismiss all from… on an internal row sets aside every row of its repo, its unmapped Drive docs or its recurring meeting, now and later.
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="t-dismissed">
          {rules.map((r) => (
            <li key={r.key} className="flex min-w-0 items-center gap-3 rounded-md px-1 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-fg">{r.label}</span>
                <span className="block text-caption text-muted">
                  {KIND_WORD[r.kind]} · {r.rows === 1 ? '1 row set aside' : `${r.rows} rows set aside`} · since {new Date(r.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                </span>
              </span>
              <Button size="xs" variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate({ body: { key: r.key } })} data-testid="t-dismissed-remove">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

type TimeForm = ReturnType<typeof useTimeForm>;

/**
 * Settings ▸ Time ▸ AEs I cover: the AEs whose deals Org62 discovery, the attribution engine and DC suggestions include
 * while toggled on. Add one by name (the app's people first; where Org62 is live, one read-only User read that the worker
 * runs, its matches listed on the next look). Saved with the section.
 */
function CoveredAes({ f }: { f: TimeForm }) {
  const list: CoveredAe[] = f.draft.coveredAes ?? [];
  const [q, setQ] = useState('');
  const lookup = useOptimisticMutation({ route: 'lookupCoveredAe', topics: ['settings'] });
  const [found, setFound] = useState<CoveredAeLookupResult | null>(null);
  const hits: CoveredAeHit[] = found?.hits ?? [];
  const has = (h: { name: string; org62UserId?: string | null }) => list.some((a) => (h.org62UserId && a.org62UserId && a.org62UserId.slice(0, 15) === h.org62UserId.slice(0, 15)) || a.name.toLowerCase() === h.name.toLowerCase());
  const add = (h: { name: string; org62UserId?: string | null; email?: string | null }) => {
    if (has(h)) return;
    f.set('coveredAes', [...list, { name: h.name, ...(h.org62UserId ? { org62UserId: h.org62UserId } : {}), ...(h.email ? { email: h.email } : {}), enabled: true }]);
  };
  const set = (i: number, patch: Partial<CoveredAe> | null) => f.set('coveredAes', patch ? list.map((a, j) => (j === i ? { ...a, ...patch } : a)) : list.filter((_, j) => j !== i));
  return (
    <Block title="AEs I cover">
      <p className="px-1 text-caption text-muted">Their deals join Org62 discovery, the opp suggestions and DC suggestions while on, whether they own the deal, are on its team or own its Specialist Forecast. An AE you support: their deals are suggested as DCs (unticked) even before you touch them. An OOO cover or an SME assist: suggested only once you’ve worked on it, at its split.</p>
      {list.length ? (
        <ul className="grid gap-1" data-testid="t-covered-aes">
          {list.map((a, i) => (
            <li key={`${a.name}:${i}`} className="flex min-w-0 flex-wrap items-center gap-3 rounded-md px-1 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-fg">{a.name}</span>
                <span className="block text-caption text-muted">{a.org62UserId ? `Org62 user ${a.org62UserId.slice(0, 15)}` : 'Matched by name (no Org62 id yet)'}{a.email ? ` · ${a.email}` : ''}</span>
                <span className="block text-caption text-muted">{coverageWords(a)}</span>
                <CoverageRowFields a={a} i={i} onChange={(patch) => set(i, patch)} />
              </span>
              <Switch id={`t-ae-${i}`} label={`Include ${a.name}'s deals`} checked={a.enabled !== false} onChange={(v) => set(i, { enabled: v })} testId="t-ae-toggle" />
              <Button size="xs" variant="ghost" onClick={() => set(i, null)} data-testid="t-ae-remove">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-1 text-caption text-muted" data-testid="t-covered-none">None yet.</p>
      )}
      <form
        className="flex flex-wrap items-center gap-2 px-1"
        onSubmit={(e) => {
          e.preventDefault();
          if (q.trim().length >= 2) void lookup.mutateAsync({ body: { q: q.trim() } }).then(setFound, () => setFound(null));
        }}
      >
        <TextInput id="t-ae-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="An AE's name" aria-label="Find an AE" data-testid="t-ae-q" />
        <Button size="xs" variant="secondary" type="submit" disabled={q.trim().length < 2 || lookup.isPending} data-testid="t-ae-find">
          Find
        </Button>
        {q.trim().length >= 2 && !has({ name: q.trim() }) ? (
          <Button size="xs" variant="ghost" onClick={() => add({ name: q.trim() })} data-testid="t-ae-add-typed">
            {`Add “${q.trim()}” as typed`}
          </Button>
        ) : null}
      </form>
      {found ? (
        <ul className="grid gap-1 px-1" data-testid="t-ae-hits">
          {hits.map((h) => (
            <li key={`${h.name}:${h.org62UserId ?? ''}`} className="flex min-w-0 items-center gap-2 text-caption">
              <span className="min-w-0 flex-1 truncate text-fg">{`${h.name}${h.title ? ` · ${h.title}` : ''}${h.source === 'org62' ? ' · Org62' : ''}`}</span>
              <Button size="xs" variant="secondary" disabled={has(h)} onClick={() => add(h)} data-testid="t-ae-add">
                {has(h) ? 'Added' : 'Add'}
              </Button>
            </li>
          ))}
          {found.note ? <li className="text-caption text-muted">{found.note}</li> : null}
        </ul>
      ) : null}
    </Block>
  );
}

const DISCOVERY_OPTIONS = [
  { value: 'daily', label: 'Daily (default)' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'off', label: 'Off' },
] as const;

/**
 * Settings ▸ Time ▸ DC suggestions: the products that count, the default split, Org62 discovery's cadence. Saved with
 * the section. D-55: without deal contributions (an AE's preset) only Org62 discovery shows; the DC rows come back when
 * the feature is activated in Role & rules.
 */
export function DcSettings({ f, persona }: { f: TimeForm; persona: ResolvedPersona | null }) {
  const a = attributionSettingsOf(f.draft);
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? a.dcProducts.join(', ');
  const dc = !persona || featureActive(persona, 'dealContributions');
  const discovery = (
    <Row label="Look in Org62 for new deals" htmlFor="t-discovery" help={discoveryHelp(persona)} edited={f.changed('discovery')}>
      <Select id="t-discovery" value={a.discovery} onChange={(e) => f.set('discovery', e.target.value as 'daily' | 'weekly' | 'off')} data-testid="t-discovery">
        {DISCOVERY_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    </Row>
  );
  if (!dc) return <Block title="Org62 discovery">{discovery}</Block>;
  return (
    <Block title="DC suggestions and Org62 discovery">
      <Row label="Products a DC counts for" htmlFor="t-dc-products" help="A suggested DC needs one of these in the opportunity's products or name. Empty: every product." edited={f.changed('dcProducts')}>
        <TextInput
          id="t-dc-products"
          value={shown}
          onChange={(e) => {
            setText(e.target.value);
            f.set('dcProducts', e.target.value.split(',').map((x) => x.trim()).filter((x) => x.length >= 2));
          }}
          data-testid="t-dc-products"
        />
      </Row>
      <Row label="Default split" htmlFor="t-dc-split" help="100% (default): a lower split keeps a use case off Org62. Evidence share: when one engagement spans several opps, each suggestion starts at its share of the work. You can change it on each one." edited={f.changed('dcSplit')}>
        <SegmentedToggle label="Default split" value={a.dcSplit} onChange={(v) => f.set('dcSplit', v)} options={[{ value: 'full', label: '100%' }, { value: 'evidence', label: 'Evidence share' }]} />
      </Row>
      {discovery}
    </Block>
  );
}

const RULE_WORD: Record<MappingRuleView['kind'], string> = { domain: 'Domain', channel: 'Slack channel', person: 'Contact', keyword: 'Word', series: 'Recurring meeting', repo: 'Repo' };

/**
 * Settings ▸ Time ▸ Learned rules (the attribution engine's memory, tenet: Suggest, then learn): every rule your
 * corrections taught it, what it maps to, how often it agreed and disagreed. Off stops the engine reading it; Remove
 * deletes it (Undo in the toast). Saves at once.
 */
function LearnedRules() {
  const q = useApi('getAttributionRules');
  const patch = useOptimisticMutation({ route: 'patchAttributionRule', topics: ['settings', 'time'], toast: (r) => ({ title: r.entity.enabled ? 'Rule on again' : 'Rule off: the engine no longer reads it' }) });
  const remove = useOptimisticMutation({ route: 'deleteAttributionRule', topics: ['settings', 'time'], toast: () => ({ title: 'Rule removed', body: 'A later correction can teach it again.' }) });
  const rules = q.data?.rules ?? [];
  return (
    <Block title="Learned rules">
      {!rules.length ? (
        <p className="px-1 text-caption text-muted" data-testid="t-rules-none">
          None yet. Each time you pick an opportunity (or Internal) on Activity, the app learns the meeting series, channel, domain or word behind it, and suggests the same next time.
        </p>
      ) : (
        <ul className="grid gap-1" data-testid="t-rules">
          {rules.map((r) => (
            <li key={r.id} className="flex min-w-0 items-center gap-3 rounded-md px-1 py-1.5" data-active={r.active ? '' : undefined}>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body text-fg">{`${RULE_WORD[r.kind]} ${r.label} → ${r.target.name}`}</span>
                <span className="block text-caption text-muted">
                  {`${r.hits} ${r.hits === 1 ? 'agreement' : 'agreements'}${r.misses ? ` · ${r.misses} against` : ''}${r.lastUsedAt ? ` · last ${new Date(r.lastUsedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}${r.source === 'seed' ? ' · set up for you' : ''}${!r.enabled ? ' · off' : !r.active ? ' · outvoted' : ''}`}
                </span>
              </span>
              <Button size="xs" variant="ghost" disabled={patch.isPending} onClick={() => patch.mutate({ params: { id: r.id }, body: { enabled: !r.enabled } })} data-testid="t-rule-toggle">
                {r.enabled ? 'Off' : 'On'}
              </Button>
              <Button size="xs" variant="secondary" disabled={remove.isPending} onClick={() => remove.mutate({ params: { id: r.id }, body: {} })} data-testid="t-rule-remove">
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Block>
  );
}

/** The effect pane: what the saved values do to an onsite day. */
export function TimeEffect() {
  const f = useTimeForm();
  const d = f.draft;
  if (!f.server) return null;
  const h = d.onsiteHours ?? { start: '08:00', end: '17:00' };
  return (
    <div className="grid gap-3 p-4 text-body" data-testid="time-effect">
      <h3 className="text-body-lg font-bold text-fg-heading">On an onsite day</h3>
      {d.detectOnsite === false ? (
        <p className="text-muted">Nothing is detected. Days you mark on Activity or History (a day chip, or Mark trip) still log onsite hours.</p>
      ) : (
        <ul className="grid gap-1.5 text-fg">
          <li>
            Onsite {h.start}–{h.end} in the trip&rsquo;s time zone, customer-facing, on the trip&rsquo;s one account and opp.
          </li>
          <li>
            {d.overlaps === 'count_once'
              ? 'Your sessions keep their own rows; the onsite frame fills only the gaps (counted once).'
              : 'The whole day logs as onsite, and your meetings during it log as their own rows too.'}
          </li>
          <li>Each flight: {d.airportBufferMin ?? 60} min before and after counts as Travel.</li>
          <li>Customer dinners: {d.dinnersCustomerFacing === false ? 'not counted' : 'customer-facing'}.</li>
        </ul>
      )}
    </div>
  );
}
