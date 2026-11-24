// The example seed's world: time helpers, people, accounts, opps, assets, initiatives, calendar. Split from build-example-seed.ts (max-lines).
import type { SeedInput } from '../src/contract';

export type In = SeedInput;
export type WI = In['workItems'][number];
export type DraftIn = In['drafts'][number];
export type NbaIn = In['nbas'][number];
// ---------------------------------------------------------------------------
// time helpers (Mountain Time: MST = UTC-7 in November)
// ---------------------------------------------------------------------------
const BASE = { y: 2026, m: 10, d: 5 };
 // month is 0-based
/** Instant on day `off` (0 = Thu Nov 5) at local HH:MM MT. */
export const t = (off: number, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(BASE.y, BASE.m, BASE.d + off, h + 7, m)).toISOString();
};
export const day = (off: number) => t(off, '12:00').slice(0, 10);
export const NOW = t(0, '09:02');
// ---------------------------------------------------------------------------
// people / accounts / opps
// ---------------------------------------------------------------------------
export const me = { id: 'p_me', name: 'Jordan Lee', email: 'jordan.lee@example.com' };
export const P = {
  priya: { id: 'p_priya', name: 'Priya Shah', role: 'Manager', isManager: true },
  dana: { id: 'p_dana', name: 'Dana Reyes', role: 'ACME · Director of Data', isExternal: true },
  raj: { id: 'p_raj', name: 'Raj Mehta', role: 'AE · ACME' },
  marcus: { id: 'p_marcus', name: 'Marcus Webb', role: 'Globex · VP Platform', isExternal: true },
  elena: { id: 'p_elena', name: 'Elena Cruz', role: 'AE · Globex' },
  peter: { id: 'p_peter', name: 'Peter Gibbons', role: 'Initech · Data Lead', isExternal: true },
  alice: { id: 'p_alice', name: 'Alice Abernathy', role: 'Umbrella · Chief Architect', isExternal: true },
  nora: { id: 'p_nora', name: 'Nora Patel', role: 'Hooli · Head of AI', isExternal: true },
  leo: { id: 'p_leo', name: 'Leo Park', role: 'PM · Nimbus Context Engine' },
  ravi: { id: 'p_ravi', name: 'Ravi Menon', role: 'SE · Beacon' },
  kim: { id: 'p_kim', name: 'Kim Tran', role: 'SE · peer' },
  morgan: { id: 'p_morgan', name: 'Morgan Hale', role: 'Specialist AE · Data Cloud' },
};
export const people: In['people'] = [
  { ...P.priya, email: 'priya.shah@example.com', slackHandle: 'U0PRIYA', accountId: null },
  { ...P.dana, email: 'dana.reyes@acme.example', slackHandle: 'U0DANA', accountId: 'acc_acme' },
  { ...P.raj, email: 'raj.mehta@example.com', slackHandle: 'U0RAJ', accountId: null },
  { ...P.marcus, email: 'marcus.webb@globex.example', accountId: 'acc_globex' },
  { ...P.elena, email: 'elena.cruz@example.com', slackHandle: 'U0ELENA', accountId: null },
  { ...P.peter, email: 'peter.gibbons@initech.example', accountId: 'acc_initech' },
  { ...P.alice, email: 'alice@umbrella.example', accountId: 'acc_umbrella' },
  { ...P.nora, email: 'nora.patel@hooli.example', slackHandle: 'U0NORA', accountId: 'acc_hooli' },
  { ...P.leo, email: 'leo.park@example.com', slackHandle: 'U0LEO', accountId: null },
  { ...P.ravi, email: 'ravi.menon@example.com', slackHandle: 'U0RAVI', accountId: null },
  { ...P.kim, email: 'kim.tran@example.com', slackHandle: 'U0KIM', accountId: null },
  { ...P.morgan, email: 'morgan.hale@example.com', slackHandle: 'U0MORGAN', accountId: null },
];
/** A placeholder Org62 record link (fake 001XX… / 006XX… ids on a `.test` host). */
const org62Link = (object: 'Account' | 'Opportunity', id: string) => `https://org62.example.test/lightning/r/${object}/${id}/view`;
export const accounts: In['accounts'] = [
  { id: 'acc_acme', name: 'ACME Corp', industry: 'Manufacturing', dcStatus: 'assigned', vdpStatus: 'linked', hoursQtd: 41.5, team: [P.raj], notes: 'Phase 1 live since August; Phase 2 is headless.', org62Url: org62Link('Account', '001XX0000SEED01AAA') },
  { id: 'acc_globex', name: 'Globex', industry: 'Financial Services', dcStatus: 'partial', vdpStatus: 'linked', hoursQtd: 28, team: [P.elena], org62Url: org62Link('Account', '001XX0000SEED02AAA') },
  { id: 'acc_initech', name: 'Initech', industry: 'Software', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 6.5, team: [], org62Url: org62Link('Account', '001XX0000SEED03AAA') },
  { id: 'acc_umbrella', name: 'Umbrella Health', industry: 'Healthcare', dcStatus: 'partial', vdpStatus: 'stale', hoursQtd: 19.25, team: [] },
  { id: 'acc_hooli', name: 'Hooli', industry: 'Technology', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 12, team: [] },
  // D-69 company identity (src/mock/vdp.ts gives them their Org62 parents and VDP's companies): a " - org/product" child
  // of Globex (one company with it), a subsidiary brand under a parent outside my book (kept separate), a child whose
  // name matches two VDP companies (Needs you), and one you mapped with Change… (Soylent Corporation)
  { id: 'acc_globex_mc', name: 'Globex - Marketing Cloud', industry: 'Financial Services', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: org62Link('Account', '001XX0000SEED06AAA') },
  { id: 'acc_nexus', name: 'Nexus Care', industry: 'Healthcare', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: org62Link('Account', '001XX0000SEED07AAA') },
  { id: 'acc_cyberdyne', name: 'Cyberdyne Systems - Robotics', industry: 'Manufacturing', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: org62Link('Account', '001XX0000SEED08AAA') },
  { id: 'acc_soylent', name: 'Soylent Foods', industry: 'Consumer Goods', dcStatus: 'assigned', vdpStatus: 'none', hoursQtd: 0, team: [], org62Url: org62Link('Account', '001XX0000SEED09AAA') },
];
/**
 * My DC on an opp as the Org62 scans read it (D-63: an open opp where it is 100% belongs in my VDPs; 50% creates
 * nothing). Placeholder Deal_Contribution__c ids.
 */
const dc = (n: number, split: number) => ({ split, role: 'AI + Data Architect', org62DcId: `a0XXSEEDDC${String(n).padStart(4, '0')}AAA`, lastSeenAt: t(-1, '06:00') });
const opp = (o: Partial<In['opps'][number]> & Pick<In['opps'][number], 'id' | 'accountId' | 'name' | 'stage' | 'amount' | 'closeDate'>): In['opps'][number] => ({
  isOpen: true,
  isMine: true,
  dcAssigned: true,
  vdpLinked: false,
  hoursQtd: 0,
  nextStep: null,
  products: ['Data 360'],
  owner: null,
  org62Url: null,
  updatedAt: t(-1, '17:00'),
  ...o,
});
// Org62 opp ids are the placeholders the mock already shows for these opps (src/mock/org62-opps.ts mockOrg62IdFor)
export const opps: In['opps'] = [
  opp({ id: 'opp_acme_p2', accountId: 'acc_acme', name: 'ACME · Headless Phase 2', stage: 'Solution Design', amount: 850_000, closeDate: day(40), vdpLinked: true, hoursQtd: 30, nextStep: 'Phase 2 demo today 13:00', products: ['Data 360', 'Agentforce'], owner: P.raj, forecastCategory: 'Best Case', org62Url: org62Link('Opportunity', '006XXoppacmep20AAA'), myDc: dc(1, 100) }),
  opp({ id: 'opp_acme_af', accountId: 'acc_acme', name: 'ACME · Agentforce Service', stage: 'Discovery', amount: 320_000, closeDate: day(86), hoursQtd: 11.5, owner: P.raj, products: ['Agentforce'], forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppacmeaf0AAA'), myDc: dc(2, 100) }),
  opp({ id: 'opp_globex_d360', accountId: 'acc_globex', name: 'Globex · Data 360 Expansion', stage: 'Negotiation', amount: 1_200_000, closeDate: day(23), vdpLinked: true, hoursQtd: 22, nextStep: 'Revised SOW pricing to Marcus', owner: P.elena, forecastCategory: 'Commit', org62Url: org62Link('Opportunity', '006XXoppglobexdAAA'), myDc: dc(3, 100) }),
  opp({ id: 'opp_globex_renew', accountId: 'acc_globex', name: 'Globex · Renewal FY27', stage: 'Proposal', amount: 400_000, closeDate: day(71), isMine: false, dcAssigned: false, owner: P.elena, forecastCategory: 'Best Case' }),
  opp({ id: 'opp_initech_pilot', accountId: 'acc_initech', name: 'Initech · D360 Pilot', stage: 'Qualification', amount: 150_000, closeDate: day(45), hoursQtd: 6.5, forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppinitechAAA'), myDc: dc(4, 100) }),
  opp({ id: 'opp_umbrella_c360', accountId: 'acc_umbrella', name: 'Umbrella · Patient 360', stage: 'Technical Validation', amount: 640_000, closeDate: day(30), vdpLinked: true, hoursQtd: 15, forecastCategory: 'Best Case', myDc: dc(5, 50) }),
  opp({ id: 'opp_umbrella_af', accountId: 'acc_umbrella', name: 'Umbrella · Agentforce Care', stage: 'Discovery', amount: 280_000, closeDate: day(115), dcAssigned: false, hoursQtd: 4.25, products: ['Agentforce'] }),
  opp({ id: 'opp_hooli_nce', accountId: 'acc_hooli', name: 'Hooli · Nimbus Context Engine', stage: 'Solution Design', amount: 500_000, closeDate: day(66), hoursQtd: 12, products: ['Agentforce', 'Data 360'], forecastCategory: 'Pipeline' }),
  opp({ id: 'opp_hooli_data', accountId: 'acc_hooli', name: 'Hooli · Data Cloud Add-on', stage: 'Prospecting', amount: 90_000, closeDate: day(130), isMine: false, dcAssigned: false, forecastCategory: 'Pipeline', team: [{ ...P.morgan, org62UserId: '005XX0000SEEDMHAAA' }] }),
  // D-69: one open 100%-DC opp each, so each needs a VDP company; closing after next quarter, so the Specialist
  // Forecast checks (this and next quarter) don't count them
  opp({ id: 'opp_globex_mc', accountId: 'acc_globex_mc', name: 'Globex MC · Data 360 Activation', stage: 'Discovery', amount: 210_000, closeDate: day(200), forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppglobmcdAAA'), myDc: dc(6, 100) }),
  opp({ id: 'opp_nexus', accountId: 'acc_nexus', name: 'Nexus Care · Member 360', stage: 'Qualification', amount: 180_000, closeDate: day(210), forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppnexuscdAAA'), myDc: dc(7, 100) }),
  opp({ id: 'opp_cyberdyne', accountId: 'acc_cyberdyne', name: 'Cyberdyne · Agentforce Ops', stage: 'Discovery', amount: 260_000, closeDate: day(220), products: ['Agentforce'], forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppcyberdyAAA'), myDc: dc(8, 100) }),
  opp({ id: 'opp_soylent', accountId: 'acc_soylent', name: 'Soylent · Data 360 Pilot', stage: 'Qualification', amount: 120_000, closeDate: day(230), forecastCategory: 'Pipeline', org62Url: org62Link('Opportunity', '006XXoppsoylentAAA'), myDc: dc(9, 100) }),
];
export const missedOpps: In['missedOpps'] = [
  { id: 'mo_globex_renew', verdict: 'claim', oppId: 'opp_globex_renew', oppName: 'Globex · Renewal FY27', accountName: 'Globex', amount: 400_000, stage: 'Proposal', closeDate: day(71), evidence: ['Data 360 product line', 'Your account, no DC on this opp', 'You attended 2 meetings on it'], otherDcs: [], status: 'new', foundAt: t(0, '02:00') },
  { id: 'mo_hooli_data', verdict: 'claim', oppId: 'opp_hooli_data', oppName: 'Hooli · Data Cloud Add-on', accountName: 'Hooli', amount: 90_000, stage: 'Prospecting', closeDate: day(130), evidence: ['Data Cloud SKU', 'Your account', 'Slack channel you work in (#hooli-data-cloud, 4 messages)'], otherDcs: [], status: 'new', foundAt: t(0, '02:00') },
  { id: 'mo_initech_tab', verdict: 'check', oppId: null, oppName: 'Initech · Tableau Next', accountName: 'Initech', amount: 120_000, stage: 'Discovery', closeDate: day(90), evidence: ['Mentions Data 360 in next steps', 'Another SE holds a DC'], otherDcs: ['Kim Tran'], status: 'new', foundAt: t(0, '02:00') },
  { id: 'mo_umbrella_mc', verdict: 'check', oppId: null, oppName: 'Umbrella · Marketing Cloud D360 seats', accountName: 'Umbrella Health', amount: 60_000, stage: 'Prospecting', closeDate: day(150), evidence: ['D360 seats line item'], otherDcs: [], status: 'dismissed', dismissReason: 'Marketing SE owns it', foundAt: t(-7, '02:00') },
];
// ---------------------------------------------------------------------------
// assets / initiatives
// ---------------------------------------------------------------------------
const asset = (a: Partial<In['assets'][number]> & Pick<In['assets'][number], 'id' | 'kind' | 'title'>): In['assets'][number] => ({ source: 'drive', updatedAt: t(-1, '16:00'), updatedBy: me.name, url: `https://docs.example.com/${a.id}`, ...a });
export const assets: In['assets'] = [
  asset({ id: 'as_acme_deck', kind: 'slides', title: 'ACME Phase 2 demo deck', initiativeId: 'ini_acme_p2', accountId: 'acc_acme' }),
  asset({ id: 'as_acme_onepager', kind: 'doc', title: 'ACME architecture one-pager', initiativeId: 'ini_acme_p2', accountId: 'acc_acme', updatedAt: t(-2, '11:00') }),
  asset({ id: 'as_acme_recap', kind: 'slides', title: 'ACME Phase 1 recap slides', initiativeId: 'ini_acme_p2', accountId: 'acc_acme', updatedAt: t(-1, '15:50') }),
  asset({ id: 'as_acme_org', kind: 'demo_org', title: 'acme-phase2 demo org', source: 'manual', url: 'https://acme-phase2.example.my.site.com', initiativeId: 'ini_acme_p2', accountId: 'acc_acme' }),
  asset({ id: 'as_globex_sow', kind: 'doc', title: 'Globex SOW v3 (pricing)', initiativeId: 'ini_globex', accountId: 'acc_globex', updatedBy: 'Elena Cruz' }),
  asset({ id: 'as_globex_est', kind: 'sheet', title: 'Globex D360 consumption estimate', initiativeId: 'ini_globex', accountId: 'acc_globex' }),
  asset({ id: 'as_umbrella_deck', kind: 'slides', title: 'Umbrella architecture review deck', accountId: 'acc_umbrella', updatedAt: t(-3, '10:00') }),
  asset({ id: 'as_hooli_plan', kind: 'doc', title: 'Hooli NCE evaluation plan', initiativeId: 'ini_hooli', accountId: 'acc_hooli', updatedAt: t(0, '08:40') }),
  asset({ id: 'as_hooli_refarch', kind: 'pdf', title: 'Hooli NCE reference architecture', initiativeId: 'ini_hooli', accountId: 'acc_hooli' }),
  asset({ id: 'as_nce_questions', kind: 'doc', title: 'NCE open questions (team)', updatedBy: 'Kim Tran' }),
  asset({ id: 'as_nce_session', kind: 'claude_session', title: 'NCE gaps notes', source: 'claude', url: 'claude://code/continue?session=mock-nce-gaps', updatedAt: t(-1, '12:30') }),
];
export const initiatives: In['initiatives'] = [
  {
    id: 'ini_acme_p2',
    version: 1,
    title: 'ACME Headless Phase 2 demo',
    purpose: 'Win the Phase 2 technical decision: headless Data 360 + Agentforce on ACME’s own portal.',
    summary: 'Dana’s team wants to see agent answers grounded in their unified profiles, rendered in their React portal. Today’s 13:00 demo is the technical gate before Raj sends pricing.',
    status: 'active',
    accountId: 'acc_acme',
    oppId: 'opp_acme_p2',
    targetEventId: 'ev_acme_demo',
    people: [P.dana, P.raj],
    assetIds: ['as_acme_deck', 'as_acme_onepager', 'as_acme_recap', 'as_acme_org'],
    timeline: [
      { at: t(-3, '10:00'), label: 'Discovery workshop with Dana’s team', source: { kind: 'calendar', label: 'Calendar · ACME workshop' } },
      { at: t(-1, '16:00'), label: 'Phase 1 recap slides updated', source: { kind: 'drive', label: 'Drive · recap slides' } },
      { at: t(0, '07:55'), label: 'Dana asked to confirm demo scope', source: { kind: 'slack', label: '#acme-ext · thread' } },
    ],
    createdAt: t(-20, '09:00'),
    updatedAt: t(0, '07:55'),
  },
  {
    id: 'ini_globex',
    version: 1,
    title: 'Globex Data 360 expansion close',
    purpose: 'Close the $1.2M expansion this month: pricing, DPA and consumption estimate.',
    summary: 'Negotiation stage. Marcus needs revised SOW pricing and a consumption estimate; legal is reviewing the DPA.',
    status: 'active',
    accountId: 'acc_globex',
    oppId: 'opp_globex_d360',
    people: [P.marcus, P.elena],
    assetIds: ['as_globex_sow', 'as_globex_est'],
    timeline: [{ at: t(0, '08:30'), label: 'Missed the pricing sync (2 takeaways)', source: { kind: 'gemini', label: 'Gemini notes · pricing sync' } }],
    createdAt: t(-30, '09:00'),
    updatedAt: t(0, '08:35'),
  },
  {
    id: 'ini_hooli',
    version: 1,
    title: 'Hooli Nimbus Context Engine evaluation',
    purpose: 'Get Hooli to a scoped NCE evaluation with success criteria by end of month.',
    summary: 'Nora’s team is comparing NCE with a home-grown retrieval layer. They want a reference architecture and an evaluation plan.',
    status: 'active',
    accountId: 'acc_hooli',
    oppId: 'opp_hooli_nce',
    targetEventId: 'ev_hooli',
    people: [P.nora, P.leo],
    assetIds: ['as_hooli_plan', 'as_hooli_refarch'],
    createdAt: t(-10, '09:00'),
    updatedAt: t(0, '08:40'),
  },
];
// ---------------------------------------------------------------------------
// calendar
// ---------------------------------------------------------------------------
const cal = (e: Partial<In['calendar']['events'][number]> & Pick<In['calendar']['events'][number], 'id' | 'title' | 'start' | 'end'>): In['calendar']['events'][number] => ({
  attendance: 'upcoming',
  source: { kind: 'calendar', label: 'Google Calendar', externalId: e.id },
  ...e,
});
// Invite details (placeholders): who sent it, each guest's answer, the agenda as plain text, attached files.
const mine = { name: me.name, personId: null, isMe: true, isExternal: false };
const sentBy = (p: { id: string; name: string; isExternal?: boolean }) => ({ name: p.name, personId: p.id, isMe: false, isExternal: !!p.isExternal });
export const events: In['calendar']['events'] = [
  // earlier this week (Time page)
  cal({ id: 'ev_mon_acme', title: 'ACME discovery workshop', start: t(-3, '10:00'), end: t(-3, '12:00'), attendance: 'attended', isCustomerFacing: true, accountId: 'acc_acme', oppId: 'opp_acme_p2' }),
  cal({ id: 'ev_tue_globex', title: 'Globex exec briefing', start: t(-2, '14:00'), end: t(-2, '15:00'), attendance: 'attended', isCustomerFacing: true, accountId: 'acc_globex', oppId: 'opp_globex_d360' }),
  cal({ id: 'ev_wed_umbrella', title: 'Umbrella technical deep dive', start: t(-1, '09:00'), end: t(-1, '10:30'), attendance: 'attended', isCustomerFacing: true, accountId: 'acc_umbrella', oppId: 'opp_umbrella_c360' }),
  cal({ id: 'ev_wed_hooli', title: 'Hooli onsite', start: t(-1, '13:00'), end: t(-1, '17:00'), attendance: 'attended', isCustomerFacing: true, accountId: 'acc_hooli', oppId: 'opp_hooli_nce', location: 'Hooli HQ' }),
  // today
  cal({ id: 'ev_standup', title: 'SE team stand-up', start: t(0, '08:00'), end: t(0, '08:30'), attendance: 'attended', attendees: [{ ...P.priya, response: 'accepted', organizer: true }, { ...P.kim, response: 'accepted', optional: true }], organizer: sentBy(P.priya), agenda: 'Round the room: yesterday, today, blockers.' }),
  cal({ id: 'ev_globex_pricing', title: 'Globex pricing sync', start: t(0, '08:30'), end: t(0, '09:00'), attendance: 'missed', isCustomerFacing: true, accountId: 'acc_globex', oppId: 'opp_globex_d360', attendees: [P.marcus, P.elena], takeaways: { count: 2, workItemIds: ['w_globex_discount', 'w_globex_estimate'], notesUrl: 'https://docs.example.com/gemini-globex-pricing' } }),
  cal({ id: 'ev_priya_1on1', title: '1:1 with Priya', start: t(0, '09:30'), end: t(0, '10:00'), attendees: [{ ...P.priya, response: 'accepted', organizer: true }], organizer: sentBy(P.priya), agenda: 'Q4 forecast notes\nTraining plan for next quarter', prep: { ready: true, label: 'prep ready ›', workItemId: 'w_priya_forecast' } }),
  cal({ id: 'ev_initech', title: 'Initech discovery call', start: t(0, '10:30'), end: t(0, '11:30'), isCustomerFacing: true, accountId: 'acc_initech', oppId: 'opp_initech_pilot', attendees: [{ ...P.peter, response: 'accepted' }], organizer: mine, agenda: 'Goals for the pilot\nCurrent data landscape and sources\nTimeline and decision process', meetingUrl: 'https://meet.example.com/initech', prep: { ready: false, label: 'prep: 20m ›', workItemId: 'w_initech_prep' } }),
  cal({ id: 'ev_lunch_nce', title: 'Lunch & learn: Nimbus Context Engine', start: t(0, '12:00'), end: t(0, '12:30'), attendees: [{ ...P.leo, response: 'accepted', organizer: true }], organizer: sentBy(P.leo), agenda: 'A 20-minute tour of the context engine, then Q&A. Slides: https://docs.example.com/nce-lunch-learn', meetingUrl: 'https://meet.example.com/nce-lunch' }),
  cal({
    id: 'ev_acme_demo',
    title: 'ACME Phase 2 demo',
    start: t(0, '13:00'),
    end: t(0, '14:00'),
    isCustomerFacing: true,
    accountId: 'acc_acme',
    oppId: 'opp_acme_p2',
    attendees: [{ ...P.dana, response: 'accepted', organizer: true }, { ...P.raj, response: 'tentative' }],
    organizer: sentBy(P.dana),
    agenda: 'Goal: the Phase 2 portal end to end, on ACME data\n• Headless portal walkthrough (15 min)\n• Service-agent handoff: Phase 3, scope only\n• Next steps and pilot timeline\n\nDemo script: https://docs.example.com/acme-demo-script',
    attachments: [{ title: 'ACME Phase 2 demo script', url: 'https://docs.example.com/acme-demo-script', kind: 'doc' }],
    meetingUrl: 'https://meet.example.com/acme',
    prep: { ready: false, label: 'demo org building ›', workItemId: 'w_acme_build' },
  }),
  cal({ id: 'ev_umbrella', title: 'Umbrella architecture review', start: t(0, '14:30'), end: t(0, '15:00'), isCustomerFacing: true, accountId: 'acc_umbrella', oppId: 'opp_umbrella_c360', attendees: [{ ...P.alice, response: 'needs_action' }], organizer: mine, agenda: 'Walk through the target architecture: FHIR ingestion and the HIPAA controls Alice asked about.', attachments: [{ title: 'Umbrella architecture review deck', url: 'https://docs.example.com/as_umbrella_deck', kind: 'deck' }], prep: { ready: false, label: 'deck needs updates ›', workItemId: 'w_umbrella_deck' } }),
  cal({ id: 'ev_hooli', title: 'Hooli NCE scoping', start: t(0, '15:30'), end: t(0, '16:00'), isCustomerFacing: true, accountId: 'acc_hooli', oppId: 'opp_hooli_nce', attendees: [{ ...P.nora, response: 'tentative', organizer: true }], organizer: sentBy(P.nora), agenda: 'Scope the NCE evaluation: success criteria, data sets, timeline.', prep: { ready: false, label: 'talk track ›', workItemId: 'w_hooli_talktrack' } }),
  cal({ id: 'ev_retro', title: 'SE team retro', start: t(0, '16:30'), end: t(0, '17:00'), attendance: 'declined', attendees: [P.priya] }),
  // D-64: an internal session (no customer, no account: internal-only activity), and a meeting I declined (never on Time)
  cal({ id: 'ev_mon_cert', title: 'Data Cloud certification study group', start: t(-3, '15:00'), end: t(-3, '16:00'), attendance: 'attended', attendees: [{ ...P.kim, response: 'accepted', organizer: true }], organizer: sentBy(P.kim) }),
  cal({ id: 'ev_tue_declined', title: 'Partner office hours', start: t(-2, '11:00'), end: t(-2, '12:00'), attendance: 'declined', attendees: [{ ...P.leo, response: 'accepted', organizer: true }], organizer: sentBy(P.leo) }),
  // tomorrow
  cal({ id: 'ev_fri_globex', title: 'Globex legal + DPA review', start: t(1, '10:00'), end: t(1, '11:00'), isCustomerFacing: true, accountId: 'acc_globex', oppId: 'opp_globex_d360' }),
];
export const slots: In['calendar']['slots'] = [
  { id: 'sl_kickoff', kind: 'work', start: t(0, '09:05'), end: t(0, '09:25'), label: '09:05 ▶ Kick off ACME demo-org build', workItemId: 'w_acme_build' },
  { id: 'sl_gap_1000', kind: 'gap', start: t(0, '10:00'), end: t(0, '10:30'), label: '10:00 30m gap: fits Reply to Dana', workItemId: 'w_dana_reply' },
  { id: 'sl_gap_1130', kind: 'gap', start: t(0, '11:30'), end: t(0, '12:00'), label: '11:30 30m gap: fits Training', workItemId: 'w_training_af' },
  { id: 'sl_prep_1230', kind: 'work', start: t(0, '12:30'), end: t(0, '13:00'), label: '12:30 ▶ Final ACME demo run-through', workItemId: 'w_acme_build' },
  { id: 'sl_gap_1400', kind: 'gap', start: t(0, '14:00'), end: t(0, '14:30'), label: '14:00 30m gap', workItemId: null },
  { id: 'sl_focus_1700', kind: 'focus', start: t(0, '17:00'), end: t(0, '18:00'), label: '17:00 Focus: Globex SOW', workItemId: 'w_globex_sow' },
];
