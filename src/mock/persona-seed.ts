/**
 * The Specialist AE's mock world (29-persona-qa decision 2): the placeholder example seed is one SE's week (demos, SE
 * stand-ups, a VDP to update), so as an AE, Home, Today and Time read SE content. `aeSeedOverlay` swaps those SE-only
 * items for an AE's (a forecast call, a pipeline review, Org62 discovery, forecast notes and a Deal Role) and sets the
 * persona to the AE with its starter policy, as Settings ▸ Role & rules' switch would. Ids, dates, accounts, opps and
 * people stay, so every link and the scenario clock still resolve. Placeholders only (the example's names).
 *
 *   tests     createMockDataSource({ seed: personaSeed('ae') })
 *   crawl     npm run smoke:crawl -- --mock --persona ae   (writes the overlaid seed and passes it as CC_SEED_PATH)
 *   dev       writePersonaSeed('ae', '<file>'), then CC_SEED_PATH=<file> CC_DATA=mock npm run dev:web
 *
 * Pure apart from the two helpers that read and write files. Not in the example generator: `npm run seed:example`
 * is unchanged.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import type { PersonaId, Seed } from '@/contract';
import { personaOf } from '@/personas';
import { reseededPolicy } from '@/server/persona/switch';
import { EXAMPLE_SEED_PATH, loadSeed, parseSeed } from '@/server/datasource/mock/seed-loader';

type Patch = Record<string, unknown>;

/**
 * Phrases swapped in every user-facing string (longest first; ids, keys, urls and paths are left alone): the SE's
 * demo day becomes the AE's proposal review, the SE team's meetings the AE's forecast cadence.
 */
const PHRASES: ReadonlyArray<readonly [string, string]> = [
  ['Build the ACME Phase 2 demo org: load unified profiles, wire the headless portal…', 'Draft the ACME Phase 2 forecast notes: compelling event, in quarter, next step, risk…'],
  ['Build is ~1h40m of agent time; demo at 13:00', 'Forecast call Monday; the notes are 9 days old'],
  ['Demo scheduled; needs a Phase 2 org', 'Proposal review scheduled; the forecast notes are 9 days old'],
  ['Today’s 13:00 demo is the technical gate', 'Today’s 13:00 proposal review is the last gate'],
  ['Your VDP should reflect the stage', 'Your Specialist Forecast should reflect the stage'],
  ['ACME Phase 2 demo-org build', 'ACME Phase 2 forecast notes draft'],
  ['Kick off ACME demo-org build', 'Draft the ACME forecast notes'],
  ['Final ACME demo run-through', 'Final ACME proposal run-through'],
  ['ACME Phase 2 demo script', 'ACME Phase 2 proposal deck'],
  ['ACME Headless Phase 2 demo', 'ACME Headless Phase 2 proposal'],
  ['ACME Phase 2 demo', 'ACME Phase 2 proposal review'],
  ['demo org building', 'forecast notes drafting'],
  ['Umbrella demo dataset', 'Umbrella pipeline review prep'],
  ['SE team stand-up', 'Specialist AE forecast call'],
  ['SE team retro', 'Pipeline review with my RVP'],
  ['SE enablement sync', 'Specialist AE pipeline sync'],
  ['the demo is at 13:00', 'the proposal review is at 13:00'],
  ['whether the demo still covers', 'whether the review still covers'],
  ['demo scope', 'proposal review agenda'],
  ['demo at 13:00', 'proposal review at 13:00'],
  ['after the demo', 'after the proposal review'],
  ['Demo script:', 'Proposal deck:'],
];

/** Keys whose values are ids, keys, links or paths: never reworded. */
const KEEP = /(^id$|Id$|^key$|url$|Url$|^href$|^cwd$|^folder$|^deepLink$)/;

function reword<T>(v: T): T {
  const walk = (x: unknown, key: string): unknown => {
    if (typeof x === 'string') return KEEP.test(key) ? x : PHRASES.reduce((s, [from, to]) => s.split(from).join(to), x);
    if (Array.isArray(x)) return x.map((y) => walk(y, key));
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
    return x;
  };
  return walk(v, '') as T;
}

/** Calendar: the stand-up's agenda in the AE's words (the titles come from PHRASES). */
const EVENTS: Record<string, Patch> = {
  ev_standup: { agenda: 'Commit, best case and pipeline by deal; what moved since last week.' },
};

/** Work items: the SE's builds, demo data and VDP become an AE's forecast notes, Deal Role and Org62 discovery. */
const WORK: Record<string, Patch> = {
  w_acme_build: { title: 'Draft the ACME Phase 2 forecast notes', purpose: 'Fresh notes before Monday’s forecast call', why: 'Notes last updated 9 days ago; proposal review today' },
  w_acme_refresh: { title: 'Set the Deal Role on the Hooli Specialist Forecast', purpose: 'Every deal with ACV has a Deal Role', why: 'Deal Role is None on a deal with ACV' },
  w_vdp_globex: {
    title: 'Org62 discovery: add the Data 360 line items to the Globex expansion',
    purpose: 'So the expansion can be forecast',
    why: 'Stage moved to Negotiation with no Specialist Forecast',
    sources: [{ kind: 'org62', label: 'Org62 · Globex · Data 360 Expansion' }],
    stale: null,
  },
  w_umbrella_dataset: { title: 'Prep the Umbrella deal for the pipeline review', purpose: 'Next step, owner and risk for the RVP' },
  w_promise_reset: { title: 'Share the Q4 pipeline summary with my RVP' },
  w_log_hooli: { title: 'Log yesterday’s Hooli onsite in Org62 as a Sales Event' },
};

const NBAS: Record<string, Patch> = {
  nba_acme_build: { title: 'Draft the ACME forecast notes in Claude' },
  nba_log_hooli: { title: 'Log the Hooli onsite as a Sales Event' },
};

/** Time: an AE's Sales Events take no task type (set on every row below), and the internal rows are the AE's own. */
const ACTIVITY: Record<string, Patch> = {
  ac_mon_prep: { description: 'Proposal prep', logNote: 'Proposal prep for ACME Corp.' },
  ac_thu_acme: { logNote: 'Sales Event with the ACME Corp team: Phase 2 proposal review.' },
  ac_wed_hooli: { issues: ['Needs an opportunity'] },
  ac_tue_repo: { description: 'pricing-calculator: internal asset build', sources: [{ kind: 'claude', label: 'Claude · Pricing calculator build' }], logNote: 'Internal asset build: Claude Code work on the pricing calculator.' },
  ac_wed_docs: { sources: [{ kind: 'drive', label: 'Drive · Proposal template' }], logNote: 'Internal asset build: edited the proposal template and the estimator notes in Drive.' },
};

function patchById<T extends { id: string }>(rows: T[], patches: Record<string, Patch>, each?: (row: T) => T): T[] {
  return rows.map((r) => {
    const p = patches[r.id];
    const row = p ? ({ ...r, ...p } as T) : r;
    return each ? each(row) : row;
  });
}

/** The example seed as a Specialist AE's world (see the header). Pure: returns a new seed. */
export function aeSeedOverlay(base: Seed): Seed {
  const s = reword(structuredClone(base));
  const at = s.meta.asOf;
  const persona = { ...s.settings.persona, version: (s.settings.persona?.version ?? 1) + 1, id: 'ae' as PersonaId, level: null };
  const settings = { ...s.settings, persona } as Seed['settings'];
  const { policy } = reseededPolicy(s.settings.policy, personaOf(settings), at);
  s.settings = { ...settings, policy };
  s.policyVersions = [...s.policyVersions, { version: policy.version, at, by: 'user', note: policy.note ?? 'Role pack', policy }] as Seed['policyVersions'];
  s.calendar = { ...s.calendar, events: patchById(s.calendar.events, EVENTS) };
  s.workItems = patchById(s.workItems, WORK);
  s.nbas = patchById(s.nbas, NBAS);
  s.activity = patchById(s.activity, ACTIVITY, (a) => ({ ...a, taskType: null }));
  return parseSeed(s, 'AE seed overlay');
}

/** The example seed for a persona (dates rebased to today, as the mock loads it). The SE's is the example itself. */
export function personaSeed(persona: PersonaId, base: Seed = loadSeed({ path: EXAMPLE_SEED_PATH }).seed): Seed {
  return persona === 'ae' ? aeSeedOverlay(base) : base;
}

/** Write the persona's seed (not rebased: the loader rebases it) to `file`, for CC_SEED_PATH. */
export function writePersonaSeed(persona: PersonaId, file: string): string {
  const raw = parseSeed(JSON.parse(readFileSync(EXAMPLE_SEED_PATH, 'utf8')), 'seed.example.json');
  writeFileSync(file, `${JSON.stringify(persona === 'ae' ? aeSeedOverlay(raw) : raw, null, 2)}\n`);
  return file;
}
