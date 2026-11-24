/**
 * PLACEHOLDER fixtures shaped from the real autopilot formats. No real names, ids or amounts:
 * ACME / Globex / Initech, user@example.com, 005/006/001 + PLACEHOLDER ids.
 */
import type { ActivityConfig, ActivityEntry, ActivityMappings, CalendarEvidence, Org62EventRow } from '@/engines/activity/types';
import { newEntry } from '@/engines/activity/entry';

export const OWNER = '005PLACEHOLDER0001';
export const RT = '012PLACEHOLDER0001';
export const OPP_ACME = '006PLACEHOLDER0001';
export const OPP_GLOBEX = '006PLACEHOLDER0002';
export const ACCT_INITECH = '001PLACEHOLDER0003';

export const CFG: ActivityConfig = {
  timezone: 'America/Denver',
  ownerId: OWNER,
  recordTypeId: RT,
  lightningHost: 'https://example.lightning.force.com',
  workday: { start: '08:00', end: '17:30' },
  hoursTarget: 250,
  liveFrom: '2026-09-15',
  evidence: { minBlockH: 0.25 },
  quarters: [
    { name: 'FY27 Q3', start: '2026-08-01', end: '2026-10-31', deadline: '2026-10-30T12:00:00-07:00' },
    { name: 'FY27 Q4', start: '2026-11-01', end: '2027-01-31', deadline: '2027-01-29T12:00:00-08:00' },
  ],
};

export const MAPPINGS: ActivityMappings = {
  accounts: [
    { key: 'acme', match: 'acme', domains: ['acme.example'], whatId: OPP_ACME, whatType: 'Opportunity', whatName: 'ACME - Data 360 Expansion', team: true },
    { key: 'globex', match: 'globex', domains: ['globex.example'], whatId: OPP_GLOBEX, whatType: 'Opportunity', whatName: 'Globex - Agent Rollout', team: true },
    { key: 'initech', match: 'initech', domains: ['initech.example'], whatId: ACCT_INITECH, whatType: 'Account', whatName: 'Initech' },
  ],
  repos: { 'Projects-acme-demo': 'acme', 'Projects-globex-poc': 'globex' },
  channels: { C0PLACEHOLDER1: 'acme' },
  neitherRepos: { 'Projects-demo-org': 'Asset Creation' },
  internalDomains: ['corp.example'],
  partnerDomains: ['partner.example'],
  ignoreDomains: ['calendar.example'],
  overrides: [],
};

export const cal = (p: Partial<CalendarEvidence> & Pick<CalendarEvidence, 'id' | 'summary' | 'startsAt' | 'endsAt'>): CalendarEvidence => ({
  selfResponse: 'accepted',
  attendeeDomains: ['corp.example'],
  ...p,
});

/** Org62 Solutions Event mirror row. */
export const ev62 = (p: Partial<Org62EventRow> & Pick<Org62EventRow, 'org62EventId' | 'startsAt' | 'endsAt'>): Org62EventRow => ({
  recordTypeName: 'Solutions Event',
  subject: 'x',
  durationField: 1,
  seTaskTypeName: 'Solution Creation',
  meetingTypeName: null,
  whatOrg62Id: OPP_ACME,
  ownerId: OWNER,
  ...p,
});

export const entry = (p: Partial<ActivityEntry> & Pick<ActivityEntry, 'dedupeKey' | 'startsAt' | 'endsAt' | 'durationHours'>): ActivityEntry =>
  newEntry({
    origin: 'calendar',
    subject: 'ACME discovery',
    seTaskType: 'Customer Discovery',
    whatKind: 'opportunity',
    whatOrg62Id: OPP_ACME,
    whatName: 'ACME - Data 360 Expansion',
    status: 'approved',
    ...p,
  });

/** Fixed "now" used by most tests: Thu 2026-11-05 18:00 UTC. */
export const NOW = '2026-11-05T18:00:00Z';
