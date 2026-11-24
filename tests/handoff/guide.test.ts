/**
 * Getting started from real state: five outcomes (the card's and the page's count, 01 R9), each made of the guided
 * path's steps; the full guided path per persona (action items and one tour per page, in one order), explore items ticked from seen state, done items folded, every item's button starting guidance (a page
 * tour, or an item's tip whose anchors exist in the components), coach-mark seen state that persists, and
 * persona-aware page help.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GuidePayload, Seed, type Connector, type Draft } from '@/contract';
import { batchKind, buildChecklist, DC_STEP, foldChecklist, guidePayload, guideSignals, itemDoneKey, OUTCOMES, outcomeCount, outcomesOf, PERSONA_REVIEWED_KEY, type GuideInputs } from '@/guide/checklist';
import { ALL_ITEM_STEPS, itemGuideFor } from '@/guide/items';
import { ALL_MARK_IDS, EXPLORE, exploreFor, PAGE_HELP, pageHelpFor, pageToured, tourDoneKey } from '@/guide/pages';
import { activate, keepOnRoute, parseStoredRequest, REQUEST_TTL_MS } from '@/guide/request';
import { GUIDE_RESET, mergeSeen, unseen } from '@/guide/seen';
import { coachMarksEnabled } from '@/guide/CoachMarks';
import { guideRequestFor, nextStep } from '@/guide/GettingStarted';
import { ROUTES } from '@/components/shell/routes';
import { workOrderCanvasUrl } from '@/components/time/Q4Log';
import { personaOf } from '@/personas';
import { MockDataSource } from '@/server/datasource/mock';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const se = personaOf({ profile: { role: 'se_ic' } });
const ae = personaOf({ persona: { id: 'ae' } });

const conn = (id: Connector['id'], state: Connector['state'], lastSuccessAt: string | null = '2026-11-11T08:00:00Z') => ({ id, label: id, state, lastSuccessAt });
const msg = (status: Draft['status']) => ({ status, destination: { kind: 'slack', target: 'thread', channelId: 'C0PLACE', channelName: 'x', threadTs: null } }) as unknown as Pick<Draft, 'status' | 'destination'>;
const act = (action: string, status: Draft['status']) => ({ status, destination: { kind: 'action', action } }) as unknown as Pick<Draft, 'status' | 'destination'>;

/** The guided path, in order: setup, each page's tour before the step done there, then the other tours. */
const SE_PATH = ['sources', 'persona', 'firstScan', 'tour.home', 'tour.triage', 'tour.outbox', 'draft', 'tour.time', 'batch', 'tour.deals', 'dc', 'assistant', 'feedback', 'tour.work', 'tour.briefs', 'tour.agents', 'tour.health', 'tour.settings'];
const AE_PATH = ['sources', 'persona', 'firstScan', 'tour.home', 'tour.triage', 'tour.outbox', 'draft', 'tour.time', 'batch', 'tour.deals', 'assistant', 'feedback', 'tour.work', 'tour.briefs', 'tour.agents', 'tour.health', 'tour.settings'];
const ALL_SEEN = (persona: typeof se, page: Parameters<typeof pageHelpFor>[0]) => Object.fromEntries(pageHelpFor(page, persona)!.marks.map((m) => [m.id, '2026-11-11T09:00:00Z']));

function inputs(over: Partial<GuideInputs> = {}): GuideInputs {
  return {
    connectors: se.connectors.map((c) => conn(c, 'ok')),
    drafts: [],
    assistantMessages: 0,
    firstScan: null,
    persona: se,
    personaVersion: 1,
    guide: { seen: {}, checklistDismissed: false },
    ...over,
  };
}

describe('Getting started checklist', () => {
  it('counts sources by kind, as a live database stores them (uuid ids, the kind in `source`)', () => {
    const SOURCE: Record<string, string> = { gemini_notes: 'gemini', claude_sessions: 'claude' };
    const rows = se.connectors.map((c, i) => ({ ...conn(c, 'ok'), id: `00000000-0000-4000-8000-00000000000${i}`, source: (SOURCE[c] ?? c) as Connector['source'] }));
    const sig = guideSignals(inputs({ connectors: rows }));
    expect(sig.sources.active).toBeGreaterThan(0);
    expect(sig.sources.active).toBe(rows.length);
    expect(buildChecklist(sig, se).find((i) => i.id === 'sources')).toMatchObject({ state: 'done' });
    // an AE's inactive VDP never counts, even broken
    const aeRows = [...ae.connectors.map((c, i) => ({ ...conn(c, 'ok'), id: `00000000-0000-4000-8000-0000000001${i}`, source: (SOURCE[c] ?? c) as Connector['source'] })), { ...conn('vdp', 'auth_needed'), id: '00000000-0000-4000-8000-000000000999', source: 'vdp' as Connector['source'] }];
    expect(guideSignals(inputs({ persona: ae, connectors: aeRows })).sources).toMatchObject({ broken: [], active: ae.connectors.length });
  });

  it('Done on an item\'s "Show me" tip ticks that item at once (the first scan only ticks when it finishes)', () => {
    const before = buildChecklist(guideSignals(inputs()), se);
    expect(before.find((i) => i.id === 'feedback')?.state).toBe('todo');
    const seen = { 'checklist.feedback': '2026-11-11T19:24:00Z', 'checklist.draft': '2026-11-11T19:25:00Z', 'checklist.firstScan': '2026-11-11T19:26:00Z' };
    const g = guidePayload(inputs({ guide: { seen, checklistDismissed: false }, connectors: se.connectors.map((c) => conn(c, 'ok', null)) }));
    expect(g.items.find((i) => i.id === 'feedback')).toMatchObject({ state: 'done', action: null });
    expect(g.items.find((i) => i.id === 'draft')?.state).toBe('done');
    expect(g.items.find((i) => i.id === 'firstScan')?.state).not.toBe('done');
    // the count is the outcomes': the draft outcome ticks, feedback is detail (it never holds or makes one)
    expect(g.done).toBe(guidePayload(inputs({ connectors: se.connectors.map((c) => conn(c, 'ok', null)) })).done + 1);
  });

  it('the feedback step offers Report one until a report went out', () => {
    expect(buildChecklist(guideSignals(inputs()), se).find((i) => i.id === 'feedback')).toMatchObject({ state: 'todo', action: 'feedback' });
    const sent = buildChecklist(guideSignals(inputs({ drafts: [{ ...act('feedback.post', 'sent') }] })), se).find((i) => i.id === 'feedback');
    expect(sent).toMatchObject({ state: 'done', action: null });
  });

  it('starts with everything to do except what the state already shows', () => {
    const g = guidePayload(inputs({ connectors: se.connectors.map((c) => conn(c, 'ok', null)) }));
    expect(g.items.filter((i) => i.kind === 'action').map((i) => [i.id, i.state])).toEqual([
      ['sources', 'done'],
      ['persona', 'todo'],
      ['firstScan', 'todo'],
      ['draft', 'todo'],
      ['batch', 'todo'],
      ['dc', 'todo'],
      ['assistant', 'todo'],
      ['feedback', 'todo'],
    ]);
    // every tour is still to take
    expect(g.items.filter((i) => i.kind === 'explore').every((i) => i.state === 'todo')).toBe(true);
    // five outcomes, none done (sources is live but no scan finished yet); the next step is that outcome's
    expect([g.done, g.total, g.dismissed]).toEqual([0, 5, false]);
    expect(nextStep(g)?.id).toBe('firstScan');
  });

  it('ticks each step from real state', () => {
    const s = guideSignals(
      inputs({
        connectors: [...se.connectors.filter((c) => c !== 'vdp').map((c) => conn(c, 'ok')), conn('vdp', 'auth_needed')],
        drafts: [msg('drafting'), msg('sent'), act('slack_canvas.create', 'ready'), act('slack_canvas.create', 'verified'), act('slack_canvas.create', 'rejected'), act('feedback.post', 'ready'), act('feedback.post', 'sent'), act('vdp.patch', 'sent')],
        assistantMessages: 3,
        firstScan: { status: 'done' },
        guide: { seen: { [PERSONA_REVIEWED_KEY]: '2026-11-11T09:00:00Z' }, checklistDismissed: false },
      }),
    );
    // vdp is an SE source: its auth counts against "sources"; a rejected canvas and a draft still drafting don't count;
    // the applied (verified) canvas is the batch, the one still waiting for Apply is only staged
    expect(s).toEqual({ sources: { active: se.connectors.length, live: se.connectors.length - 1, broken: ['vdp'] }, personaReviewed: true, firstScan: 'done', draftsApproved: 1, batches: 1, batchesStaged: 1, assistantMessages: 3, feedbackSent: 1, acknowledged: ['persona'], toured: [] });
    const items = buildChecklist(s, se);
    expect(items.find((i) => i.id === 'sources')).toMatchObject({ state: 'todo', detail: expect.stringContaining('vdp needs you') });
    expect(items.filter((i) => i.state === 'done').map((i) => i.id)).toEqual(['persona', 'firstScan', 'draft', 'batch', 'assistant', 'feedback']);
  });

  it('the batch step ticks on an Applied canvas; one merely staged says to Apply it on Activity', () => {
    const batch = (drafts: GuideInputs['drafts']) => buildChecklist(guideSignals(inputs({ drafts })), se).find((i) => i.id === 'batch')!;
    expect(batch([act('slack_canvas.create', 'ready')])).toMatchObject({ state: 'todo', detail: '1 batch staged: Apply it on Activity.' });
    expect(batch([act('slack_canvas.create', 'ready'), act('slack_canvas.create', 'sending')])).toMatchObject({ state: 'todo', detail: '2 batches staged: Apply them on Activity.' });
    for (const st of ['sent', 'staged', 'verified', 'verify_failed'] as const) expect(batch([act('slack_canvas.create', st)]).state).toBe('done');
    expect(batch([act('slack_canvas.create', 'verified')]).detail).toBe('1 batch applied. Each one went to Slack on your Apply.');
    expect(batch([act('slack_canvas.create', 'rejected')])).toMatchObject({ state: 'todo', detail: expect.stringMatching(/^On Activity, review a week of rows, log them as one batch/) });
    // under dry run an Apply renders the canvas and keeps it ready: that is the Apply, as with a draft's Send
    const dryApplied = { ...act('slack_canvas.create', 'ready'), attempts: [{ id: 'att1', at: '2026-11-11T09:00:00Z', mode: 'send', dryRun: true, outcome: 'rendered' }] } as unknown as Draft;
    expect(batch([dryApplied]).state).toBe('done');
  });

  it('under dry run a Send keeps the draft ready with an attempt: that still counts, a staged report alone does not', () => {
    const dry = (d: Pick<Draft, 'status' | 'destination'>) => ({ ...d, attempts: [{ id: 'att1', at: '2026-11-11T09:00:00Z', mode: 'send', dryRun: true, outcome: 'rendered' }] }) as unknown as Draft;
    const s = guideSignals(inputs({ drafts: [dry(msg('ready')), act('feedback.post', 'ready'), dry(act('feedback.post', 'ready'))] }));
    expect([s.draftsApproved, s.feedbackSent]).toEqual([1, 1]);
  });

  it('a running first scan is "waiting", and a saved persona section counts as reviewed', () => {
    const g = guidePayload(inputs({ firstScan: { status: 'active' }, personaVersion: 2 }));
    expect(g.items.find((i) => i.id === 'firstScan')?.state).toBe('waiting');
    expect(g.items.find((i) => i.id === 'persona')).toMatchObject({ state: 'done', action: null });
  });

  it('names the role plainly, with the level only for managers', () => {
    const detail = (p: typeof se) => buildChecklist(guideSignals(inputs({ persona: p })), p).find((i) => i.id === 'persona')!.detail;
    expect(detail(se)).toBe("You're set up as Solutions Engineer. Check the rules and thresholds match how you work.");
    expect(detail(personaOf({ profile: { role: 'se_manager' } }))).toMatch(/^You're set up as Solutions Engineer \(manager\)\./);
  });

  it('is persona-aware: an AE batch is forecast notes, and no batch step without the features', () => {
    const forAe = buildChecklist(guideSignals(inputs({ persona: ae, connectors: ae.connectors.map((c) => conn(c, 'ok')) })), ae);
    expect(forAe.find((i) => i.id === 'batch')?.title).toBe('Apply your first forecast notes batch');
    expect(buildChecklist(guideSignals(inputs()), se).find((i) => i.id === 'batch')?.title).toBe('Apply your first logging batch');
    const none = personaOf({ persona: { id: 'se', features: { activityLogging: false, specialistForecast: false } } });
    expect(buildChecklist(guideSignals(inputs({ persona: none })), none).map((i) => i.id)).not.toContain('batch');
    // a source outside the persona never blocks "sources"
    expect(guideSignals(inputs({ persona: ae, connectors: [...ae.connectors.map((c) => conn(c, 'ok')), conn('vdp', 'auth_needed')] })).sources.broken).toEqual([]);
  });
});

describe('the five outcomes', () => {
  it('counts five outcomes for an SE, four for an AE (no deal contributions), never the steps', () => {
    const g = guidePayload(inputs());
    expect(outcomesOf(g.items).outcomes.map((o) => o.id)).toEqual(['sources', 'role', 'draft', 'week', 'dc']);
    expect(g.total).toBe(5);
    const forAe = guidePayload(inputs({ persona: ae, connectors: ae.connectors.map((c) => conn(c, 'ok')) }));
    expect(outcomesOf(forAe.items).outcomes.map((o) => o.id)).toEqual(['sources', 'role', 'draft', 'week']);
    expect(forAe.total).toBe(4);
  });

  it('holds every one of the steps as an outcome’s detail, each in exactly one outcome', () => {
    for (const p of [se, ae]) {
      const items = guidePayload(inputs({ persona: p, connectors: p.connectors.map((c) => conn(c, 'ok')) })).items;
      const { outcomes, extra } = outcomesOf(items);
      expect(extra.map((i) => i.id), p.id).toEqual(p === ae ? ['tour.deals'] : []);
      const placed = outcomes.flatMap((o) => o.items.map((i) => i.id));
      expect(new Set(placed).size).toBe(placed.length);
      expect([...placed, ...extra.map((i) => i.id)].sort()).toEqual(items.map((i) => i.id).sort());
    }
    // the definitions name each step once
    const named = OUTCOMES.flatMap((o) => [...o.required, ...o.detail]);
    expect(new Set(named).size).toBe(named.length);
  });

  it('an outcome is done when its required steps are; tours and extras never hold it', () => {
    const g = guidePayload(inputs({ drafts: [msg('sent')], firstScan: { status: 'done' }, personaVersion: 2 }));
    const by = new Map(outcomesOf(g.items).outcomes.map((o) => [o.id, o] as const));
    expect(by.get('draft')).toMatchObject({ state: 'done' });
    expect(by.get('draft')!.items.filter((i) => i.state !== 'done').map((i) => i.id)).toEqual(['tour.triage', 'tour.outbox', 'assistant', 'tour.briefs', 'tour.agents']);
    expect(by.get('sources')!.state).toBe('done');
    expect(by.get('role')!.state).toBe('done');
    expect(by.get('week')!.state).toBe('todo');
    // a running first scan makes its outcome "waiting"
    const w = outcomesOf(guidePayload(inputs({ firstScan: { status: 'active' } })).items).outcomes[0]!;
    expect([w.id, w.state, w.next?.id]).toEqual(['sources', 'waiting', 'firstScan']);
    expect(nextStep({ items: guidePayload(inputs({ firstScan: { status: 'active' } })).items })?.id).toBe('persona');
  });

  it('the DC outcome ticks on a DC request, or on "I’ve claimed one" / Done on its tip', () => {
    const dc = (over: Partial<GuideInputs>) => guidePayload(inputs(over)).items.find((i) => i.id === DC_STEP)!;
    expect(dc({})).toMatchObject({ state: 'todo', href: '/deals/dcs', page: 'deals', action: 'confirm', cta: 'Show me on DCs' });
    expect(dc({ dcRequests: 2 })).toMatchObject({ state: 'done', action: null, detail: '2 DC requests made. Your hours count where they should.' });
    expect(dc({ guide: { seen: { [itemDoneKey(DC_STEP)]: '2026-11-11T09:00:00Z' }, checklistDismissed: false } }).state).toBe('done');
    expect(itemGuideFor(DC_STEP, se)[0]!.selector).toBe('[aria-label="Your DCs"]');
  });
});

describe('the guided path', () => {
  const aeInputs = (over: Partial<GuideInputs> = {}) => inputs({ persona: ae, connectors: ae.connectors.map((c) => conn(c, 'ok')), ...over });

  it('lists every item in one order, per persona (SE and AE)', () => {
    expect(guidePayload(inputs()).items.map((i) => i.id)).toEqual(SE_PATH);
    const forAe = guidePayload(aeInputs());
    expect(forAe.items.map((i) => i.id)).toEqual(AE_PATH);
    // the AE's batch is forecast notes, on Forecast; their Time tour covers it
    expect(forAe.items.find((i) => i.id === 'batch')).toMatchObject({ href: '/activity?view=forecast', cta: 'Show me on Forecast' });
    expect(forAe.items.find((i) => i.id === 'tour.time')!.detail).toMatch(/forecast notes/);
    expect(pageHelpFor('time', ae)!.marks.map((m) => m.id)).toContain('time.forecast');
    expect(pageHelpFor('time', se)!.marks.map((m) => m.id)).not.toContain('time.forecast');
    expect(guidePayload(inputs()).items.find((i) => i.id === 'batch')).toMatchObject({ href: '/activity', cta: 'Show me on Activity' });
    // no batch feature: no batch step, the tours stay
    const none = personaOf({ persona: { id: 'se', features: { activityLogging: false, specialistForecast: false } } });
    expect(guidePayload(inputs({ persona: none })).items.map((i) => i.id)).toEqual(SE_PATH.filter((id) => id !== 'batch'));
    expect([batchKind(se), batchKind(ae), batchKind(none)]).toEqual(['logging', 'forecast', null]);
  });

  it('has one explore item per page with a tour for the persona, each with what the page is for', () => {
    for (const p of [se, ae]) {
      const tours = exploreFor(p);
      expect(tours.length).toBeGreaterThanOrEqual(6);
      for (const e of tours) expect(pageHelpFor(e.page, p)!.marks.length, e.page).toBeGreaterThan(0);
      for (const it of guidePayload(inputs({ persona: p })).items.filter((i) => i.kind === 'explore')) {
        expect(it.title).toMatch(/^Tour /);
        expect(it.detail.length, it.id).toBeLessThanOrEqual(90);
        expect(it.detail, it.id).not.toMatch(/\.\s+\S.*\./); // one line
        expect(it).toMatchObject({ cta: 'Take the tour', action: null });
        expect(it.href).toBe(EXPLORE.find((e) => `tour.${e.page}` === it.id)!.href);
        expect(it.page).toBe(it.id.slice('tour.'.length));
      }
    }
  });

  it('an explore item is done once its tour is: every step seen, finished (Done) or skipped', () => {
    const tour = (seen: Record<string, string>, p = se) => guidePayload(inputs({ persona: p, guide: { seen, checklistDismissed: false } })).items.find((i) => i.id === 'tour.home')!;
    expect(tour({}).state).toBe('todo');
    // part of the tour seen: still to do
    expect(tour({ 'home.masthead': '2026-11-11T09:00:00Z' }).state).toBe('todo');
    // every step seen (Skip records the page's whole set)
    expect(tour(ALL_SEEN(se, 'home'))).toMatchObject({ state: 'done', cta: 'Take it again' });
    // Done on the last step records the page, even with a step whose element was missing
    expect(tour({ 'home.masthead': '2026-11-11T09:00:00Z', [tourDoneKey('home')]: '2026-11-11T09:00:00Z' }).state).toBe('done');
    // the persona's own steps count: an SE without logging has no quarter step on Time to see
    const noLog = personaOf({ persona: { id: 'se', features: { activityLogging: false } } });
    const seenTime = ALL_SEEN(noLog, 'time');
    expect(pageToured('time', noLog, seenTime)).toBe(true);
    expect(pageToured('time', se, seenTime)).toBe(false);
    const g = guidePayload(inputs({ guide: { seen: { ...ALL_SEEN(se, 'home'), [tourDoneKey('triage')]: '2026-11-11T09:00:00Z' }, checklistDismissed: false } }));
    expect(g.signals.toured).toEqual(['home', 'triage']);
    expect(g.items.filter((i) => i.kind === 'explore' && i.state === 'done').map((i) => i.id)).toEqual(['tour.home', 'tour.triage']);
  });

  it('every button says where it goes and starts guidance there: no dead "Open"', () => {
    for (const p of [se, ae]) {
      for (const it of guidePayload(inputs({ persona: p })).items) {
        expect(it.cta, it.id).not.toBe('Open');
        expect(it.cta.length, it.id).toBeGreaterThan(3);
        const r = guideRequestFor(it);
        if (it.kind === 'explore') expect(r).toEqual({ page: it.page, item: null });
        else expect(r).toEqual({ page: it.page, item: it.id });
        // a place to go means a page to play it on; the Assistant and Feedback play where you are
        if (it.href) expect(it.page, it.id).not.toBeNull();
        else expect(it.page, it.id).toBeNull();
        if (it.kind === 'action') expect(itemGuideFor(it.id as never, p).length, it.id).toBeGreaterThan(0);
      }
    }
    const items = guidePayload(inputs({ connectors: se.connectors.map((c) => conn(c, 'ok', null)) })).items;
    expect(Object.fromEntries(items.filter((i) => i.kind === 'action').map((i) => [i.id, i.cta]))).toEqual({
      sources: 'Open Connectors',
      persona: 'Open Role & rules',
      firstScan: 'Open Health',
      draft: 'Show me in the Outbox',
      batch: 'Show me on Activity',
      dc: 'Show me on DCs',
      assistant: 'Open the Assistant',
      feedback: 'Show me',
    });
    expect(items.find((i) => i.id === 'persona')!.href).toBe('/settings?section=role');
  });

  it('an item’s tip points at the element to use, persona-aware, in short plain copy', () => {
    expect(itemGuideFor('batch', ae).map((s) => s.selector)).toEqual(['[data-testid="forecast-queue"]', '[data-testid="forecast-stage"]']);
    expect(itemGuideFor('batch', se).map((s) => s.selector)).toEqual(['[data-guide="log-steps"]']);
    expect(itemGuideFor('persona', se)[0]!.confirm).toEqual({ label: 'Looks right', seen: [PERSONA_REVIEWED_KEY] });
    expect(itemGuideFor('draft', se)[0]!.fallback).toEqual(['[data-testid="outbox-row"]', '[data-testid="outbox-list"]']);
    const ids = ALL_ITEM_STEPS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_ITEM_STEPS) {
      expect(s.title.length, s.id).toBeLessThanOrEqual(32);
      expect(s.text.length, s.id).toBeLessThanOrEqual(150);
      const sentences = s.text.split(/(?<=[.?!])\s+(?=[A-Z“])/).filter(Boolean);
      expect(sentences.length, s.id).toBeGreaterThanOrEqual(1);
      expect(sentences.length, s.id).toBeLessThanOrEqual(2);
    }
  });

  it('every tip’s anchors exist in the page components (data-guide ids and the stable selectors it falls back to)', () => {
    const roots = ['src', 'app'].map((d) => path.resolve(__dirname, '../..', d));
    const sources = roots
      .flatMap((root) => (readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.tsx') && !f.includes('__tests__')).map((f) => readFileSync(path.join(root, f), 'utf8')))
      .join('\n');
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const step of ALL_ITEM_STEPS) {
      for (const sel of [step.selector, ...(step.fallback ?? [])]) {
        const attrs = [...sel.matchAll(/\[([a-z-]+)(?:="([^"]*)")?\]/g)];
        expect(attrs.length, `${step.id}: ${sel} names an attribute`).toBeGreaterThan(0);
        for (const [, name, value] of attrs) {
          const re =
            value === undefined
              ? new RegExp(`\\s${esc(name!)}[\\s>=/]`)
              : name === 'data-guide'
                ? new RegExp(`(?:data-guide|\\bguide)=(?:"${esc(value)}"|\\{[^}]*'${esc(value)}'[^}]*\\})`)
                : new RegExp(`${esc(name!)}="${esc(value)}"`);
          expect(re.test(sources), `${step.id}: ${name}${value === undefined ? '' : `="${value}"`} is rendered somewhere`).toBe(true);
        }
      }
    }
  });

  it('folds done items into "Done · N" at the bottom, the rest in order', () => {
    const g = guidePayload(
      inputs({ drafts: [msg('sent')], assistantMessages: 1, guide: { seen: { ...ALL_SEEN(se, 'home'), [PERSONA_REVIEWED_KEY]: '2026-11-11T09:00:00Z' }, checklistDismissed: false } }),
    );
    const { open, done } = foldChecklist(g.items);
    expect(done.map((i) => i.id)).toEqual(['sources', 'persona', 'firstScan', 'tour.home', 'draft', 'assistant']);
    expect(open.map((i) => i.id)).toEqual(SE_PATH.filter((id) => !done.some((d) => d.id === id)));
    expect(open.length + done.length).toBe(g.items.length);
    // three outcomes done (sources, role, draft); tours never hold one, so the next step is the batch, not a tour
    expect([g.done, g.total]).toEqual([3, 5]);
    expect(nextStep(g)?.id).toBe('batch');
    // a waiting first scan stays in place; the next step is the first one to do
    const w = guidePayload(inputs({ firstScan: { status: 'active' } }));
    expect(foldChecklist(w.items).open.slice(0, 3).map((i) => [i.id, i.state])).toEqual([
      ['persona', 'todo'],
      ['firstScan', 'waiting'],
      ['tour.home', 'todo'],
    ]);
  });

  it('when every item is done, the count says so', () => {
    const seen: Record<string, string> = { [PERSONA_REVIEWED_KEY]: '2026-11-11T09:00:00Z', [itemDoneKey(DC_STEP)]: '2026-11-11T09:00:00Z' };
    for (const e of exploreFor(se)) seen[tourDoneKey(e.page)] = '2026-11-11T09:00:00Z';
    const g = guidePayload(inputs({ drafts: [msg('sent'), act('slack_canvas.create', 'sent'), act('feedback.post', 'sent')], assistantMessages: 1, guide: { seen, checklistDismissed: false } }));
    expect([g.done, g.total]).toEqual([5, 5]);
    expect(foldChecklist(g.items).open).toEqual([]);
    expect(nextStep(g)).toBeNull();
  });
});

describe('a guidance request (Take the tour, Show me)', () => {
  it('plays on the page you are on: the same URL means no navigation, and asking again plays again', () => {
    const first = activate({ page: 'home', item: null }, 'home', 1);
    expect(keepOnRoute(first, 'home')).toBe(first);
    const again = activate({ page: 'home', item: null }, 'home', 2);
    expect(again).toEqual({ page: 'home', item: null, n: 2 });
    expect(again.n).not.toBe(first.n);
    // the Assistant and Feedback name no page: they bind to the one you are on
    expect(activate({ page: null, item: 'feedback' }, 'deals', 3)).toEqual({ page: 'deals', item: 'feedback', n: 3 });
  });

  it('waits for its page across the navigation, and is dropped on any other page', () => {
    const r = activate({ page: 'outbox', item: 'draft' }, 'home', 1);
    expect(keepOnRoute(r, 'outbox')).toBe(r);
    expect(keepOnRoute(r, 'deals')).toBeNull();
    expect(keepOnRoute(null, 'outbox')).toBeNull();
  });

  it('survives a full page load for a short while only', () => {
    const at = 1_700_000_000_000;
    const raw = JSON.stringify({ page: 'settings', item: 'sources', at });
    expect(parseStoredRequest(raw, at + 500)).toEqual({ page: 'settings', item: 'sources' });
    expect(parseStoredRequest(raw, at + REQUEST_TTL_MS + 1)).toBeNull();
    expect(parseStoredRequest(JSON.stringify({ page: null, item: null, at }), at)).toEqual({ page: null, item: null });
    expect(parseStoredRequest('{not json', at)).toBeNull();
    expect(parseStoredRequest(null, at)).toBeNull();
  });
});

describe('GET /guide and the guide settings (mock)', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
  });
  afterEach(() => ds.dispose());

  it('answers the checklist from the seed state', async () => {
    const g = await ds.getGuide({} as never);
    expect(GuidePayload.parse(g)).toEqual(g);
    expect([g.done, g.total]).toEqual([outcomeCount(g.items).done, outcomeCount(g.items).total]);
    expect(g.total).toBe(5);
    expect(g.signals.assistantMessages).toBeGreaterThanOrEqual(0);
  });

  it('coach-mark seen state persists, and dismissing the checklist keeps it', async () => {
    const v1 = (await ds.getSettings({} as never)).guide;
    const seen = mergeSeen(v1.seen, ['home.masthead', 'home.dayline'], '2026-11-11T09:00:00.000Z');
    await ds.patchSettings({ params: { section: 'guide' }, body: { ifVersion: v1.version, value: { seen } } } as never);
    const v2 = (await ds.getSettings({} as never)).guide;
    expect(v2.seen).toEqual({ 'home.masthead': '2026-11-11T09:00:00.000Z', 'home.dayline': '2026-11-11T09:00:00.000Z' });
    await ds.patchSettings({ params: { section: 'guide' }, body: { ifVersion: v2.version, value: { checklistDismissed: true } } } as never);
    const v3 = (await ds.getSettings({} as never)).guide;
    expect(v3).toMatchObject({ checklistDismissed: true, seen: v2.seen });
    expect((await ds.getGuide({} as never)).dismissed).toBe(true);
    // the coach marks for Home now skip the two seen ones
    expect(unseen(pageHelpFor('home', se)!.marks, v3.seen).map((m) => m.id)).toEqual(['home.donow', 'home.pagehelp']);
    // "Show all tips again" brings everything back
    await ds.patchSettings({ params: { section: 'guide' }, body: { ifVersion: v3.version, value: { ...GUIDE_RESET } } } as never);
    expect((await ds.getSettings({} as never)).guide).toMatchObject({ checklistDismissed: false, seen: {} });
  });

  it('a finished tour ticks its explore item on the next read', async () => {
    const g0 = await ds.getGuide({} as never);
    expect(g0.items.find((i) => i.id === 'tour.triage')?.state).toBe('todo');
    const v = (await ds.getSettings({} as never)).guide;
    await ds.patchSettings({ params: { section: 'guide' }, body: { ifVersion: v.version, value: { seen: mergeSeen(v.seen, ['triage.list', tourDoneKey('triage')], '2026-11-11T09:00:00.000Z') } } } as never);
    const g1 = await ds.getGuide({} as never);
    expect(g1.items.find((i) => i.id === 'tour.triage')).toMatchObject({ state: 'done', cta: 'Take it again' });
    // a tour is an outcome's detail: it ticks, the outcome count does not move
    expect([g1.done, g1.total]).toEqual([g0.done, g0.total]);
    expect(g1.signals.toured).toContain('triage');
  });

  it('confirming the role ticks the persona step', async () => {
    const g = (await ds.getSettings({} as never)).guide;
    await ds.patchSettings({ params: { section: 'guide' }, body: { ifVersion: g.version, value: { seen: mergeSeen(g.seen, [PERSONA_REVIEWED_KEY], '2026-11-11T09:00:00.000Z') } } } as never);
    expect((await ds.getGuide({} as never)).items.find((i) => i.id === 'persona')?.state).toBe('done');
  });
});

describe('seen bookkeeping', () => {
  it('keeps the first time a mark was seen', () => {
    expect(mergeSeen({ a: '2026-01-01T00:00:00Z' }, ['a', 'b'], '2026-02-02T00:00:00Z')).toEqual({ a: '2026-01-01T00:00:00Z', b: '2026-02-02T00:00:00Z' });
    expect(unseen([{ id: 'a' }, { id: 'b' }, { id: 'c' }], { a: 'x' }, new Set(['c']))).toEqual([{ id: 'b' }]);
  });

  it('coach marks stay off for automation unless ?coach=1', () => {
    expect(coachMarksEnabled({ search: '' }, { webdriver: false })).toBe(true);
    expect(coachMarksEnabled({ search: '' }, { webdriver: true })).toBe(false);
    expect(coachMarksEnabled({ search: '?coach=1' }, { webdriver: true })).toBe(true);
    expect(coachMarksEnabled({ search: '?coach=0' }, { webdriver: false })).toBe(false);
  });
});

describe('page help', () => {
  it('covers the sidebar pages, with 2–4 coach marks on the key ones and unique mark ids', () => {
    const keys = new Set(ROUTES.map((r) => r.key));
    for (const k of Object.keys(PAGE_HELP)) expect(keys.has(k as never), k).toBe(true);
    for (const k of ['home', 'outbox', 'work', 'deals', 'time', 'health', 'settings', 'triage', 'briefs', 'agents', 'history', 'assistant'] as const) expect(PAGE_HELP[k], k).toBeDefined();
    for (const k of ['home', 'time', 'deals', 'health', 'settings', 'outbox'] as const) expect(PAGE_HELP[k]!.marks.length, k).toBeGreaterThanOrEqual(2);
    for (const p of Object.values(PAGE_HELP)) expect(p!.marks.length).toBeLessThanOrEqual(4);
    expect(new Set(ALL_MARK_IDS).size).toBe(ALL_MARK_IDS.length);
  });

  it('is persona-aware', () => {
    expect(pageHelpFor('home', se)?.note).toMatch(/VDP/);
    expect(pageHelpFor('home', ae)?.note).toMatch(/forecast notes/);
    expect(pageHelpFor('time', ae)?.actions.map((a) => a.text)).toContain('Draft the week’s forecast notes and stage them as one canvas');
    expect(pageHelpFor('time', se)?.actions.map((a) => a.text)).not.toContain('Draft the week’s forecast notes and stage them as one canvas');
    const noLog = personaOf({ persona: { id: 'se', features: { activityLogging: false } } });
    expect(pageHelpFor('time', noLog)?.marks.map((m) => m.id)).not.toContain('time.quarter');
    expect(pageHelpFor('notFound' as never, se)).toBeNull();
  });
});

describe('work-order canvas link', () => {
  it('comes from settings, then the env, else no link', () => {
    const t = (url: string | null) => ({ logging: { mode: 'on_demand', canvas: 'per_batch', autoAt: '17:30', approveComplete: true, sharedCanvasId: null, org62RecordTypeId: null, workOrderCanvasUrl: url } }) as const;
    expect(workOrderCanvasUrl(t('https://example.slack.com/docs/T0/F0PLACEHOLD'), undefined)).toBe('https://example.slack.com/docs/T0/F0PLACEHOLD');
    expect(workOrderCanvasUrl(t(null), 'https://example.slack.com/docs/env')).toBe('https://example.slack.com/docs/env');
    expect(workOrderCanvasUrl(t(null), undefined)).toBeNull();
    expect(workOrderCanvasUrl(undefined, undefined)).toBeNull();
  });
});
