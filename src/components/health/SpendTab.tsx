'use client';
/**
 * Spend: today and 7 days, by scanner and by model, against the soft ($5) and hard ($15) budget.
 * Per the dataviz guidance: one hue for single-series magnitude, thin rounded bars on a baseline, a recessive
 * grid, the budget as labelled reference lines, a hover tooltip per mark, direct value labels only where few,
 * ink-colored text, and a table view for everyone who can't or won't read the chart.
 */
import { useState, type ReactNode } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ReferenceLine, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import type { HealthPayload } from '@/contract';
import { useApi } from '@/client/hooks';
import { cn, EmptyState, PanelError, SegmentedToggle, Skeleton, usePanelState } from '@/ui';
import { usualCost } from '@/llm/spend/first-scan';
import { budgetSegments, topWithOther, usd } from './derive';
import { RaiseCapButton, RaiseHistory } from './RaiseCap';
import { SpendAudit } from './SpendAudit';

const INK = 'var(--color-fg)';
const MUTED = 'var(--color-muted)';
const GRID = 'var(--color-line)';
const BAR = 'var(--color-brand-600)';
const WARN = 'var(--color-warning-600)';
const RISK = 'var(--color-danger-600)';

type Spend = HealthPayload['spend'];

function ChartTip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-md bg-surface-inverse px-2 py-1 text-caption text-on-inverse shadow-md">
      <div className="font-bold">{label}</div>
      <div className="tabular-nums">{usd(payload[0]!.value)}</div>
    </div>
  );
}

function BudgetBar({ today }: { today: Spend['today'] }) {
  const seg = budgetSegments(today);
  const over = today.usd >= today.softBudgetUsd;
  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-heading-lg font-bold tabular-nums text-fg-heading" data-testid="spend-today">
          {usd(today.usd)}
        </span>
        <span className="text-body text-muted">today · {Math.round(today.pct)}% of the {usd(today.softBudgetUsd)} soft budget</span>
      </div>
      <div className="relative mt-3 h-2 rounded-full bg-surface-sunken" role="img" aria-label={`${usd(today.usd)} spent. Soft budget ${usd(today.softBudgetUsd)}, hard cap ${usd(today.hardCapUsd)}.`}>
        <div className="h-full rounded-full" style={{ width: `${seg.usedPct}%`, background: today.usd >= today.hardCapUsd ? RISK : over ? WARN : BAR }} />
        <span className="absolute -top-1 h-4 w-0.5 bg-fg" style={{ left: `${seg.softPct}%` }} />
      </div>
      <div className="relative mt-1 h-4 text-caption text-muted">
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${seg.softPct}%` }}>
          Soft {usd(today.softBudgetUsd)}
        </span>
        <span className="absolute right-0 whitespace-nowrap">Hard cap {usd(today.hardCapUsd)}</span>
      </div>
    </div>
  );
}

function Card({ title, sub, children }: { title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-md border border-line bg-surface px-4 py-3">
      <div className="mb-2 flex items-baseline gap-2">
        <h3 className="text-body font-bold text-fg-heading">{title}</h3>
        {sub ? <span className="text-caption text-muted">{sub}</span> : null}
      </div>
      {children}
    </section>
  );
}

function Hbar({ rows, label }: { rows: Array<{ name: string; usd: number }>; label: string }) {
  const h = Math.max(96, rows.length * 30 + 12);
  return (
    <div style={{ height: h }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 48, top: 0, bottom: 0 }} barCategoryGap={6}>
          <XAxis type="number" hide />
          <YAxis type="category" dataKey="name" width={118} tickLine={false} axisLine={false} tick={{ fill: INK, fontSize: 12 }} />
          <RTooltip cursor={{ fill: 'var(--color-surface-muted)' }} content={<ChartTip />} />
          <Bar dataKey="usd" radius={[0, 4, 4, 0]} barSize={12} fill={BAR} isAnimationActive={false}>
            <LabelList dataKey="usd" position="right" formatter={(v) => usd(Number(v))} style={{ fill: INK, fontSize: 12 }} />
            {rows.map((r) => (
              <Cell key={r.name} fill={BAR} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function SpendTab() {
  const q = useApi('getHealth');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const s = q.data?.spend;
  const state = usePanelState('health.spend', { loading: q.isLoading, error: q.data ? null : q.error, empty: !!s && s.last7d.length === 0 && s.today.usd === 0 });
  if (state === 'error') return <PanelError title="Couldn’t load spend" error={q.error ?? new Error('Forced error state (dev toolbar)')} onRetry={() => void q.refetch()} />;
  if (state === 'loading' || !s) return <Skeleton variant="block" className="m-4 h-64" />;
  if (state === 'empty') return <EmptyState title="No spend yet" body="LLM cost by scanner and model shows here once scans run." />;

  const days = s.last7d.map((d) => ({ name: d.day.slice(5), usd: d.usd }));
  const max = Math.max(0, ...days.map((d) => d.usd));
  const domainMax = Math.max(s.today.softBudgetUsd * 1.15, max * 1.1);
  const scanners = topWithOther(s.byScanner.map((x) => ({ name: x.name, usd: x.usd })));
  const models = topWithOther(s.byModel.map((x) => ({ name: x.model, usd: x.usd })));

  return (
    <div className="cc-scroll min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pb-4 [scrollbar-gutter:stable]" data-health-spend>
      <Card title="Today">
        <BudgetBar today={s.today} />
        {s.background ? (
          <p className="mt-2 text-caption text-muted" data-testid="spend-background">
            Background scanning: {usualCost(s.background.p50, s.background.p90, usd)} a day ({s.background.basis === 'default' ? 'estimated until there are 5 measured days' : 'last 14 days'})
            {s.background.heldUsd > 0 ? ` · ${usd(s.background.heldUsd)} held by runs in progress` : ''}
          </p>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <RaiseCapButton spend={s} variant={s.state === 'ok' ? 'quiet' : 'secondary'} />
          <p className="min-w-0 flex-1 text-caption text-muted">At the soft budget the sidebar turns amber; at the hard cap scans run on rules only (no AI) until tomorrow, unless you raise today’s cap.</p>
        </div>
        <RaiseHistory last7d={s.last7d} className="mt-4" />
      </Card>
      <div className="flex items-center">
        <h3 className="text-body font-bold text-fg-heading">Where it went</h3>
        <SegmentedToggle className="ml-auto" size="xs" label="Spend view" value={view} onChange={setView} options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]} />
      </div>
      {view === 'chart' ? (
        <div className="grid gap-3 @min-[44rem]/pane:grid-cols-2">
          <Card title="Last 7 days" sub="USD per day">
            <div className="h-52" role="img" aria-label={`Daily spend for the last 7 days. Soft budget ${usd(s.today.softBudgetUsd)}.`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={days} margin={{ top: 14, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke={GRID} />
                  <XAxis dataKey="name" tickLine={false} axisLine={{ stroke: GRID }} tick={{ fill: MUTED, fontSize: 12 }} />
                  <YAxis domain={[0, domainMax]} width={40} tickLine={false} axisLine={false} tick={{ fill: MUTED, fontSize: 12 }} tickFormatter={(v) => `$${Math.round(v * 10) / 10}`} />
                  <RTooltip cursor={{ fill: 'var(--color-surface-muted)' }} content={<ChartTip />} />
                  <ReferenceLine y={s.today.softBudgetUsd} stroke={WARN} strokeDasharray="4 3" label={{ value: `Soft ${usd(s.today.softBudgetUsd)}`, position: 'insideTopRight', fill: INK, fontSize: 11 }} />
                  {max >= s.today.softBudgetUsd ? <ReferenceLine y={s.today.hardCapUsd} stroke={RISK} strokeDasharray="4 3" label={{ value: `Hard ${usd(s.today.hardCapUsd)}`, position: 'insideTopRight', fill: INK, fontSize: 11 }} /> : null}
                  <Bar dataKey="usd" radius={[4, 4, 0, 0]} maxBarSize={28} fill={BAR} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </Card>
          <div className="grid gap-3">
            <Card title="By scanner" sub="today">
              {scanners.length ? <Hbar rows={scanners} label="Spend by scanner today" /> : <p className="text-body text-muted">No scanner spend today.</p>}
            </Card>
            <Card title="By model" sub="today">
              {models.length ? <Hbar rows={models} label="Spend by model today" /> : <p className="text-body text-muted">No model spend today.</p>}
            </Card>
          </div>
        </div>
      ) : (
        <div className="grid gap-3 @min-[44rem]/pane:grid-cols-3">
          {[
            ['Last 7 days', days],
            ['By scanner (today)', scanners],
            ['By model (today)', models],
          ].map(([title, rows]) => (
            <Card key={title as string} title={title as string}>
              <table className="w-full text-body">
                <tbody>
                  {(rows as Array<{ name: string; usd: number }>).map((r) => (
                    <tr key={r.name} className="border-b border-line last:border-b-0">
                      <td className="py-1 text-fg">{r.name}</td>
                      <td className={cn('py-1 text-right tabular-nums')}>{usd(r.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ))}
        </div>
      )}
      <SpendAudit />
    </div>
  );
}
