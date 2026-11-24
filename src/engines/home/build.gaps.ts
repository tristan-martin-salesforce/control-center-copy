// Home build: the gap rules (what is missing before a meeting or a deadline). Split from build.ts (max-lines); build.ts re-exports the public names.
import {
  type HomeRow, type WorkItem, HOME_GAP_REASONS, type NeedDecision, type NeedResolve, type PersonaFeature,
} from '@/contract';
import { reauthMin } from './estimate';
import { clip, firstClause, plural, shortAccount } from './text';
import { daysBetween, dur, md, toMs, whenLabel } from './time';
import type { GapRuleId, ResolvedPersona } from '@/personas';
import { loggingProfile } from '@/engines/activity/persona';
import { countsAsLogged } from '@/engines/activity/org62-check';
import { personaGaps } from './persona-gaps';
import { decisionIndex, isSetAside, subjectList } from '@/lib/need-decisions';
import { plainIssue } from '@/lib/time-issues';
import { type Ctx, byRank, row, verb, quarterDays, round1, fmtH, TIME_WEEK, workEntity, itemHref } from './build.ctx';

// ---------------------------------------------------------------------------
// Gap rules (Log & fix)
// ---------------------------------------------------------------------------

export interface Gap {
  rule: GapRuleId;
  row: HomeRow;
  /** Items this gap stands for (not listed again elsewhere, also while the row is set aside). */
  consumes: string[];
  /** What the row stands for (missed opps, deal roles): a Not needed row comes back when a new one appears. */
  subjects?: string[];
  /** Set aside (Not now until a date, or Not needed): not drawn, still consumes its items. */
  hidden?: boolean;
}
/**
 * Every Log & fix row can be set aside, through the one needs-you mechanism (src/contract/needs.ts, rule
 * `home:<gap rule>`, subject = the row id). Rows that are real outstanding work (rows to log, a broken source, notes
 * due, expenses, VDP steps) get Not now only: they come back on the date. A missed-opp claim, a deal role to set or a
 * missing Specialist Forecast can also be Not needed with a reason, until a new subject appears in the row.
 */
const HOME_NOT_NEEDED: ReadonlySet<GapRuleId> = new Set(['missed_dc', 'deal_role', 'missing_sfr']);
function withResolve(g: Gap, decisions: ReadonlyMap<string, NeedDecision>, nowIso: string): Gap {
  const notNeeded = HOME_NOT_NEEDED.has(g.rule);
  const resolve: NeedResolve = { rule: `home:${g.rule}`, subjectIds: [g.row.id], snooze: true, reasons: notNeeded ? [...HOME_GAP_REASONS] : [], baseline: notNeeded ? { subjects: subjectList(g.subjects ?? []) } : {}, label: g.row.title };
  return { ...g, row: { ...g.row, resolve }, hidden: isSetAside(decisions, resolve.rule, g.row.id, nowIso, resolve.baseline) };
}
/**
 * D-55: what a Log & fix rule needs from the persona beyond being preconfigured. A rule outside the preset comes back
 * when the feature it belongs to is activated (an AE who activates deal contributions gets "Request DC").
 */
const GAP_NEEDS: Partial<Record<GapRuleId, (p: ResolvedPersona) => boolean>> = {
  missed_dc: (p) => p.features.dealContributions,
  quarter_log: (p) => p.features.activityLogging && p.logging.hoursTargetH !== null,
  org62_unlogged: (p) => p.features.activityLogging,
  // 2026-11-13 audit C2: DCs and use cases ride on logging canvases
  canvas_waiting: (p) => p.features.activityLogging && (p.features.dealContributions || p.features.vdp),
  needs_input: (p) => p.features.activityLogging,
  vdp_open: (p) => p.features.vdp,
};
const GAP_FEATURE: Partial<Record<GapRuleId, PersonaFeature>> = { missed_dc: 'dealContributions', vdp_open: 'vdp', forecast_notes: 'specialistForecast', deal_role: 'specialistForecast', missing_sfr: 'specialistForecast' };
/** "Solutions Events" (SE), "Sales Events" (AE): the persona's logged record type, plural. */
const loggedEvents = (p: ResolvedPersona | undefined) => {
  const n = loggingProfile(p).recordTypeName;
  return n.endsWith('s') ? n : `${n}s`;
};
/** Whether a Log & fix rule runs for this persona (no persona: every SE rule, as before personas). */
export function gapRuleOn(rule: GapRuleId, p: ResolvedPersona | undefined): boolean {
  if (!p) return true;
  const f = GAP_FEATURE[rule];
  const preconfigured = p.gapRules.includes(rule) || (!!f && p.changedFeatures.includes(f) && p.features[f]);
  return preconfigured && (GAP_NEEDS[rule]?.(p) ?? true);
}
export function gapRules(c: Ctx): Gap[] {
  const { input, tz, nowMs } = c;
  const gaps: Gap[] = [];
  const on = (rule: GapRuleId) => gapRuleOn(rule, input.persona);
  const findItem = (pred: (w: WorkItem) => boolean) => c.live.filter(pred).sort(byRank)[0] ?? null;

  // 1. A connector that needs auth.
  for (const k of on('connector_auth') ? input.connectors.filter((x) => x.state === 'auth_needed' || x.state === 'error') : []) {
    const label = k.reauth?.label ?? `Re-auth ${k.label}`;
    gaps.push({
      rule: 'connector_auth',
      consumes: [],
      row: row({
        id: `gap:connector:${k.id}`,
        kind: 'gap',
        title: label,
        why: clip(firstClause(k.impact) || k.lastError?.message || `${k.label} is not syncing`, 60),
        state: 'overdue',
        stateLabel: k.state === 'auth_needed' ? `Expired ${md(toMs(k.since), tz)}` : 'Broken',
        due: null,
        youMin: reauthMin(),
        verb: verb(k.reauth?.kind === 'instructions' ? 'How to fix' : 'Re-auth', 'reauth', `/health?connector=${k.id}`, k.id),
        href: `/health?connector=${k.id}`,
        entity: { kind: 'connector', id: k.id, label: k.label },
      }),
    });
  }

  // 2. The quarter's activity log vs its target, with its deadline.
  const q = input.quarter;
  const qDue = toMs(q.due);
  // this fiscal quarter's rows only: projections keep logged rows of every quarter (past weeks, History)
  const qb = quarterDays(q.label);
  // TL-45: the one status → count map (Time, the quarter totals and the receipts read the same)
  const logged = input.activity.filter((a) => countsAsLogged(a) && (!qb || (a.date >= qb.start && a.date <= qb.end)));
  const loggedH = round1(q.loggedH + logged.reduce((s, a) => s + a.durationH, 0));
  // Oldest first (start, then end): the row links to the earliest handed-off entry whatever order the DataSource returns.
  // D-64: an internal row the app suggests (proposed) is a quiet suggestion on Time, not a row to confirm here
  const handedOff = input.activity
    .filter((a) => a.status === 'synced_to_canvas' || a.status === 'approved' || (a.status === 'proposed' && !a.internal))
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end));
  const handedOffH = round1(handedOff.reduce((s, a) => s + a.durationH, 0));
  const logItem = findItem((w) => (w.due === q.due && /log/i.test(w.title)) || /activity log/i.test(w.title));
  const confirmItem = findItem((w) => /org62/i.test(w.title) && /(confirm|handed-off|approve)/i.test(w.title));
  const lastLogged = input.activity.filter((a) => a.status === 'logged' || a.status === 'verified').map((a) => a.date).sort().at(-1) ?? null;
  const canvasWord = input.canvasLabel.replace(/^Slackbot /i, '').toLowerCase() || 'canvas';
  const quarterRow = on('quarter_log') && qDue >= c.todayStart && loggedH < q.targetH;
  // The quarter row and the Org62 row would list the same handed-off rows twice: with both on, the quarter row
  // carries the Org62 detail (rows, hours on the canvas, the last day logged) and the Org62 row is not drawn.
  const mergeOrg62 = quarterRow && on('org62_unlogged') && handedOff.length > 0;
  if (quarterRow) {
    const daysLeft = daysBetween(nowMs, qDue, tz);
    const confirmMin = confirmItem ? c.handsOn(confirmItem) : handedOff.length ? 30 : 0;
    const org62Since = lastLogged ? `none in Org62 after ${md(toMs(`${lastLogged}T12:00:00Z`), 'UTC')}` : 'nothing in Org62 yet';
    const lead = logItem ?? (mergeOrg62 ? confirmItem : null);
    gaps.push({
      rule: 'quarter_log',
      consumes: [...new Set([logItem?.id, mergeOrg62 ? confirmItem?.id : undefined].filter((id): id is string => !!id))],
      row: row({
        id: 'gap:quarter_log',
        kind: 'gap',
        title: `${q.label.split(' ')[0]} activity log: ${fmtH(loggedH)} of ${fmtH(q.targetH)} h`,
        why: mergeOrg62
          ? `You ~${dur(Math.max(confirmMin, 30))} to confirm ${plural(handedOff.length, 'handed-off row')} (~${fmtH(handedOffH)} h on the ${canvasWord}) · ${org62Since}`
          : handedOff.length
            ? `You ~${dur(Math.max(confirmMin, 30))} to confirm ${handedOff.length} rows`
            : `${fmtH(round1(q.targetH - loggedH))} h to go`,
        state: daysLeft <= 3 ? 'risk' : null,
        stateLabel: `Due ${whenLabel(qDue, nowMs, tz)}`,
        due: q.due,
        youMin: lead ? c.handsOn(lead) : null,
        verb: verb(handedOff.length ? `Confirm ${handedOff.length}` : 'Open Activity', 'confirm', TIME_WEEK),
        href: TIME_WEEK,
        entity: lead ? workEntity(lead) : { kind: 'activity_entry', id: logged[0]?.id ?? 'quarter', label: `${q.label} log` },
        item: lead ? { id: lead.id, version: lead.version } : null,
        progress: { done: loggedH, total: q.targetH, label: 'h' },
      }),
    });
  }

  // 3. Org62 Solutions Events not logged since a date (folded into the quarter row when that one is drawn).
  if (on('org62_unlogged') && handedOff.length && !mergeOrg62) {
    gaps.push({
      rule: 'org62_unlogged',
      consumes: confirmItem ? [confirmItem.id] : [],
      row: row({
        id: 'gap:org62_unlogged',
        kind: 'gap',
        title: lastLogged ? `Org62 ${loggedEvents(input.persona)}: none after ${md(toMs(`${lastLogged}T12:00:00Z`), 'UTC')}` : `Org62 ${loggedEvents(input.persona)}: nothing logged`,
        why: `${plural(handedOff.length, 'handed-off row')} · ~${fmtH(handedOffH)} h on the ${canvasWord}`,
        state: null,
        stateLabel: null,
        due: null,
        youMin: confirmItem ? c.handsOn(confirmItem) : null,
        verb: verb('Review', 'confirm', TIME_WEEK),
        href: TIME_WEEK,
        entity: confirmItem ? workEntity(confirmItem) : { kind: 'activity_entry', id: handedOff[0]!.id, label: 'Handed-off rows' },
        item: confirmItem ? { id: confirmItem.id, version: confirmItem.version } : null,
      }),
    });
  }

  // 3b. 2026-11-13 audit C2: DC requests and VDP use cases waiting for a logging canvas. They are not rows, so the
  // quarter and Org62 rows never count them; without this row, Log & fix read "Nothing missing" over 55 waiting claims.
  const wait = on('canvas_waiting') ? input.waitingForCanvas : undefined;
  if (wait && (wait.dcs > 0 || wait.useCases > 0)) {
    const what = [wait.dcs ? plural(wait.dcs, 'DC request') : null, wait.useCases ? plural(wait.useCases, 'VDP use case') : null].filter(Boolean).join(' and ');
    gaps.push({
      rule: 'canvas_waiting',
      consumes: [],
      row: row({
        id: 'gap:canvas_waiting',
        kind: 'gap',
        title: `Log ${what}`,
        why: wait.dcs && !wait.useCases ? 'Waiting for your next logging canvas with rows, or Log DCs now on Activity' : 'Waiting for your next logging canvas with rows (Activity ▸ Log it)',
        state: null,
        stateLabel: null,
        due: null,
        youMin: null,
        verb: verb('Open Activity', 'open', TIME_WEEK),
        href: TIME_WEEK,
        entity: { kind: 'activity_entry', id: 'canvas_waiting', label: 'Waiting for a canvas' },
      }),
    });
  }

  // 4. DC gaps. DC-31: exactly the Deals Log & fix rows (getDeals `needs`: open opps with strong evidence and no DC of
  // mine, set-asides applied), so Home and Deals count the same opps. Without them (an older caller), the missed-opp
  // findings with no DC request, as before.
  const dcNeeds = on('missed_dc') ? input.dcNeeds : undefined;
  const gapOpps = (dcNeeds ?? []).flatMap((n) => n.opps.map((g) => ({ n, g })));
  if (dcNeeds && gapOpps.length) {
    const dcItems = c.live.filter((w) => /\brequest (a )?dc\b/i.test(w.title));
    const first = dcNeeds[0]!;
    const top = [...new Set(dcNeeds.map((n) => shortAccount(n.accountName)))].slice(0, 3);
    const href = dcNeeds.length === 1 ? first.verb.href : '/deals';
    gaps.push({
      rule: 'missed_dc',
      consumes: dcItems.map((w) => w.id),
      subjects: gapOpps.map((x) => x.g.oppId),
      row: row({
        id: 'gap:missed_dc',
        kind: 'gap',
        title: gapOpps.length === 1 ? `Claim DC on ${gapOpps[0]!.g.oppName}` : `Claim DC on ${plural(gapOpps.length, 'opp')}`,
        why: dcNeeds.length === 1 ? first.why : `${plural(gapOpps.length, 'opp')} without your DC · ${top.join(', ')}`,
        state: null,
        stateLabel: null,
        due: null,
        youMin: null,
        verb: verb('Review', 'open', href),
        href,
        entity: dcItems[0] ? workEntity(dcItems.sort(byRank)[0]!) : { kind: 'opportunity', id: gapOpps[0]!.g.oppId, label: 'DC gaps' },
      }),
    });
  }
  const missed = on('missed_dc') && !dcNeeds ? input.missedOpps.filter((m) => m.status === 'new') : [];
  if (missed.length) {
    const claims = missed.filter((m) => m.verdict === 'claim').sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));
    const top = [...new Set(claims.map((m) => shortAccount(m.accountName)))].slice(0, 3);
    const dcItems = c.live.filter((w) => /\brequest (a )?dc\b/i.test(w.title));
    gaps.push({
      rule: 'missed_dc',
      consumes: dcItems.map((w) => w.id),
      subjects: missed.map((m) => m.id),
      row: row({
        id: 'gap:missed_dc',
        kind: 'gap',
        title: `Request DC on ${plural(missed.length, 'missed opp')}`,
        why: top.length ? `Top Claim opps: ${top.join(', ')}` : `${plural(missed.length, 'opp')} with no DC request`,
        state: null,
        stateLabel: null,
        due: null,
        youMin: null,
        verb: verb('Review', 'open', '/deals/missed'),
        href: '/deals/missed',
        entity: dcItems[0] ? workEntity(dcItems.sort(byRank)[0]!) : { kind: 'missed_opp', id: (claims[0] ?? missed[0])!.id, label: 'Missed opps' },
      }),
    });
  }

  // 5. Activity rows that need your input.
  // oldest first, the same order on every DataSource; their issues in plain English (never the engine's canvas notes)
  const needs = on('needs_input') ? input.activity.filter((a) => a.status === 'needs_input').sort((a, b) => a.start.localeCompare(b.start) || a.description.localeCompare(b.description)) : [];
  if (needs.length) {
    const it = findItem((w) => /needs-input/i.test(w.title));
    gaps.push({
      rule: 'needs_input',
      consumes: it ? [it.id] : [],
      row: row({
        id: 'gap:needs_input',
        kind: 'gap',
        title: `Resolve ${plural(needs.length, 'needs-input row')}`,
        why: clip(needs.map((a) => (a.issues[0] ? (plainIssue(a.issues[0], a) ?? a.description) : a.description)).filter((v, i, xs) => xs.indexOf(v) === i).join(' · '), 70),
        state: null,
        stateLabel: null,
        due: null,
        youMin: it ? c.handsOn(it) : needs.length * 3,
        verb: verb('Map', 'map', TIME_WEEK),
        href: TIME_WEEK,
        entity: it ? workEntity(it) : { kind: 'activity_entry', id: needs[0]!.id, label: 'Needs-input rows' },
        item: it ? { id: it.id, version: it.version } : null,
      }),
    });
  }

  // 6. Unsubmitted expenses (travel items).
  for (const w of on('expenses') ? c.live.filter((x) => x.kind === 'travel' && /(expense|concur|reimburs)/i.test(`${x.title} ${x.why}`)).sort(byRank) : []) {
    gaps.push({
      rule: 'expenses',
      consumes: [w.id],
      row: row({
        id: `gap:expenses:${w.id}`,
        kind: 'gap',
        title: w.title,
        why: clip(w.why || 'Not submitted yet', 60),
        state: w.due && toMs(w.due) < c.todayStart ? 'overdue' : null,
        stateLabel: w.due && toMs(w.due) < c.todayStart ? 'Overdue' : null,
        due: w.due,
        youMin: c.handsOn(w),
        verb: verb(/concur/i.test(w.title) ? 'Open Concur' : 'Open', 'open', w.sources.find((s) => s.url)?.url ?? itemHref(w.id)),
        href: itemHref(w.id),
        entity: workEntity(w),
        item: { id: w.id, version: w.version },
      }),
    });
  }

  // D-55: the persona's own Log & fix rows (the AE's forecast notes, deal roles, missing Specialist Forecasts)
  gaps.push(...personaGaps(input, nowMs).filter((g) => on(g.rule)));

  // the state first (overdue, blocked, at risk), then the persona's own rule order (an AE's forecast duty before
  // logging, so the rows a capped section hides are the Week ones "See all" opens); rules outside the preset last
  const order: Record<string, number> = { overdue: 0, blocked: 1, risk: 2 };
  const ruleAt = (r: GapRuleId) => {
    const i = input.persona?.gapRules.indexOf(r) ?? -1;
    return i < 0 ? 99 : i;
  };
  const decisions = decisionIndex(input.decisions);
  return gaps.map((g) => withResolve(g, decisions, input.now)).sort((a, b) => (order[a.row.state ?? ''] ?? 9) - (order[b.row.state ?? ''] ?? 9) || ruleAt(a.rule) - ruleAt(b.rule));
}
