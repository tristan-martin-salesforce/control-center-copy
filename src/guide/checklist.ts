/**
 * Getting started: five outcomes (01 R9, UX.md "Getting started"), each made of the guided path's steps. The card and
 * the page count the outcomes ("2 of 5"); the steps are each outcome's detail, in one ordered list of two kinds:
 *
 *   action    something to do, ticked from real state (never by hand, except "your role looks right", a judgement
 *             only they can make): sources, role, first scan, first draft, first batch, Assistant, feedback
 *   explore   one per main page with a tour for this persona ("Tour Home"), ticked once that tour is done (finished,
 *             skipped, or every step seen: settings.guide.seen)
 *
 * Every item's button plays guidance on its page (CoachMarks): an explore item its whole tour, an action item a tip
 * that points at the element to use (items.ts). Pure: both DataSources gather the inputs and call `guidePayload`.
 * Persona-aware (D-55): an AE's batch is forecast notes, an SE's is the activity log, and a step or page whose
 * feature is inactive is left out (an outcome with none of its required steps is not counted: an AE has four).
 *
 *   Connect your sources       sources · firstScan     (tours: Home, Work, Health)
 *   Pick your role             persona                 (tour: Settings; Report a bug)
 *   Approve your first draft   draft                   (tours: Triage, Outbox, Briefs, Agents; the Assistant)
 *   Log a week                 batch                   (tour: Activity)
 *   Claim a deal contribution  dc                      (tour: Deals)
 *
 * An outcome is done when its required steps are; tours, the Assistant and feedback stay on demand and never hold one.
 */
import type { ChecklistItem, ChecklistItemId, Connector, Draft, FirstScanProgress, GuidePayload, GuideSettings, GuideSignals } from '@/contract';
import { featureActive, type ResolvedPersona } from '@/personas';
import { connectorRowsFor } from '@/personas/surfaces';
import { exploreFor, pageToured } from './pages';

/** Connector states that need the user (Settings ▸ Connectors). */
const BROKEN_STATES = new Set<Connector['state']>(['auth_needed', 'error', 'offline']);

/** Message drafts that reached the user's approval (sent, scheduled, staged as a destination draft, verified). */
const APPROVED = new Set<Draft['status']>(['scheduled', 'sending', 'sent', 'staged', 'verified', 'verify_failed']);
/** Approved, or sent under dry run: a dry-run Send keeps the draft `ready` and records a dry-run attempt. */
const wentOut = (d: Pick<Draft, 'status'> & Partial<Pick<Draft, 'attempts'>>) => APPROVED.has(d.status) || (d.attempts?.length ?? 0) > 0;
/** A canvas staged and waiting for its Apply (rejected or discarded ones don't count). */
const STAGED = new Set<Draft['status']>(['ready', 'scheduled', 'sending', 'failed']);
/** A canvas Applied: it went to Slack (sent, verified, or applied and not verified yet). The batch step ticks on these. */
const APPLIED_CANVAS = new Set<Draft['status']>(['sent', 'staged', 'verified', 'verify_failed']);

/** The "seen" key the Role step's "Looks right" button writes. */
export const PERSONA_REVIEWED_KEY = 'checklist.persona';
/** The "seen" key Done on an item's "Show me" tip writes: that item is done from then on (the Role step's is the same). */
export const itemDoneKey = (id: GuideItemId): string => `checklist.${id}`;

/**
 * The deal-contribution step: not in the contract's ChecklistItemId (the payload's `acknowledged` stays as it is), so
 * its state reaches the client on the item itself. Done when a DC request exists (`dcRequests`, when the DataSource
 * passes it) or Done on its tip / "I've claimed one" recorded `checklist.dc`.
 */
export const DC_STEP = 'dc';
/** An action step's id: the contract's, or the DC step. */
export type GuideItemId = ChecklistItemId | typeof DC_STEP;
/** Items Done on a tip can tick. Not the first scan: it is done when the scan is, never by a click. */
const ACKNOWLEDGEABLE: readonly ChecklistItemId[] = ['sources', 'persona', 'draft', 'batch', 'assistant', 'feedback'];

export interface GuideInputs {
  connectors: readonly (Pick<Connector, 'id' | 'label' | 'state' | 'lastSuccessAt'> & Partial<Pick<Connector, 'source'>>)[];
  drafts: readonly (Pick<Draft, 'status' | 'destination'> & Partial<Pick<Draft, 'attempts'>>)[];
  /** User messages sent to the Assistant (or, without that count, messages in all threads). */
  assistantMessages: number;
  firstScan: Pick<FirstScanProgress, 'status'> | null;
  persona: ResolvedPersona;
  /** The persona section's version (> 1 = saved at least once). */
  personaVersion: number;
  guide: Pick<GuideSettings, 'seen' | 'checklistDismissed'>;
  /** DC requests made in the app (any state): the DC step ticks on one. Optional until both DataSources pass it. */
  dcRequests?: number;
}

const actionOf = (d: Pick<Draft, 'destination'>): string | null => (d.destination.kind === 'action' ? d.destination.action : null);
/** A Specialist Forecast canvas (src/engines/forecast/canvas.ts `FORECAST_CANVAS_KIND`), as opposed to a logging one. */
const isForecastBatch = (d: Pick<Draft, 'destination'>): boolean => (d.destination as { input?: { forecast?: { kind?: unknown } } }).input?.forecast?.kind === 'specialist_forecast';

export function guideSignals(i: GuideInputs): GuideSignals {
  // by connector kind (a live database's rows have uuid ids; the kind is `source`), as Health and Settings filter
  const active = connectorRowsFor(i.connectors, i.persona);
  const broken = active.filter((c) => BROKEN_STATES.has(c.state)).map((c) => c.label);
  const scanned = active.some((c) => c.lastSuccessAt);
  const firstScan: GuideSignals['firstScan'] = i.firstScan ? (i.firstScan.status === 'active' ? 'running' : 'done') : scanned ? 'done' : 'none';
  let draftsApproved = 0;
  let batches = 0;
  let batchesStaged = 0;
  let feedbackSent = 0;
  // the persona's own batch: an AE's first forecast canvas, not a logging canvas (and the other way round)
  const forecastBatch = batchKind(i.persona) === 'forecast';
  for (const d of i.drafts) {
    const a = actionOf(d);
    if (a === null) {
      if (wentOut(d)) draftsApproved++;
    } else if (a === 'feedback.post') {
      // staged is not sent: the report counts once Send ran (live, or a dry-run attempt)
      if (wentOut(d)) feedbackSent++;
    } else if (a.startsWith('slack_canvas.') && isForecastBatch(d) === forecastBatch) {
      // staging is half of it: the step ticks once a canvas was Applied (under dry run, an Apply that rendered it)
      if (APPLIED_CANVAS.has(d.status) || (d.attempts ?? []).some((x) => x.dryRun || x.outcome === 'rendered')) batches++;
      else if (STAGED.has(d.status)) batchesStaged++;
    }
  }
  return {
    sources: { active: active.length, live: active.length - broken.length, broken },
    personaReviewed: i.personaVersion > 1 || Boolean(i.guide.seen[PERSONA_REVIEWED_KEY]),
    firstScan,
    draftsApproved,
    batches,
    batchesStaged,
    assistantMessages: i.assistantMessages,
    feedbackSent,
    acknowledged: ACKNOWLEDGEABLE.filter((id) => Boolean(i.guide.seen[itemDoneKey(id)])),
    toured: exploreFor(i.persona)
      .filter((e) => pageToured(e.page, i.persona, i.guide.seen))
      .map((e) => e.page),
  };
}

/** Which batch the persona stages: forecast notes for an AE with Specialist Forecast, else the activity log. */
export function batchKind(persona: ResolvedPersona): 'forecast' | 'logging' | null {
  const forecast = featureActive(persona, 'specialistForecast');
  const logging = featureActive(persona, 'activityLogging');
  if (!forecast && !logging) return null;
  return forecast && (persona.id === 'ae' || !logging) ? 'forecast' : 'logging';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "Solutions Engineer", "Specialist AE (manager)": the level only when it is not the individual contributor. */
const roleName = (p: Pick<ResolvedPersona, 'label' | 'level'>) => `${p.label}${p.level === 'manager' ? ' (manager)' : ''}`;

/** An explore item's id: `tour.<page>`. */
export const exploreId = (page: string): string => `tour.${page}`;

/**
 * The guided path's order: setup first, then each page's tour right before the step that happens there (the Outbox
 * tour before the first draft, Time's before the first batch). The tours not named here follow at the end, in
 * pages.ts order. An entry this persona has no item for (no batch feature, no tour) is passed over.
 */
export const CHECKLIST_ORDER: readonly string[] = [
  'sources',
  'persona',
  'firstScan',
  exploreId('home'),
  exploreId('triage'),
  exploreId('outbox'),
  'draft',
  exploreId('time'),
  'batch',
  exploreId('deals'),
  DC_STEP,
  'assistant',
  'feedback',
];

type Action = Omit<ChecklistItem, 'kind' | 'action'> & { id: GuideItemId; action?: ChecklistItem['action'] };
const action = (x: Action): ChecklistItem => ({ kind: 'action', ...x, action: x.action ?? null });

function actionItems(sig: GuideSignals, persona: ResolvedPersona, roleSection: string, dc: DcState): ChecklistItem[] {
  const items: ChecklistItem[] = [];
  const s = sig.sources;
  items.push(
    action({
      id: 'sources',
      title: 'Connect your sources',
      detail: s.broken.length ? `${s.broken.slice(0, 3).join(', ')}${s.broken.length > 3 ? ` +${s.broken.length - 3}` : ''} need${s.broken.length === 1 ? 's' : ''} you: re-auth in Settings ▸ Connectors.` : `All ${plural(s.active, 'source')} for your role are live.`,
      state: s.active > 0 && s.broken.length === 0 ? 'done' : 'todo',
      href: '/settings?section=connectors',
      page: 'settings',
      cta: 'Open Connectors',
    }),
  );

  items.push(
    action({
      id: 'persona',
      title: 'Check your role and thresholds',
      detail: sig.personaReviewed ? `${roleName(persona)}.` : `You're set up as ${roleName(persona)}. Check the rules and thresholds match how you work.`,
      state: sig.personaReviewed ? 'done' : 'todo',
      href: `/settings?section=${roleSection}`,
      page: 'settings',
      cta: 'Open Role & rules',
      action: sig.personaReviewed ? null : 'confirm',
    }),
  );

  items.push(
    action({
      id: 'firstScan',
      title: 'Let the first scan finish',
      detail:
        sig.firstScan === 'done'
          ? 'Your history is in: Home, Work and Deals are filled in.'
          : sig.firstScan === 'running'
            ? 'Reading your recent history. Lists fill in as it goes; Health shows the progress.'
            : 'No scan has finished yet. Check Health if this stays empty.',
      state: sig.firstScan === 'done' ? 'done' : sig.firstScan === 'running' ? 'waiting' : 'todo',
      href: '/health',
      page: 'health',
      cta: sig.firstScan === 'none' ? 'Open Health' : 'See progress',
    }),
  );

  items.push(
    action({
      id: 'draft',
      title: 'Approve your first draft',
      detail: sig.draftsApproved ? `${plural(sig.draftsApproved, 'draft')} approved. Nothing leaves without your OK.` : 'Open a drafted reply in the Outbox, edit it, and approve it. Dry run keeps it on this machine.',
      state: sig.draftsApproved ? 'done' : 'todo',
      href: '/outbox',
      page: 'outbox',
      cta: 'Show me in the Outbox',
    }),
  );

  const kind = batchKind(persona);
  if (kind) {
    const what = kind === 'logging' ? 'logging' : 'forecast notes';
    items.push(
      action({
        id: 'batch',
        title: `Apply your first ${what} batch`,
        // it ticks on an Applied canvas; one staged and waiting says where to Apply it
        detail: sig.batches
          ? `${plural(sig.batches, 'batch', 'batches')} applied. Each one went to Slack on your Apply.`
          : sig.batchesStaged
            ? `${plural(sig.batchesStaged, 'batch', 'batches')} staged: Apply ${sig.batchesStaged === 1 ? 'it' : 'them'} on ${kind === 'logging' ? 'Activity' : 'Activity ▸ Forecast'}.`
            : kind === 'logging'
              ? 'On Activity, review a week of rows, log them as one batch and Apply it.'
              : 'On Activity ▸ Forecast, draft the week’s notes, approve them, stage one batch and Apply it.',
        state: sig.batches ? 'done' : 'todo',
        // an AE's /time opens on Forecast; anyone else's on Week, where the quarter log is
        href: kind === 'logging' ? '/activity' : '/activity?view=forecast',
        page: 'time',
        cta: kind === 'logging' ? 'Show me on Activity' : 'Show me on Forecast',
      }),
    );
  }

  if (featureActive(persona, 'dealContributions')) {
    const done = dc.requests > 0 || dc.claimed;
    items.push(
      action({
        id: DC_STEP,
        title: 'Claim a deal contribution',
        detail: dc.requests > 0 ? `${plural(dc.requests, 'DC request')} made. Your hours count where they should.` : done ? 'Claimed. Your hours count where they should.' : 'Claim the opps you really worked on (an account page, Missed opportunities or the Assistant). It goes in your next batch.',
        state: done ? 'done' : 'todo',
        href: '/deals/dcs',
        page: 'deals',
        cta: 'Show me on DCs',
        action: done ? null : 'confirm',
      }),
    );
  }

  items.push(
    action({
      id: 'assistant',
      title: 'Ask the Assistant something',
      detail: sig.assistantMessages ? 'You’ve used the Assistant. ⌘J opens it from any page.' : 'Press ⌘J and ask about a deal, a meeting or your week. It reads; it only stages changes.',
      state: sig.assistantMessages ? 'done' : 'todo',
      href: null,
      page: null,
      cta: 'Open the Assistant',
      action: sig.assistantMessages ? null : 'assistant',
    }),
  );

  items.push(
    action({
      id: 'feedback',
      title: 'Report a bug or an idea',
      detail: sig.feedbackSent ? 'Thanks: you sent a report (with dry run on, it stayed on this machine).' : 'Use Feedback in the top bar (or ⌘K ▸ Report a bug / idea). You see and edit the report before it goes.',
      state: sig.feedbackSent ? 'done' : 'todo',
      href: null,
      page: null,
      cta: 'Show me',
      action: sig.feedbackSent ? null : 'feedback',
    }),
  );
  return items;
}

function exploreItems(sig: GuideSignals, persona: ResolvedPersona): ChecklistItem[] {
  const toured = new Set(sig.toured);
  return exploreFor(persona).map((e): ChecklistItem => {
    const done = toured.has(e.page);
    return {
      id: exploreId(e.page),
      kind: 'explore',
      title: e.title,
      detail: e.personaDetail?.[persona.id] ?? e.detail,
      state: done ? 'done' : 'todo',
      href: e.href,
      page: e.page,
      cta: done ? 'Take it again' : 'Take the tour',
      action: null,
    };
  });
}

/** The DC step's facts (outside GuideSignals: the contract's signals stay as they are). */
interface DcState {
  requests: number;
  /** Done on its tip, or "I've claimed one". */
  claimed: boolean;
}

/** The whole guided path, in order (CHECKLIST_ORDER, then the other tours). Role & rules has its own section. */
export function buildChecklist(sig: GuideSignals, persona: ResolvedPersona, opts: { roleSection?: string; dc?: Partial<DcState> } = {}): ChecklistItem[] {
  // Done on an item's "Show me" tip ticks it at once, whatever the state says (real use ticks it too)
  const acked = new Set(sig.acknowledged ?? []);
  const dc: DcState = { requests: opts.dc?.requests ?? 0, claimed: opts.dc?.claimed ?? false };
  const actions = actionItems(sig, persona, opts.roleSection ?? 'role', dc).map((x) => (x.state !== 'done' && acked.has(x.id as ChecklistItemId) ? { ...x, state: 'done' as const, action: null } : x));
  const all = [...actions, ...exploreItems(sig, persona)];
  const byId = new Map(all.map((x) => [x.id, x] as const));
  const ordered = CHECKLIST_ORDER.map((id) => byId.get(id)).filter((x): x is ChecklistItem => Boolean(x));
  const placed = new Set(ordered.map((x) => x.id));
  return [...ordered, ...all.filter((x) => !placed.has(x.id))];
}

/**
 * The popover's two groups: what is left, in order (a waiting step stays in place), and the done ones, folded into
 * "Done · N" at the bottom.
 */
export function foldChecklist<T extends Pick<ChecklistItem, 'state'>>(items: readonly T[]): { open: T[]; done: T[] } {
  return { open: items.filter((x) => x.state !== 'done'), done: items.filter((x) => x.state === 'done') };
}

// ---- the five outcomes ------------------------------------------------------------------------------------------

export type OutcomeId = 'sources' | 'role' | 'draft' | 'week' | 'dc';

export interface OutcomeDef {
  id: OutcomeId;
  title: string;
  /** What you get once it is done. */
  why: string;
  /** The steps that make it done (those this persona has). */
  required: readonly string[];
  /** The steps that explain it, on demand (tours, the Assistant, feedback): never hold it open. */
  detail: readonly string[];
}

export const OUTCOMES: readonly OutcomeDef[] = [
  {
    id: 'sources',
    title: 'Connect your sources',
    why: 'Slack, Gmail, Calendar, Drive and the rest, read only, so the list is built from what really happened.',
    required: ['sources', 'firstScan'],
    detail: [exploreId('home'), exploreId('work'), exploreId('health')],
  },
  { id: 'role', title: 'Pick your role', why: 'Solutions Engineer or Specialist AE decides what is scanned, what Home shows and what gets logged.', required: ['persona'], detail: [exploreId('settings'), 'feedback'] },
  {
    id: 'draft',
    title: 'Approve your first draft',
    why: 'Replies wait in the Outbox until you approve each one. Nothing leaves without you.',
    required: ['draft'],
    detail: [exploreId('triage'), exploreId('outbox'), exploreId('briefs'), exploreId('agents'), 'assistant'],
  },
  { id: 'week', title: 'Log a week', why: 'Your meetings and work become the activity log for Org62, reviewed and applied in one batch.', required: ['batch'], detail: [exploreId('time')] },
  { id: 'dc', title: 'Claim a deal contribution', why: 'Opps you work on get your DC, so your hours count where they should.', required: [DC_STEP], detail: [exploreId('deals')] },
];

/** The 'week' outcome for a persona whose batch is the forecast notes (the Specialist AE's, D-55). */
const FORECAST_WEEK: Pick<OutcomeDef, 'title' | 'why'> = {
  title: 'Update your forecast notes',
  why: 'Fresh notes on your in-quarter Specialist Forecasts, drafted from your week, reviewed and applied in one batch.',
};

/**
 * The outcomes in this persona's words (D-55): an AE's "Log a week" is the week's forecast notes, the batch its step
 * stages (`batchKind`). No persona (still loading): the default words.
 */
export function outcomesFor(persona: ResolvedPersona | null | undefined): readonly OutcomeDef[] {
  if (!persona || batchKind(persona) !== 'forecast') return OUTCOMES;
  return OUTCOMES.map((o) => (o.id === 'week' ? { ...o, ...FORECAST_WEEK } : o));
}

export interface OutcomeView<T> extends OutcomeDef {
  /** Done when every required step this persona has is done; waiting when only a waiting one is left. */
  state: ChecklistItem['state'];
  /** Its steps, in the guided path's order (required and detail). */
  items: T[];
  /** The step to do next: a required one first, then a tour or extra still to do. */
  next: T | null;
}

/**
 * The outcomes this persona has (an outcome with none of its required steps is left out), each with its steps, plus
 * the steps no counted outcome holds (`extra`: a tour added later, a tour whose outcome the role doesn't have).
 */
export function outcomesOf<T extends Pick<ChecklistItem, 'id' | 'state'>>(items: readonly T[], persona?: ResolvedPersona | null): { outcomes: OutcomeView<T>[]; extra: T[] } {
  const placed = new Set<string>();
  const outcomes: OutcomeView<T>[] = [];
  for (const o of outcomesFor(persona)) {
    const req = items.filter((i) => o.required.includes(i.id));
    if (!req.length) continue;
    const mine = items.filter((i) => o.required.includes(i.id) || o.detail.includes(i.id));
    for (const i of mine) placed.add(i.id);
    const state: ChecklistItem['state'] = req.every((i) => i.state === 'done') ? 'done' : req.some((i) => i.state === 'todo') ? 'todo' : 'waiting';
    const next = req.find((i) => i.state === 'todo') ?? req.find((i) => i.state === 'waiting') ?? mine.find((i) => i.state === 'todo') ?? null;
    outcomes.push({ ...o, state, items: mine, next });
  }
  return { outcomes, extra: items.filter((i) => !placed.has(i.id)) };
}

/** "2 of 5": the outcomes done, of those this persona has. */
export function outcomeCount(items: readonly Pick<ChecklistItem, 'id' | 'state'>[]): { done: number; total: number } {
  const { outcomes } = outcomesOf(items);
  return { done: outcomes.filter((o) => o.state === 'done').length, total: outcomes.length };
}

/**
 * The step to do next: the first outcome not done, its next required step (a waiting one only when nothing else is
 * left to do). Null once every outcome is done, whatever tours are left.
 */
export function nextStep<T extends Pick<ChecklistItem, 'id' | 'state'>>(g: { items: readonly T[] }): T | null {
  const open = outcomesOf(g.items).outcomes.filter((o) => o.state !== 'done');
  return open.find((o) => o.state === 'todo')?.next ?? open[0]?.next ?? null;
}

export function guidePayload(i: GuideInputs, opts: { roleSection?: string } = {}): GuidePayload {
  const signals = guideSignals(i);
  const items = buildChecklist(signals, i.persona, { ...opts, dc: { requests: i.dcRequests ?? 0, claimed: Boolean(i.guide.seen[itemDoneKey(DC_STEP)]) } });
  // the card and the page count the outcomes; the steps are their detail
  const { done, total } = outcomeCount(items);
  return { items, done, total, dismissed: i.guide.checklistDismissed, signals };
}

