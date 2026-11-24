/**
 * Home ▸ Log & fix rows that belong to a persona's duties (D-55): the AE's forecast notes due, deal roles to set and
 * missing Specialist Forecasts, from the same rules Time ▸ Forecast shows (src/engines/forecast). Rows need the
 * `specialistForecast` feature active (preset or activated by the user); build.ts filters each by its gap rule id
 * (`gapRuleOn`), so an SE who activates the feature gets them too. The SE rules stay in build.ts gapRules.
 * Pure: the same input gives the same rows.
 *
 *   forecast_notes  "3 forecast notes due Mon" (overdue once the deadline passed with notes still stale)
 *   deal_role       "2 deal roles to set"
 *   missing_sfr     "1 opp with no Specialist Forecast"
 *   vdp_open        "3 VDPs need you" (D-59: the same summary Time ▸ VDP's head reads, src/engines/vdp/status.ts)
 */
import type { HomeRow } from '@/contract';
import { buildForecastView } from '@/engines/forecast/view';
import type { GapRuleId } from '@/personas';
import { featureActive } from '@/personas';
import { clip, plural, shortAccount } from './text';
import { daysBetween, toMs, wd } from './time';
import type { HomeInput } from './types';

export interface PersonaGap {
  rule: GapRuleId;
  row: HomeRow;
  /** Items this gap stands for (not listed again elsewhere). */
  consumes: string[];
  /** What the row stands for: a Not needed row comes back when a new one appears (build.ts withResolve). */
  subjects?: string[];
}

const HREF = '/activity?view=forecast';
const usd = (n: number) => (n >= 1_000_000 ? `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `$${Math.round(n / 1000)}k` : `$${Math.round(n)}`);

function row(r: Omit<HomeRow, 'item' | 'progress' | 'heat' | 'dateLabel' | 'resolve'>): HomeRow {
  return { item: null, progress: null, heat: null, dateLabel: null, resolve: null, ...r };
}

/** "3 VDPs need you": one row for every VDP (and account or opp not in VDP yet) with something open. */
function vdpGap(input: HomeInput): PersonaGap[] {
  const v = input.vdp;
  if (!v || (input.persona && !featureActive(input.persona, 'vdp'))) return [];
  const n = v.summary.needYou + v.summary.notInVdp;
  if (!n) return [];
  const why = [v.summary.appCanFix ? `${v.summary.appCanFix} the app can fix` : null, v.summary.waiting ? `${v.summary.waiting} waiting for VDP` : null, v.summary.done ? `${v.summary.done} done` : null, v.summary.notInVdp && v.summary.needYou ? `${v.summary.notInVdp} not in VDP yet` : null].filter(Boolean).join(' · ');
  const href = '/activity?view=vdp';
  return [
    {
      rule: 'vdp_open',
      consumes: [],
      row: row({
        id: 'gap:vdp_open',
        kind: 'gap',
        title: v.summary.needYou ? `${plural(v.summary.needYou, 'VDP')} need${v.summary.needYou === 1 ? 's' : ''} you` : `${plural(v.summary.notInVdp, 'opp')} not in VDP yet`,
        why: clip(why || 'Open items on your VDPs', 80),
        state: null,
        stateLabel: null,
        due: null,
        youMin: Math.max(3, n * 3),
        verb: { label: v.summary.appCanFix ? 'Review' : 'Open', action: 'open', href, targetId: null },
        href,
        entity: { kind: 'vdp', id: v.first?.key ?? 'vdp', label: v.first?.label ?? 'VDPs' },
      }),
    },
  ];
}

export function personaGaps(input: HomeInput, nowMs: number): PersonaGap[] {
  return [...forecastGaps(input, nowMs), ...vdpGap(input)];
}

function forecastGaps(input: HomeInput, nowMs: number): PersonaGap[] {
  const p = input.persona;
  if (!p || !featureActive(p, 'specialistForecast') || !input.forecast) return [];
  const tz = input.timezone;
  const v = buildForecastView({ now: input.now, timezone: tz, persona: p, mode: input.forecast.mode, records: input.forecast.records, opps: input.opps, accounts: input.accounts, drafts: input.drafts, sync: input.forecast.sync });
  const byId = new Map(v.rows.map((r) => [r.id, r] as const));
  const names = (ids: string[]) => [...new Set(ids.map((id) => byId.get(id)).map((r) => (r ? shortAccount(r.accountName ?? r.opportunityName ?? r.name) : '')).filter(Boolean))].slice(0, 3);
  const out: PersonaGap[] = [];

  if (v.counts.due) {
    const n = v.counts.due;
    const overdue = v.counts.overdue;
    const dueMs = toMs(v.due.at);
    const soon = daysBetween(nowMs, dueMs, tz) <= 1;
    const first = byId.get(v.queue.notes[0]!)!;
    // what is left to do: a note in a canvas (waiting for Apply) or with Slackbot is out of your hands until it lands
    const queued = v.rows.filter((r) => r.rank !== null);
    const staged = queued.filter((r) => r.notes.state === 'staged').length;
    const withBot = queued.filter((r) => r.notes.state === 'handed_off').length;
    const todo = v.queue.notes.filter((id) => !['staged', 'handed_off'].includes(byId.get(id)?.notes.state ?? ''));
    const top = names(todo);
    const drafted = queued.filter((r) => r.notes.state === 'drafted' || r.notes.state === 'approved').length;
    out.push({
      rule: 'forecast_notes',
      consumes: [],
      row: row({
        id: 'gap:forecast_notes',
        kind: 'gap',
        title: `${plural(n, 'forecast note')} due ${wd(dueMs, tz)}`,
        why: clip([top.length ? `Biggest first: ${top.join(', ')}` : null, drafted ? `${drafted} drafted` : null, staged ? `${staged} waiting for Apply` : null, withBot ? `${withBot} with Slackbot` : null].filter(Boolean).join(' · ') || 'Specialist Forecasts with stale notes', 80),
        state: overdue ? 'overdue' : soon ? 'risk' : null,
        stateLabel: overdue ? `${overdue} overdue` : `Due ${v.due.label}`,
        due: v.due.at,
        youMin: Math.max(5, n * 3),
        verb: { label: todo.length ? (drafted ? 'Review notes' : 'Draft notes') : staged ? 'Apply the canvas' : 'Check notes', action: 'open', href: HREF, targetId: null },
        href: HREF,
        entity: { kind: 'specialist_forecast', id: first.id, label: first.opportunityName ?? first.name },
      }),
    });
  }

  if (v.counts.roles) {
    const ids = v.queue.roles;
    const first = byId.get(ids[0]!)!;
    const acv = ids.reduce((s, id) => s + (byId.get(id)?.amount ?? 0), 0);
    out.push({
      rule: 'deal_role',
      consumes: [],
      subjects: ids,
      row: row({
        id: 'gap:deal_role',
        kind: 'gap',
        title: `${plural(ids.length, 'deal role')} to set`,
        why: clip(`Deal Role None on ${usd(acv)} ACV · set to at least Aware`, 80),
        state: null,
        stateLabel: null,
        due: null,
        youMin: Math.max(2, ids.length),
        verb: { label: 'Review', action: 'open', href: HREF, targetId: null },
        href: HREF,
        entity: { kind: 'specialist_forecast', id: first.id, label: first.opportunityName ?? first.name },
      }),
    });
  }

  if (v.counts.missing) {
    const m = v.queue.missing;
    const top = [...new Set(m.map((x) => shortAccount(x.accountName ?? x.opportunityName)))].slice(0, 3);
    out.push({
      rule: 'missing_sfr',
      consumes: [],
      subjects: m.map((x) => x.opportunityId),
      row: row({
        id: 'gap:missing_sfr',
        kind: 'gap',
        title: `${plural(m.length, 'opp')} with no Specialist Forecast`,
        why: clip(`${top.join(', ')} · create it from the opp's Forecast tab`, 80),
        state: null,
        stateLabel: null,
        due: null,
        youMin: m.length * 3,
        verb: { label: 'Open', action: 'open', href: HREF, targetId: null },
        href: HREF,
        entity: { kind: 'opportunity', id: m[0]!.opportunityId, label: m[0]!.opportunityName },
      }),
    });
  }
  return out;
}
