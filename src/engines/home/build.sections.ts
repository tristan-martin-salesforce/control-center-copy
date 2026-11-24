// Home build: ribbon, strip, masthead, footer and read-ins. Split from build.ts (max-lines).
import type {
  HomeAheadDay, HomeCapacity, HomeCard, HomeFooter, HomeMasthead, HomeRibbon, HomeRibbonBlock, HomeSection,
  HomeSegment,
} from '@/contract';
import { clip, corePhrase, lowerFirst, plural, shortAccount, shortEvent } from './text';
import {
  addLocalDays, atLocal, dayKey, dayStart, dur, HOUR_MS, hm, md, MIN_MS, toMs, tzShort, wd, whenLabel, zoned,
} from './time';
import {
  type Ctx, type Interval, isBusyEvent, OPEN_BLOCK_MIN, HOME_CAPS, seg, msOrNull, isToday, fmtH,
} from './build.ctx';
import type { Gap } from './build.gaps';
import type { Dated } from './build.rows';
import { accountOfEvent, eventNoun } from './build.cards';

// ---------------------------------------------------------------------------
// Ribbon, strip, masthead, footer
// ---------------------------------------------------------------------------

export function buildRibbon(c: Ctx, cap: { free: Interval[]; youMinToday: number; pullForward: HomeCapacity['pullForward'] }): HomeRibbon {
  const { tz, nowMs } = c;
  const targets = new Set(c.input.initiatives.map((i) => i.targetEventId).filter(Boolean));
  const evs = c.todayEvents.filter((e) => e.attendance !== 'cancelled');
  const firstEv = evs.find((e) => isBusyEvent(e) || e.attendance === 'declined');
  const floorHour = (ms: number) => ms - (((ms - dayStart(ms, tz)) % HOUR_MS) + HOUR_MS) % HOUR_MS;
  let start = floorHour(Math.min(nowMs, firstEv ? toMs(firstEv.start) : nowMs));
  start = Math.max(start, floorHour(c.wStart));
  if (start >= c.wEnd) start = floorHour(c.wStart);
  const lastEnd = Math.max(c.wEnd, ...evs.filter(isBusyEvent).map((e) => toMs(e.end)).filter((e) => e < c.todayEnd));
  const end = lastEnd;
  const blocks: HomeRibbonBlock[] = [];
  for (const e of evs) {
    const s = toMs(e.start);
    const en = toMs(e.end);
    if (en <= start || s >= end) continue;
    if (e.attendance === 'declined') {
      blocks.push({ id: e.id, kind: 'declined', start: e.start, end: e.end, title: 'declined', fullTitle: `${hm(s, tz)} ${e.title} · declined`, itemId: null, eventId: e.id, state: null, note: null, star: false });
      continue;
    }
    const nowIn = !c.plan && s <= nowMs && nowMs < en;
    const prepMissing = !!e.prep && !e.prep.ready && e.isCustomerFacing && en > nowMs;
    const note = nowIn ? e.prep?.label?.replace(/\s*›\s*$/, '') ?? null : prepMissing ? 'prep' : null;
    blocks.push({
      id: e.id,
      kind: 'meeting',
      start: e.start,
      end: e.end,
      title: shortEvent(e.title),
      fullTitle: `${hm(s, tz)} ${e.title} · ${dur((en - s) / MIN_MS)}${e.prep ? ` · prep: ${e.prep.label.replace(/\s*›\s*$/, '')}${e.prep.ready ? ' (ready)' : ''}` : ''}`,
      itemId: e.prep?.workItemId ?? null,
      eventId: e.id,
      state: nowIn ? 'now' : prepMissing ? 'risk' : null,
      note,
      star: targets.has(e.id),
    });
  }
  // Open blocks: free time left after today's hands-on work, in order. The biggest one carries the pull-forward hint.
  let need = cap.youMinToday * MIN_MS;
  const open: Interval[] = [];
  for (const f of cap.free) {
    const take = Math.min(need, f.e - f.s);
    need -= take;
    const s = f.s + take;
    if (f.e - s >= OPEN_BLOCK_MIN * MIN_MS) open.push({ s: Math.ceil(s / (5 * MIN_MS)) * 5 * MIN_MS, e: f.e });
  }
  const biggest = open.reduce<Interval | null>((b, i) => (!b || i.e - i.s >= b.e - b.s ? i : b), null);
  // Only one open block is drawn: the biggest (latest on ties), which suggests the pull-forward work.
  for (const o of biggest ? [biggest] : []) {
    const pf = o === biggest ? cap.pullForward[0] : undefined;
    blocks.push({
      id: `open:${o.s}`,
      kind: 'open',
      start: new Date(o.s).toISOString(),
      end: new Date(o.e).toISOString(),
      title: `${hm(o.s, tz)}–${hm(o.e, tz)} open`,
      fullTitle: `${hm(o.s, tz)}–${hm(o.e, tz)} open${pf ? `. Pull forward if you like: ${pf.title} (~${dur(pf.youMin)})` : ''}`,
      itemId: pf?.itemId ?? null,
      eventId: null,
      state: null,
      note: pf ? `Pull forward: ${clip(corePhrase(pf.title), 40)} ~${dur(pf.youMin)}` : null,
      star: false,
    });
  }
  blocks.sort((a, b) => a.start.localeCompare(b.start));
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString(), now: new Date(nowMs).toISOString(), blocks };
}
export function buildStrip(c: Ctx, dated: Array<{ at: number; label: string; risk: boolean; cf: boolean; meeting: boolean }>): HomeAheadDay[] {
  const { tz, nowMs } = c;
  const days: HomeAheadDay[] = [];
  const keys: string[] = [];
  for (let i = 1; i <= HOME_CAPS.aheadDays; i++) {
    const s = addLocalDays(nowMs, i, tz);
    keys.push(dayKey(s, tz));
    const list = dated.filter((d) => dayKey(d.at, tz) === dayKey(s, tz));
    const weekday = zoned(s, tz).weekday;
    days.push({
      date: dayKey(s, tz),
      count: list.length,
      risk: list.filter((d) => d.risk).length,
      weekend: weekday === 0 || weekday === 6,
      big: false,
      summary: `${wd(s, tz)} ${md(s, tz)}: ${list.length ? list.map((d) => `${clip(d.label, 48)}${d.risk ? ' (at risk)' : ''}`).join(' · ') : 'nothing'}`,
    });
  }
  // The big day: most customer-facing things, then most at risk, then earliest (needs ≥ 2 things).
  let best = -1;
  let bestScore = 0;
  days.forEach((d, i) => {
    const cf = dated.filter((x) => x.cf && x.meeting && dayKey(x.at, tz) === d.date).length;
    const score = cf * 100 + d.risk * 10 + d.count;
    if (d.count >= 2 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  if (best >= 0) days[best]!.big = true;
  return days;
}
export function buildMasthead(c: Ctx, cards: HomeCard[], gaps: Gap[], ahead: Dated[], strip: HomeAheadDay[]): HomeMasthead {
  const { tz, nowMs, input } = c;
  const targets = new Set(input.initiatives.map((i) => i.targetEventId).filter(Boolean));
  // The focal meeting: today's remaining meeting that matters most.
  const scored = c.todayEvents
    .filter((e) => isBusyEvent(e) && toMs(e.end) > nowMs)
    .map((e) => ({ e, score: (e.isCustomerFacing ? 2 : 0) + (targets.has(e.id) ? 2 : 0) + (e.prep ? 1 : 0) }))
    .filter((x) => x.score >= 2)
    .sort((a, b) => b.score - a.score || a.e.start.localeCompare(b.e.start));
  const focal = scored[0]?.e ?? null;
  const focalAcc = focal ? accountOfEvent(c, focal) : '';

  const dayWord = c.plan ? c.plan.label : 'Today';
  const sentence: HomeSegment[] = [];
  if (focal) {
    sentence.push(seg(`${dayWord} turns on the `), seg(hm(toMs(focal.start), tz), true), seg(' '));
    if (focalAcc) sentence.push(seg(focalAcc, true), seg(' '));
    sentence.push(seg(`${eventNoun(focal.title)}`));
  } else sentence.push(seg(dayWord));

  const clauses: HomeSegment[][] = [];
  let carriedN = 0;
  for (const card of cards) {
    if (card.kind === 'outbox') {
      // MIN-20: the card lists three drafts; the sentence counts every ready one, as the card's title does.
      clauses.push([seg(`approve ${plural(c.readyDrafts.length || card.drafts.length || 1, 'draft')}`)]);
      continue;
    }
    const w = card.now!.item;
    let phrase = lowerFirst(corePhrase(w.title));
    if (focalAcc) phrase = phrase.replace(new RegExp(`\\b${focalAcc.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+`, 'i'), '');
    const acc = shortAccount(w.refs.account?.label);
    const parts: HomeSegment[] = [];
    const idx = acc && acc !== focalAcc ? phrase.indexOf(acc) : -1;
    if (idx >= 0) parts.push(seg(phrase.slice(0, idx)), seg(acc, true), seg(phrase.slice(idx + acc.length)));
    else parts.push(seg(phrase));
    const sb = msOrNull(w.startBy);
    const due = msOrNull(w.due);
    // A meeting is the real deadline of prep work, so its start-by is what matters; otherwise the due time.
    const by = w.servesEventId && sb !== null && isToday(sb, c) && sb > nowMs ? sb : due !== null && isToday(due, c) ? due : null;
    // carried-over work is said once, after the list ("…, all carried over from today.")
    if (card.carried === 'from_today') carriedN++;
    else if (by !== null) parts.push(seg(' by '), seg(hm(by, tz), true, card.state === 'overdue' ? 'overdue' : null));
    // MIN-21: a past due date is overdue, never "by" (it read like a deadline still ahead).
    else if (due !== null && due < nowMs) parts.push(seg(', overdue since '), seg(whenLabel(due, nowMs, tz), true, 'overdue'));
    else if (due !== null) parts.push(seg(` by ${whenLabel(due, nowMs, tz)}`));
    clauses.push(parts);
  }
  const dayLower = c.plan ? (c.plan.label === 'Tomorrow' ? 'tomorrow' : c.plan.label) : 'today';
  if (!clauses.length && !focal && c.plan) sentence.splice(0, sentence.length, seg(`Nothing is lined up for ${dayLower} yet. `), seg('Think ahead', true), seg(' shows what is coming.'));
  else if (!clauses.length && !focal) sentence.splice(0, sentence.length, seg('Nothing needs you right now. '), seg('Think ahead', true), seg(' is a good use of the day.'));
  else if (!clauses.length) sentence.push(seg(c.plan ? ', and nothing else is lined up yet.' : ', and nothing else needs you today.'));
  else {
    sentence.push(seg(focal ? ': ' : ': '));
    clauses.forEach((cl, i) => {
      if (i > 0) sentence.push(seg(i === clauses.length - 1 ? (clauses.length > 2 ? ', and ' : ' and ') : ', '));
      sentence.push(...cl);
    });
    if (carriedN && carriedN === clauses.length) sentence.push(seg(clauses.length > 1 ? ', all carried over from today.' : ', carried over from today.'));
    else sentence.push(seg(carriedN ? `. ${carriedN === 1 ? 'One is' : `${carriedN} are`} carried over from today.` : '.'));
  }

  // Ahead: tomorrow, then the next big day.
  const aheadSegs: HomeSegment[] = [];
  const tomorrow = addLocalDays(nowMs, 1, tz);
  const tKey = dayKey(tomorrow, tz);
  const tGaps = gaps.filter((g) => g.row.due && dayKey(toMs(g.row.due), tz) === tKey);
  const tAhead = ahead.filter((a) => dayKey(a.at, tz) === tKey && (a.row.state === 'risk' || a.cf));
  const tParts: string[] = [];
  for (const g of tGaps.slice(0, 1)) {
    const p = g.row.progress;
    const name = g.rule === 'quarter_log' ? `${input.quarter.label.split(' ')[0]} log` : g.row.title;
    tParts.push(`${name} due ${hm(toMs(g.row.due!), tz)}${p ? `, ${fmtH(p.done)} of ${fmtH(p.total)} ${p.label ?? ''} in`.trimEnd() : ''}`);
  }
  for (const a of tAhead.slice(0, tParts.length ? 0 : 2)) tParts.push(`${a.row.kind === 'event' ? shortEvent(a.row.title) : clip(corePhrase(a.row.title), 40)}${a.row.kind === 'event' ? ` at ${hm(a.at, tz)}` : ''}`);
  // Planning, "tomorrow" is the day after the planned one: name it by its date so it never reads as the planned day.
  const tLabel = c.plan ? `${wd(tomorrow, tz)} ${md(tomorrow, tz)}:` : zoned(tomorrow, tz).weekday === 6 ? 'Saturday:' : 'Tomorrow:';
  if (tParts.length) aheadSegs.push(seg(tLabel, true), seg(` ${tParts.join('; ').replace(/…$/, '')}.`));
  const big = strip.find((d) => d.big && d.date !== tKey);
  if (big) {
    const bigMs = atLocal(Number(big.date.slice(0, 4)), Number(big.date.slice(5, 7)), Number(big.date.slice(8, 10)), 12, 0, tz);
    const evs = ahead.filter((a) => a.row.kind === 'event' && a.cf && dayKey(a.at, tz) === big.date).slice(0, 2);
    const list = evs.length ? evs : ahead.filter((a) => dayKey(a.at, tz) === big.date).slice(0, 2);
    if (list.length) {
      if (aheadSegs.length) aheadSegs.push(seg(' '));
      aheadSegs.push(seg(`${wd(bigMs, tz)} ${md(bigMs, tz)}:`, true), seg(' '));
      // "the Initech QBR and the Initech workshop": account + meeting noun reads best; else a short title.
      const names = list.map((a) => {
        if (a.row.kind !== 'event') return clip(corePhrase(a.row.title), 36);
        const ev = a.row.id.startsWith('event:') ? c.eventById.get(a.row.id.slice(6)) : undefined;
        const acc = ev ? accountOfEvent(c, ev) : '';
        return acc ? `${acc} ${eventNoun(a.row.title)}` : shortEvent(a.row.title);
      });
      names.forEach((n, i) => {
        if (i > 0) aheadSegs.push(seg(i === names.length - 1 ? ' and the ' : ', the '));
        const acc = input.accounts.map((x) => shortAccount(x.name)).find((a) => a && n.startsWith(a));
        if (acc) aheadSegs.push(seg(acc, true), seg(n.slice(acc.length)));
        else aheadSegs.push(seg(n));
      });
      const needPrep = list.filter((a) => a.prepMissing || a.row.state === 'risk').length;
      const last = aheadSegs.at(-1)!;
      last.text = last.text.replace(/…$/, '');
      aheadSegs.push(seg(needPrep === list.length && needPrep > 0 ? (list.length > 1 ? ', both still need prep.' : ', still needs prep.') : '.'));
    }
  }

  return {
    sentence,
    date: new Date(nowMs).toISOString(),
    timezone: tz,
    tzLabel: tzShort(tz, nowMs),
    since: c.plan ? { ...input.since, show: false } : input.since,
    ahead: aheadSegs,
  };
}
export function buildFooter(c: Ctx, chase: { count: number; names: string[] }): HomeFooter {
  const { input } = c;
  const live = input.connectors.filter((k) => k.state === 'ok' || k.state === 'catching_up').length;
  const alerts = input.connectors
    .filter((k) => ['auth_needed', 'error', 'offline', 'degraded'].includes(k.state))
    .map((k) => ({ id: k.id, label: k.state === 'auth_needed' ? `${k.label} needs re-auth` : `${k.label} ${k.state.replace('_', ' ')}`, href: `/health?connector=${k.id}` }));
  const briefs = input.briefs.filter((b) => b.highlights.some((h) => h.status === 'new' && h.relevance === 'high')).length;
  return {
    sources: { live, total: input.connectors.length },
    alerts,
    spend: { usd: input.spend.usd, budgetUsd: input.spend.softBudgetUsd },
    dryRun: input.dryRun,
    briefs: { count: briefs, href: '/briefs' },
    agentRuns: { count: input.agentRuns.filter((r) => r.state === 'done_review').length, href: '/agents?state=done_review' },
    chase: { count: chase.count, names: chase.names.slice(0, 2), href: '/work?tab=all_open&state=waiting_on_others' },
  };
}
/** Read-in state rides on the item it researches (cards and rows); `WorkItemRecord.readInState` from BE-READIN. */
export function attachReadIns(c: Ctx, cards: HomeCard[], sections: HomeSection[]) {
  for (const card of cards) {
    const st = card.kind === 'item' ? c.byId.get(card.id)?.readInState : undefined;
    if (st) card.readInState = st;
  }
  for (const s of sections)
    for (const row of s.rows) {
      const id = row.item?.id ?? (row.entity.kind === 'work_item' ? row.entity.id : null);
      const st = id ? c.byId.get(id)?.readInState : undefined;
      if (st) row.readInState = st;
    }
}
/** "#4 is in Reply & approve, #5 in Log & fix." · "#4 and #5 are in Reply & approve." */
export function elsewhereText(list: Array<{ rank: number; label: string }>): string {
  if (!list.length) return '';
  if (list.length === 2 && list[0]!.label === list[1]!.label) return `#${list[0]!.rank} and #${list[1]!.rank} are in ${list[0]!.label}.`;
  return `${list.map((e, i) => (i === 0 ? `#${e.rank} is in ${e.label}` : `#${e.rank} in ${e.label}`)).join(', ')}.`;
}
