/**
 * Data 360 Specialist AE. Their Org62 duty is the Specialist Forecast (`SpecialistForecast__c`, a child of the core
 * opportunity, created when Flex or Data 360 SKUs attach): fresh forecast notes every week on in-quarter deals, a
 * Deal Role on every deal with ACV, and a record for every opportunity with Data 360 work. Meetings are logged as
 * Sales Events. VDP, deal contributions and missed opps are available, not preconfigured (AEs don't fill in VDP).
 */
import type { PersonaDefinition } from './types';

export const AE_PERSONA: PersonaDefinition = {
  id: 'ae',
  label: 'Specialist AE',
  summary: 'Weekly forecast notes and deal roles on Specialist Forecasts, meetings logged as Sales Events',
  preamble: 'one Salesforce Data 360 Specialist Account Executive (AE)',
  status: 'preview',
  levels: { ic: { label: 'Specialist AE', priorityTemplate: 'ae' } },
  features: { specialistForecast: true, activityLogging: true },
  connectors: ['slack', 'org62', 'gmail', 'calendar', 'drive', 'gemini_notes', 'claude_sessions', 'trainings', 'watch'],
  org62Scopes: ['opps', 'events', 'book'],
  org62Book: 'both',
  // in Home ▸ Log & fix order (after the state: overdue, blocked, at risk): the weekly forecast duty first
  gapRules: ['connector_auth', 'forecast_notes', 'deal_role', 'missing_sfr', 'org62_unlogged', 'needs_input', 'expenses', 'canvas_waiting'],
  logging: { recordType: { field: 'DeveloperName', value: 'SalesEvents' }, taskTypeRequired: false, hoursTargetH: null, overlaps: 'log_all_accepted' },
  duties: [
    { id: 'ae.reply', text: 'Answer customers, my SEs, my RVP and my manager, and keep the promises I make', cadence: 'daily' },
    { id: 'ae.notes', text: 'Every week, fresh forecast notes on my in-quarter Specialist Forecasts, biggest and furthest along first', cadence: 'weekly', feature: 'specialistForecast' },
    { id: 'ae.role', text: 'Every deal with ACV has a Deal Role (at least Aware, never None)', cadence: 'weekly', feature: 'specialistForecast' },
    { id: 'ae.missing', text: 'Every opportunity with Data 360 or Flex work has a Specialist Forecast', cadence: 'weekly', feature: 'specialistForecast' },
    { id: 'ae.log', text: 'Log customer meetings in Org62 as Sales Events', cadence: 'weekly', feature: 'activityLogging' },
    { id: 'ae.vdp', text: 'Keep VDPs current (usually the SE’s job)', cadence: 'weekly', feature: 'vdp' },
    { id: 'ae.dc', text: 'Claim Deal Contributions', cadence: 'as_needed', feature: 'dealContributions' },
  ],
  rules: [
    { id: 'promises', text: 'Anything I say I will do is a task', enabled: true },
    { id: 'direct_asks', text: 'Direct asks of me from customers, my SE, my RVP or my manager are tasks', enabled: true },
    { id: 'meeting_actions', text: 'Action items assigned to me in meeting notes are tasks', enabled: true },
    {
      id: 'forecast_notes_weekly',
      text: 'An in-quarter Specialist Forecast of at least {staleNotesMinAmountUsd} whose notes are older than {staleNotesDays} days needs fresh notes by {notesDueWeekday} {notesDueAt}',
      enabled: true,
      feature: 'specialistForecast',
    },
    { id: 'deal_role_never_none', text: 'A Specialist Forecast with ACV of at least {dealRoleMinAcvUsd} never has Deal Role None: set it to at least Aware', enabled: true, feature: 'specialistForecast' },
    { id: 'missing_sfr', text: 'An opportunity with Data 360 or Flex work but no Specialist Forecast needs one, created from its Forecast tab', enabled: true, feature: 'specialistForecast' },
    { id: 'product_asks', text: 'Asks to add Data 360 line items to an opportunity so it can be forecast are tasks', enabled: true, feature: 'specialistForecast' },
    { id: 'sales_events', text: 'Customer meetings are logged in Org62 as Sales Events', enabled: true, feature: 'activityLogging' },
  ],
  // priority@2 (lane 07 §4.4): for a Specialist AE the deal is the job (forecast emphasis: lower tier bounds, more
  // weight), partners count as customer-facing, and the weekly forecast notes are pay-linked admin
  priority: {
    template: 'ae@2',
    weights: { who: 25, deal: 35, kind: 15, importance: 15, goal: 10 },
    customerFacingTiers: ['customer', 'customer_exec', 'partner'],
    dealTiersUsd: [1, 50_000, 250_000, 750_000, 2_000_000],
    dealTierValues: [0, 0.3, 0.5, 0.7, 0.9, 1],
    replySlaWorkH: { customer_exec: 4, leader: 4, customer: 8, partner: 8, manager: 8, ae: 24, teammate: 24 },
    prepRules: [
      { id: 'customer_pricing', meetingTitlePattern: 'pricing|proposal|negotiation|close|order form', customerFacing: true, importance: 'high', readyBeforeMin: 60 },
      { id: 'forecast_call', meetingTitlePattern: '\\b(forecast|pipeline|qbr)\\b', importance: 'high', readyBeforeMin: 60 },
    ],
    admin: {
      classes: [
        { id: 'training', kinds: ['training'] },
        { id: 'logging', titlePattern: '^log\\b|\\blog (this|last) week|\\blogging\\b' },
        { id: 'forecast', titlePattern: 'forecast notes|deal role|specialist forecast' },
        { id: 'vdp', titlePattern: '\\bVDP\\b' },
        { id: 'expense', titlePattern: '\\bexpense' },
      ],
      payLinked: ['forecast', 'logging'],
      promoteWithinH: 48,
    },
  },
  thresholds: [
    { key: 'staleNotesMinAmountUsd', label: 'Forecast notes: smallest deal that needs weekly notes', unit: 'usd', default: 100_000, min: 0, feature: 'specialistForecast' },
    { key: 'staleNotesDays', label: 'Forecast notes: stale after', unit: 'days', default: 7, min: 1, max: 60, feature: 'specialistForecast' },
    { key: 'dealRoleMinAcvUsd', label: 'Deal Role: required from an ACV of', unit: 'usd', default: 1, min: 0, feature: 'specialistForecast' },
    { key: 'notesDueWeekday', label: 'Forecast notes: due on', unit: 'weekday', default: 1, min: 0, max: 6, feature: 'specialistForecast' },
    { key: 'notesDueAt', label: 'Forecast notes: due by', unit: 'hhmm', default: '09:00', feature: 'specialistForecast' },
    {
      key: 'forecastNoteTemplate',
      label: 'Forecast note format',
      unit: 'text',
      default: 'Compelling event: … · In quarter: yes/no, why · Next step (owner, date): … · Risk: …',
      feature: 'specialistForecast',
    },
  ],
};
