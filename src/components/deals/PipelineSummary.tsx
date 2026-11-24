'use client';
/**
 * Deals ▸ the summary row and the pipeline by fiscal quarter (the owner's ask: "a summary of deals and how much pipe
 * is in each quarter"). Both read `DealsPayload.pipeline` (src/server/deals/pipeline.ts); every number is a link to
 * the deal list it counts (`/deals?pipe=…`, the same filter: src/lib/pipeline-filter.ts).
 *
 *   tiles   open pipeline · this quarter's commit and best case (or late and mid stage) · won this quarter ·
 *           closing in 30 days · needs attention. Slim, neutral; the active filter's tile is selected (blue), and
 *           needs attention carries the one state colour (red past close, amber no next step) with an icon.
 *   chart   one stacked column per quarter: last quarter's wins, this quarter and the next 3. Segments are state
 *           colours by how sure a deal is (context.css --pipe-tier-*), a recessive grid, the total on each cap, a
 *           tooltip per column (amount and count per segment, the full value), a click lists the hovered segment's
 *           deals. Chart / Table toggle (the table's cells are links too); the chart can be hidden (kept per browser).
 */
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, Rectangle, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { DealsPipeline, PipelineCategory } from '@/contract';
import { pipeHref, samePipe, type PipeFilter } from '@/lib/pipeline-filter';
import { AppLink } from '@/components/shell/AppLink';
import { navigate } from '@/components/shell/router';
import { cn, Icon, IconButton, SegmentedToggle } from '@/ui';
import { fmtAmount } from './format';
import { chartData, chartLabel, dealNoun, fmtAmountFull, niceMax, scopeLine, segmentLabel, type ChartDatum } from './pipeline-words';

const MUTED = 'var(--color-muted)';
const INK = 'var(--color-fg)';
const GRID = 'var(--color-line)';
const tierColor = (tier: number) => `var(--pipe-tier-${tier})`;

// ── Tiles ──────────────────────────────────────────────────────────────────────────────────

/**
 * Wide: label, value, a sub line. Narrow (#cc-main under 1000 px, e.g. with the right panel open): one row of short
 * labels and values without the sub line, so the panes below keep their height.
 */
const NARROW_HIDE = '@max-[1000px]/main:hidden';
const NARROW_ONLY = 'hidden @max-[1000px]/main:inline';

function Label({ full, short }: { full: string; short: string }) {
  return (
    <>
      <span className={cn('truncate', NARROW_HIDE)}>{full}</span>
      <span className={cn('truncate', NARROW_ONLY)}>{short}</span>
    </>
  );
}

const TILE = 'flex min-w-0 flex-col px-4 py-2 outline-none focus-visible:shadow-focus @max-[1000px]/main:px-2.5 @max-[1000px]/main:py-1.5';
const VALUE = 'truncate text-title font-bold text-fg-heading tabular-nums @max-[1000px]/main:text-body-lg';
const SUB = cn('truncate text-caption text-muted', NARROW_HIDE);

function Tile({ label, short, href, active, value, sub, icon, testId, aria }: { label: string; short: string; href: string; active: boolean; value: ReactNode; sub: ReactNode; icon?: ReactNode; testId: string; aria: string }) {
  return (
    <AppLink
      href={href}
      data-testid={testId}
      aria-current={active ? 'true' : undefined}
      // named by what it shows (label, value, count: WCAG 2.5.3); the full sentence is the tooltip
      title={aria}
      className={cn(TILE, 'flex-1 basis-0 rounded-lg border', active ? 'border-accent bg-selected' : 'border-line bg-surface hover:bg-surface-muted')}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
        {icon}
        <Label full={label} short={short} />
      </span>
      <span className={VALUE}>{value}</span>
      <span className={SUB}>{sub}</span>
    </AppLink>
  );
}

export function DealsSummaryTiles({ p, filter }: { p: DealsPipeline; filter: PipeFilter | null }) {
  const s = p.summary;
  const q = s.thisQuarter;
  const [first, second] = q.segments;
  const is = (f: PipeFilter) => samePipe(filter, f);
  const att = s.attention;
  const attTone = att.pastClose ? 'danger' : att.noNextStep ? 'warning' : null;
  const attWords = [att.pastClose ? `${att.pastClose} past close` : null, att.noNextStep ? `${att.noNextStep} no next step` : null].filter(Boolean).join(' · ');
  const qf = (cat: PipelineCategory): PipeFilter => ({ scope: 'quarter', quarter: q.label, cat });
  const qShort = q.label.split(' ')[0] ?? q.label; // "Q4"
  const sum = (amount: number, count: number) => `${fmtAmount(amount)}, ${dealNoun(p, count)}`;
  return (
    <section aria-label="Deals summary" data-guide="deals-summary" data-pipe="" className="flex shrink-0 gap-3 @max-[1000px]/main:gap-1.5">
      <Tile testId="pipe-tile-open" label="Open pipeline" short="Open" aria={`Open pipeline: ${sum(s.open.amount, s.open.count)}`} href={pipeHref({ scope: 'open' })} active={is({ scope: 'open' })} value={fmtAmount(s.open.amount)} sub={dealNoun(p, s.open.count)} />
      {first && second ? (
        // this quarter's two surest segments: commit and best case (late and mid stage when grouped by stage)
        <div role="group" aria-label={`${q.label} ${p.categoryBasis === 'stage' ? 'by stage' : 'forecast'}`} className="flex min-w-0 flex-[2] basis-0 rounded-lg border border-line bg-surface" data-testid="pipe-tile-quarter">
          {[first, second].map((seg, i) => {
            const f = qf(seg.key);
            const name = segmentLabel(p, seg.key);
            const words = `${q.label} ${name}: ${sum(seg.amount, seg.count)}`;
            return (
              <AppLink
                key={seg.key}
                href={pipeHref(f)}
                aria-current={is(f) ? 'true' : undefined}
                title={words}
                className={cn(TILE, 'flex-1 basis-0', i === 0 ? 'rounded-l-lg' : 'rounded-r-lg border-l border-line', is(f) ? 'bg-selected shadow-[inset_0_0_0_1px_var(--color-accent)]' : 'hover:bg-surface-muted')}
              >
                <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted">
                  <span aria-hidden className={cn('size-2.5 shrink-0 rounded-sm', NARROW_HIDE)} style={{ background: tierColor(p.segments.find((x) => x.key === seg.key)?.tier ?? 3) }} />
                  <Label full={`${qShort} ${name.toLowerCase()}`} short={name} />
                </span>
                <span className={VALUE}>{fmtAmount(seg.amount)}</span>
                <span className={SUB}>{dealNoun(p, seg.count)}</span>
              </AppLink>
            );
          })}
        </div>
      ) : null}
      <Tile testId="pipe-tile-won" label={`Won in ${qShort}`} short="Won" aria={`Won in ${q.label}: ${sum(s.wonThisQuarter.amount, s.wonThisQuarter.count)}`} href={pipeHref(qf('won'))} active={is(qf('won'))} value={fmtAmount(s.wonThisQuarter.amount)} sub={dealNoun(p, s.wonThisQuarter.count)} />
      <Tile testId="pipe-tile-soon" label={`Closing in ${s.closingSoon.days} days`} short={`Next ${s.closingSoon.days}d`} aria={`Closing in the next ${s.closingSoon.days} days: ${dealNoun(p, s.closingSoon.count)}, ${fmtAmount(s.closingSoon.amount)}`} href={pipeHref({ scope: 'soon' })} active={is({ scope: 'soon' })} value={dealNoun(p, s.closingSoon.count)} sub={fmtAmount(s.closingSoon.amount)} />
      <Tile
        testId="pipe-tile-attention"
        label="Needs attention"
        short="Attention"
        aria={`Needs attention: ${dealNoun(p, att.count)}${attWords ? ` (${attWords})` : ''}`}
        href={pipeHref({ scope: 'attention' })}
        active={is({ scope: 'attention' })}
        icon={attTone ? <Icon name={attTone === 'danger' ? 'error' : 'warning'} size="xs" className={cn('shrink-0', attTone === 'danger' ? 'text-danger-700' : 'text-warning-700')} /> : null}
        value={dealNoun(p, att.count)}
        sub={attWords ? <span className={attTone === 'danger' ? 'text-danger-700' : 'text-warning-700'}>{attWords}</span> : p.nextStepRead ? 'None past close, all with a next step' : 'None past close'}
      />
    </section>
  );
}

// ── Chart ──────────────────────────────────────────────────────────────────────────────────

type Hover = { quarter: string; key: PipelineCategory } | null;

function Legend({ p }: { p: DealsPipeline }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-muted @max-[1000px]/main:gap-x-2" aria-label="Segments">
      {p.segments.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span aria-hidden className="size-2.5 rounded-sm" style={{ background: tierColor(s.tier) }} />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

function ChartTip({ active, payload, p, hover }: { active?: boolean; payload?: Array<{ payload: ChartDatum }>; p: DealsPipeline; hover: Hover }) {
  const d = payload?.[0]?.payload;
  if (!active || !d) return null;
  const segs = [...p.segments].reverse().filter((s) => (d.counts[s.key] ?? 0) > 0 && (d.role !== 'previous' || s.key === 'won'));
  return (
    <div className="min-w-48 rounded-md bg-surface-inverse px-3 py-2 text-caption text-on-inverse shadow-md">
      <div className="font-bold">
        {d.label}
        {d.role === 'previous' ? ' · won' : d.role === 'current' ? ' · this quarter' : ''}
      </div>
      <div className="tabular-nums">
        <span className="font-bold">{fmtAmountFull(d.total)}</span> · {dealNoun(p, d.count)}
      </div>
      {segs.length ? (
        <ul className="mt-1 space-y-0.5">
          {segs.map((s) => (
            <li key={s.key} className={cn('flex items-center gap-2 tabular-nums', hover?.quarter === d.label && hover.key === s.key && 'font-bold')}>
              <span aria-hidden className="h-0.5 w-3 rounded-full" style={{ background: tierColor(s.tier) }} />
              <span>{fmtAmountFull(d.amounts[s.key] ?? 0)}</span>
              <span className="opacity-80">
                {s.label} · {d.counts[s.key]}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="opacity-80">No deals</div>
      )}
      {d.count ? <div className="mt-1 opacity-80">Click to list them</div> : null}
    </div>
  );
}

/** The hovered segment and the list's filter, for the segments (a context, so each segment's shape stays one stable function). */
const ChartState = createContext<{ hover: Hover; filter: PipeFilter | null }>({ hover: null, filter: null });

type SegmentProps = { x?: number; y?: number; width?: number; height?: number; fill?: string; payload?: ChartDatum };

/**
 * A stacked segment: a 2 px surface gap above every segment but the top one, whose end is rounded. The hovered one
 * lifts; while a quarter filter lists deals below, the segments outside it recede.
 */
function SegmentRect({ segKey, x = 0, y = 0, width = 0, height = 0, fill, payload }: SegmentProps & { segKey: PipelineCategory }) {
  const { hover, filter } = useContext(ChartState);
  if (!height || height <= 0 || !payload) return <g />;
  const top = payload.top === segKey;
  const h = top ? height : Math.max(0, height - 2);
  const lifted = hover?.quarter === payload.label && hover.key === segKey;
  const outside = filter?.scope === 'quarter' && !(filter.quarter === payload.label && (filter.cat === null || filter.cat === segKey));
  return <Rectangle x={x} y={top ? y : y + 2} width={width} height={h} radius={top ? [4, 4, 0, 0] : 0} fill={fill} fillOpacity={outside ? 0.35 : lifted ? 0.8 : 1} style={{ cursor: 'pointer' }} />;
}

/** One shape function per segment, made once: a new function on every render remounts every segment on each hover. */
const SHAPES = new Map<PipelineCategory, (props: SegmentProps) => ReactNode>();
function segmentShape(key: PipelineCategory) {
  let f = SHAPES.get(key);
  if (!f) {
    f = function Segment(props: SegmentProps) {
      return <SegmentRect segKey={key} {...props} />;
    };
    SHAPES.set(key, f);
  }
  return f;
}

function TotalLabel(props: { x?: number | string; y?: number | string; width?: number | string; index?: number; data: ChartDatum[] }) {
  const d = props.index !== undefined ? props.data[props.index] : undefined;
  if (!d || !d.total) return null;
  const x = Number(props.x ?? 0) + Number(props.width ?? 0) / 2;
  return (
    <text x={x} y={Number(props.y ?? 0) - 6} textAnchor="middle" fill={INK} fontSize={12} className="tabular-nums">
      {fmtAmount(d.total)}
    </text>
  );
}

function QuarterTick(props: { x?: number; y?: number; payload?: { value: string }; data: ChartDatum[]; current: string }) {
  const label = props.payload?.value ?? '';
  const d = props.data.find((x) => x.label === label);
  return (
    <g transform={`translate(${props.x ?? 0},${props.y ?? 0})`}>
      <text dy={14} textAnchor="middle" fill={label === props.current ? INK : MUTED} fontSize={12} fontWeight={label === props.current ? 700 : 400}>
        {label}
      </text>
      <text dy={29} textAnchor="middle" fill={MUTED} fontSize={11}>
        {d?.role === 'previous' ? 'won' : d?.role === 'current' ? 'this quarter' : ''}
      </text>
    </g>
  );
}

function PipeChart({ p, filter }: { p: DealsPipeline; filter: PipeFilter | null }) {
  const data = chartData(p);
  const [hover, setHover] = useState<Hover>(null);
  const top = p.segments[p.segments.length - 1]!.key;
  const max = niceMax(Math.max(0, ...data.map((d) => d.total)) * 1.08);
  const open = (quarter: string, cat: PipelineCategory | null) => navigate(pipeHref({ scope: 'quarter', quarter, cat }));
  return (
    <ChartState.Provider value={{ hover, filter }}>
      <div className="h-40 @max-[1000px]/main:h-28" role="img" aria-label={chartLabel(p)} data-testid="pipe-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 20, right: 8, left: 0, bottom: 0 }}
            barCategoryGap="30%"
            // On release, not click: recharts re-renders a pressed segment, so the browser drops the click on the SVG path.
            // The hovered segment lists its deals; anywhere else in a quarter's band lists the whole quarter.
            onMouseUp={(st) => {
              const i = Number(st?.activeIndex ?? NaN);
              const d = Number.isInteger(i) ? data[i] : st?.activeLabel ? data.find((x) => x.label === String(st.activeLabel)) : undefined;
              if (!d || !d.count) return;
              open(d.label, hover?.quarter === d.label ? hover.key : d.role === 'previous' ? 'won' : null);
            }}
            style={{ cursor: 'pointer' }}
          >
            <CartesianGrid vertical={false} stroke={GRID} />
            <XAxis dataKey="label" tickLine={false} axisLine={{ stroke: GRID }} height={38} interval={0} tick={<QuarterTick data={data} current={p.currentQuarter} />} />
            <YAxis width={52} domain={[0, max]} ticks={[0, max / 2, max]} tickLine={false} axisLine={false} tick={{ fill: MUTED, fontSize: 12 }} tickFormatter={(v: number) => (v ? fmtAmount(v) : '$0')} />
            <RTooltip cursor={{ fill: 'var(--color-surface-muted)' }} content={<ChartTip p={p} hover={hover} />} isAnimationActive={false} />
            {p.segments.map((s) => (
              <Bar
                key={s.key}
                dataKey={s.key}
                name={s.label}
                stackId="pipe"
                fill={tierColor(s.tier)}
                maxBarSize={24}
                isAnimationActive={false}
                activeBar={false}
                shape={segmentShape(s.key)}
                onMouseEnter={(d) => setHover({ quarter: String((d.payload as ChartDatum | undefined)?.label ?? ''), key: s.key })}
                onMouseLeave={() => setHover(null)}
              >
                {s.key === top ? <LabelList dataKey="total" content={<TotalLabel data={data} />} /> : null}
              </Bar>
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </ChartState.Provider>
  );
}

function PipeTable({ p }: { p: DealsPipeline }) {
  const cell = (quarter: string, cat: PipelineCategory | null, amount: number, count: number, strong?: boolean) =>
    count ? (
      <AppLink href={pipeHref({ scope: 'quarter', quarter, cat })} className={cn('rounded-sm text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus', strong && 'font-bold')}>
        {fmtAmount(amount)} <span className="text-muted">· {count}</span>
      </AppLink>
    ) : (
      <span className="text-faint">{amount ? fmtAmount(amount) : '—'}</span>
    );
  return (
    <div className="mt-2 overflow-x-auto" data-testid="pipe-table">
      <table className="w-full text-body tabular-nums">
        <caption className="sr-only">Pipeline by fiscal quarter: amount and number of deals per segment</caption>
        <thead>
          <tr className="border-b border-line text-left text-caption text-muted">
            <th scope="col" className="py-1 pr-3 font-bold">
              Quarter
            </th>
            {p.segments.map((s) => (
              <th key={s.key} scope="col" className="py-1 pr-3 text-right font-bold">
                {s.label}
              </th>
            ))}
            <th scope="col" className="py-1 text-right font-bold">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {p.quarters.map((q) => (
            <tr key={q.label} className="border-b border-line last:border-b-0">
              <th scope="row" className={cn('py-1 pr-3 text-left font-normal', q.role === 'current' ? 'font-bold text-fg-heading' : 'text-fg')}>
                {q.label}
                <span className="text-caption text-muted">{q.role === 'previous' ? ' · won' : q.role === 'current' ? ' · this quarter' : ''}</span>
              </th>
              {q.segments.map((s) => (
                <td key={s.key} className="py-1 pr-3 text-right">
                  {q.role === 'previous' && s.key !== 'won' ? <span className="text-faint">—</span> : cell(q.label, s.key, s.amount, s.count)}
                </td>
              ))}
              <td className="py-1 text-right">{cell(q.label, q.role === 'previous' ? 'won' : null, q.total.amount, q.total.count, true)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const HIDE_KEY = 'cc.deals.pipelineChart';

/** Hidden or shown, kept per browser (a calm page for those who don't want the chart every morning). */
function useChartHidden(): [boolean, (v: boolean) => void] {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    try {
      setHidden(window.localStorage.getItem(HIDE_KEY) === 'hidden');
    } catch {
      /* storage unavailable: shown */
    }
  }, []);
  const set = (v: boolean) => {
    setHidden(v);
    try {
      window.localStorage.setItem(HIDE_KEY, v ? 'hidden' : 'shown');
    } catch {
      /* storage unavailable: this visit only */
    }
  };
  return [hidden, set];
}

export function PipelineByQuarter({ p, filter }: { p: DealsPipeline; filter: PipeFilter | null }) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [hidden, setHidden] = useChartHidden();
  const any = p.quarters.some((q) => q.total.count > 0);
  const foot = [scopeLine(p), ...p.notes].join(' · ');
  return (
    <section aria-label="Pipeline by quarter" data-guide="deals-pipeline" data-pipe="" className="shrink-0 rounded-lg border border-line bg-surface px-4 pt-2.5 pb-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1 @max-[1000px]/main:gap-x-2">
        <h2 className="flex shrink-0 text-body font-bold text-fg-heading">
          <Label full="Pipeline by fiscal quarter" short="Pipeline by quarter" />
        </h2>
        {!hidden && any ? <Legend p={p} /> : null}
        <div className="ml-auto flex items-center gap-1">
          {!hidden && any ? (
            <SegmentedToggle
              size="xs"
              label="Pipeline view"
              value={view}
              onChange={setView}
              options={[
                { value: 'chart', label: 'Chart' },
                { value: 'table', label: 'Table' },
              ]}
            />
          ) : null}
          <IconButton icon={hidden ? 'chevrondown' : 'chevronup'} size="sm" variant="ghost" label={hidden ? 'Show the pipeline chart' : 'Hide the pipeline chart'} onClick={() => setHidden(!hidden)} />
        </div>
      </div>
      {hidden ? null : !any ? (
        <p className="py-2 text-body text-muted">{p.basis === 'specialist_forecast' ? 'No open Specialist Forecasts of yours in these quarters yet.' : 'No open opps of yours in these quarters yet. Opps show here once Org62 shows you on the team or holding a DC.'}</p>
      ) : view === 'chart' ? (
        <PipeChart p={p} filter={filter} />
      ) : (
        <PipeTable p={p} />
      )}
      {/* whose deals, which amount, and every gap the numbers carry (one line when narrow; the title has it all) */}
      <p className="mt-0.5 line-clamp-2 text-caption text-muted @max-[1000px]/main:line-clamp-1" title={foot}>
        {foot}
      </p>
    </section>
  );
}
