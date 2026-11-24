/** Sample activity rows for the lanes kit (placeholders only: Example Co, Sample Account, Placeholder Inc). */
import type { ActivityEntry, ActivitySuggestion } from '@/contract';

const base: ActivityEntry = {
  id: 'kit-0',
  version: 1,
  date: '2026-11-19',
  start: '2026-11-19T16:00:00.000Z',
  end: '2026-11-19T17:00:00.000Z',
  durationH: 1,
  taskType: 'Demo',
  oppId: null,
  oppName: null,
  accountName: null,
  meetingType: 'CF',
  description: 'Roadmap call',
  status: 'needs_input',
  confidence: 'guess',
  sources: [],
  userLockedFields: [],
  issues: [],
  updatedAt: '2026-11-19T17:00:00.000Z',
  fromOrg62: false,
  excludedReason: null,
  loggedAt: null,
  verifiedAt: null,
  internal: false,
  dismissSource: null,
  logNote: null,
  logNoteBasis: null,
  why: null,
  suggestion: null,
} as ActivityEntry;

const sug = (confidence: number, accountName = 'Example Co', oppName = 'Expansion'): ActivitySuggestion => ({ kind: 'opp', oppId: 'kit-opp', oppName, accountName, taskType: null, confidence, reason: 'the meeting names the account', basis: 'rules', at: null });

const TITLES = ['Roadmap call', 'Architecture call with the platform team and the customer data architects', 'Pricing workshop', 'Demo prep', 'Security review', 'Discovery follow-up', 'Data model draft', 'Evaluation call'];
const HOURS = [1, 1, 2, 0.5, 1, 1, 1.5, 0.75];

function day(i: number): Pick<ActivityEntry, 'date' | 'start' | 'end'> {
  const d = `2026-11-${String(17 + Math.floor(i / 2)).padStart(2, '0')}`;
  const h = 15 + (i % 2) * 3;
  return { date: d, start: `${d}T${h}:00:00.000Z`, end: `${d}T${h + 1}:00:00.000Z` };
}

/** Lane 1: suggestions (some at the settle line, some under), one with nothing to go on. */
export const FIX_SAMPLE: ActivityEntry[] = TITLES.map((t, i) => ({ ...base, ...day(i), id: `kit-fix-${i}`, description: t, durationH: HOURS[i]!, suggestion: i === 6 ? null : sug([0.87, 0.76, 0.92, 0.64, 0.81, 0.58, 0, 0.79][i]!) }));

/** Lane 2: approved rows, their opp set. */
export const READY_SAMPLE: ActivityEntry[] = TITLES.map((t, i) => ({ ...base, ...day(i), id: `kit-ready-${i}`, description: t, durationH: HOURS[i]!, status: 'approved', oppId: 'kit-opp', accountName: i % 3 ? 'Sample Account' : 'Example Co', oppName: i % 3 ? 'Renewal' : 'Expansion', internal: i === 4 }));

/** Lane 3: a sent batch's rows, two not found in Org62. */
export const SENDING_SAMPLE: ActivityEntry[] = READY_SAMPLE.map((e, i) => ({ ...e, id: `kit-send-${i}`, status: i === 5 ? 'verify_failed' : 'logged' }));
export const SENDING_FAILED = new Set(['kit-send-1', 'kit-send-5']);
