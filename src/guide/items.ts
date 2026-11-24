/**
 * Getting started's "Show me": for each action item, the element to use on its page and a one- or two-step tip that
 * says what to do with it. Plain data, next to the page tours (pages.ts): an anchor selector, then fallbacks tried in
 * order when the page shows something else (no draft yet: the Outbox list), a short title and a body of one or two
 * sentences. CoachMarks plays it after the item's navigation, or at once when you are already there.
 *
 * Anchors are `data-guide` ids where the page had no stable selector (tests/handoff/guide.test.ts checks each one
 * exists in the components).
 */
import type { ResolvedPersona } from '@/personas';
import { batchKind, PERSONA_REVIEWED_KEY, type GuideItemId } from './checklist';
import type { CoachMarkDef } from './pages';

export interface GuideStepDef extends Omit<CoachMarkDef, 'feature' | 'personas'> {
  /** Tried in order when `selector` is not on the page. */
  fallback?: readonly string[];
  /** A second button on the card that settles the item as it is ("Looks right"): records `seen`, ends the tip. */
  confirm?: { label: string; seen: readonly string[] };
}

type GuideKey = Exclude<GuideItemId, 'batch'> | 'batch.logging' | 'batch.forecast';

export const ITEM_GUIDES: Record<GuideKey, readonly GuideStepDef[]> = {
  sources: [
    {
      id: 'guide.sources',
      selector: '[data-guide="connectors"]',
      fallback: ['table[aria-label="Connectors"]'],
      title: 'Your sources',
      text: 'One row per source, with whether it is live. A row that needs you says how to sign in again.',
      side: 'bottom',
    },
  ],
  persona: [
    {
      id: 'guide.persona',
      selector: '[data-guide="role-header"]',
      title: 'Your role and its rules',
      text: 'Your role sets what is active: duties, rules, thresholds and sources. Change anything below and Save, or press Looks right.',
      side: 'bottom',
      confirm: { label: 'Looks right', seen: [PERSONA_REVIEWED_KEY] },
    },
  ],
  firstScan: [
    {
      id: 'guide.firstScan',
      selector: 'section[aria-label="First scan"]',
      fallback: ['[data-pane="sources"]'],
      title: 'Your first scan',
      text: 'Each source reads back through your recent history. This shows how far it got; lists fill in as it goes.',
      side: 'bottom',
    },
  ],
  draft: [
    {
      id: 'guide.draft',
      selector: '[data-guide="outbox-ready"]',
      fallback: ['[data-testid="outbox-row"]', '[data-testid="outbox-list"]'],
      title: 'Your first draft',
      text: 'Open it to read and edit it, then Approve. With dry run on, nothing leaves this machine.',
      side: 'bottom',
    },
  ],
  'batch.logging': [
    {
      id: 'guide.batch.logging',
      selector: '[data-guide="log-steps"]',
      fallback: ['[data-testid="q4-log"]'],
      title: 'Get the log in',
      text: 'Log to Slackbot stages the ready rows as one canvas you Apply here; nothing reaches Org62 before. Rows that can’t log wait under Needs you.',
      side: 'bottom',
    },
  ],
  'batch.forecast': [
    {
      id: 'guide.batch.forecast',
      selector: '[data-testid="forecast-queue"]',
      fallback: ['[data-testid="forecast-view"]'],
      title: 'This week’s notes',
      text: 'Draft each note, read it and approve it. Approved notes and Deal Role fixes go in one canvas.',
      side: 'bottom',
    },
    {
      id: 'guide.batch.forecast.stage',
      selector: '[data-testid="forecast-stage"]',
      title: 'Stage the batch',
      text: 'Stage N notes puts the approved notes in one canvas and opens it. Apply it there; nothing reaches Org62 before.',
      side: 'bottom',
    },
  ],
  assistant: [
    {
      id: 'guide.assistant',
      selector: 'textarea[data-chat-input]',
      title: 'Ask the Assistant',
      text: 'Ask about a deal, a meeting or your week. It reads your data and only stages changes for you to apply.',
      side: 'left',
    },
  ],
  dc: [
    {
      id: 'guide.dc',
      selector: '[aria-label="Your DCs"]',
      fallback: ['[data-testid="dc-requests-empty"]'],
      title: 'Your deal contributions',
      text: 'The DCs Org62 has for you and your requests in flight. Claim an opp from its account page; it goes in your next batch.',
      side: 'left',
    },
  ],
  feedback: [
    {
      id: 'guide.feedback',
      selector: '[data-feedback-entry]',
      title: 'Report a bug or an idea',
      text: 'Press Feedback any time. You see and edit the report before it goes.',
      side: 'bottom',
    },
  ],
};

/** The tip for one action item, for this persona (a batch is forecast notes for an AE, the activity log otherwise). */
export function itemGuideFor(id: GuideItemId, persona: ResolvedPersona | null): GuideStepDef[] {
  if (id === 'batch') return [...ITEM_GUIDES[persona && batchKind(persona) === 'forecast' ? 'batch.forecast' : 'batch.logging']];
  return [...ITEM_GUIDES[id]];
}

/** Every item tip's steps (the anchor test reads them). */
export const ALL_ITEM_STEPS: readonly GuideStepDef[] = Object.values(ITEM_GUIDES).flat();
