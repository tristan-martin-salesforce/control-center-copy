/**
 * Personas (D-55), the foundation: one definition per id; the SE preset is exactly what the app did before personas;
 * a user with no persona section reads as SE (level from profile.role); a persona preconfigures and never takes
 * anything away (inactive features and sources are available to activate); the Persona block is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { SE_TASK_TYPES } from '@/engines/activity/taxonomy';
import { PersonaId, PersonaSettings, Settings, SETTINGS_SECTION_SCHEMAS, SettingsSectionKey } from '@/contract';
import { SCAN_CONNECTORS } from '@/jobs';
import { AE_POLICY, ROLE_POLICIES } from '@/engines/priority/policy';
import { allows, ALL_CONNECTORS, fillThresholds, PERSONAS, personaOf, READ_PAGE_GATES, renderPersonaBlock, roleTitle, ROUTE_GATES } from '@/personas';
import { routes } from '@/contract';
import { defaultSections, rolePolicy, templateFor, BootstrapProfile } from '@/server/datasource/db/bootstrap';
import { createMockDataSource } from '@/server/datasource/mock';

describe('the registry', () => {
  it('has exactly one definition per persona id, and every level names a starter policy that exists', () => {
    expect(Object.keys(PERSONAS).sort()).toEqual([...PersonaId.options].sort());
    for (const p of Object.values(PERSONAS)) {
      expect(Object.keys(p.levels).length).toBeGreaterThan(0);
      for (const l of Object.values(p.levels)) expect(ROLE_POLICIES[l!.priorityTemplate]).toBeDefined();
      for (const c of p.connectors) expect(ALL_CONNECTORS).toContain(c);
      // rule text only names thresholds the persona has
      const keys = new Set(p.thresholds.map((t) => t.key));
      for (const r of p.rules) for (const [, k] of r.text.matchAll(/\{([A-Za-z0-9_]+)\}/g)) expect(keys.has(k!), `${p.id}.${r.id}: {${k}}`).toBe(true);
    }
  });

  it('the SE preset is what the app did before personas', () => {
    const se = PERSONAS.se;
    expect([...se.connectors].sort()).toEqual([...SCAN_CONNECTORS].sort());
    expect(se.org62Scopes).toEqual(['opps', 'events', 'dcs', 'book', 'missed_opps']);
    // + D-59: Home ▸ Log & fix says how many VDPs need you (the VDP feature's own rule); + 2026-11-13 audit C2: DCs and
    // use cases waiting for a canvas
    expect(se.gapRules).toEqual(['connector_auth', 'quarter_log', 'org62_unlogged', 'missed_dc', 'needs_input', 'expenses', 'vdp_open', 'canvas_waiting']);
    // + D-18 amended (2026-11-11): every accepted meeting logs, the default for every persona
    // 2026-11-14: no hour caps (grounded in truth)
    expect(se.logging).toEqual({ recordType: { field: 'Name', value: 'Solutions Event' }, taskTypeRequired: true, hoursTargetH: 250, overlaps: 'log_all_accepted', taskTypes: SE_TASK_TYPES, internalActivity: true });
    expect(PERSONAS.ae.logging.overlaps).toBe('log_all_accepted');
    const r = personaOf({ profile: { role: 'se_ic' } });
    expect(r.connectors).toEqual([...ALL_CONNECTORS]);
    expect(r.availableConnectors).toEqual([]);
    expect(r.features).toMatchObject({ vdp: true, activityLogging: true, dealContributions: true, missedOpps: true, specialistForecast: false });
  });
});

describe('personaOf', () => {
  it('no section: the SE persona, level from profile.role', () => {
    expect(personaOf({ profile: { role: 'se_ic' } })).toMatchObject({ id: 'se', level: 'ic', levelLabel: 'SE', priorityTemplate: 'se_ic' });
    expect(personaOf({ profile: { role: 'se_manager' } })).toMatchObject({ id: 'se', level: 'manager', priorityTemplate: 'se_manager' });
    expect(personaOf({})).toMatchObject({ id: 'se', level: 'ic' });
    // a level the persona lacks falls back to its first
    expect(personaOf({ persona: { id: 'ae', level: 'manager' } })).toMatchObject({ id: 'ae', level: 'ic', priorityTemplate: 'ae' });
  });

  it('AE: VDP, DCs and missed opps are available, not preconfigured; activating VDP brings its source back', () => {
    const ae = personaOf({ persona: { id: 'ae' } });
    expect(ae.features).toMatchObject({ specialistForecast: true, activityLogging: true, vdp: false, dealContributions: false, missedOpps: false });
    expect(ae.connectors).not.toContain('vdp');
    expect(ae.availableConnectors).toEqual(['vdp']);
    expect(ae.org62Scopes).toEqual(['opps', 'events', 'book']);
    expect(ae.logging.recordType).toEqual({ field: 'DeveloperName', value: 'SalesEvents' });
    const on = personaOf({ persona: { id: 'ae', features: { vdp: true } } });
    expect(on.features.vdp).toBe(true);
    expect(on.connectors).toContain('vdp');
    expect(on.changedFeatures).toEqual(['vdp']);
    // a source switched off on its own
    expect(personaOf({ persona: { id: 'ae', connectors: { trainings: false } } }).availableConnectors).toEqual(['trainings', 'vdp']);
    // a preset feature switched off hides its rules and duties
    const off = personaOf({ persona: { id: 'se', features: { vdp: false } } });
    expect(off.connectors).not.toContain('vdp');
    expect(off.rules.find((r) => r.id === 'vdp_current')!.enabled).toBe(false);
    expect(off.duties.find((d) => d.id === 'se.vdp')!.active).toBe(false);
  });

  it('rules: the preset, edits on top, then your own; thresholds per person', () => {
    const p = personaOf({
      persona: { id: 'ae', rules: { promises: { enabled: false }, deal_role_never_none: { text: 'Deal Role is at least Assist on deals of {dealRoleMinAcvUsd}' } }, customRules: [{ id: 'rvp', text: 'RVP asks are due today', enabled: true }], thresholds: { staleNotesMinAmountUsd: 250_000 } },
    });
    expect(p.rules.find((r) => r.id === 'promises')).toMatchObject({ enabled: false, edited: true });
    expect(p.rules.find((r) => r.id === 'deal_role_never_none')).toMatchObject({ text: 'Deal Role is at least Assist on deals of {dealRoleMinAcvUsd}', edited: true });
    expect(p.rules.at(-1)).toMatchObject({ id: 'custom:rvp', custom: true, enabled: true });
    expect(p.thresholds).toMatchObject({ staleNotesMinAmountUsd: 250_000, staleNotesDays: 7, notesDueWeekday: 1 });
    expect(fillThresholds('{staleNotesMinAmountUsd} by {notesDueWeekday} {notesDueAt}, {unknown}', p.thresholds)).toBe('$250,000 by Monday 09:00, {unknown}');
  });
});

describe('gates', () => {
  it('nothing gated shows while the persona loads; VDP surfaces follow the feature', () => {
    expect(allows(null, { feature: 'vdp' })).toBe(false);
    expect(allows(null, undefined)).toBe(true);
    const ae = personaOf({ persona: { id: 'ae' } });
    const se = personaOf({});
    for (const g of [READ_PAGE_GATES.vdp, ROUTE_GATES.getVdpCoverage]) {
      expect(allows(ae, g)).toBe(false);
      expect(allows(se, g)).toBe(true);
    }
    for (const k of Object.keys(ROUTE_GATES)) expect(routes).toHaveProperty(k);
  });
});

describe('the Persona block', () => {
  it('is deterministic and names the role, its active duties, rules with thresholds filled, and the sources', () => {
    const a = renderPersonaBlock(personaOf({ persona: { id: 'ae' } }));
    expect(a).toBe(renderPersonaBlock(personaOf({ persona: { id: 'ae' } })));
    expect(a).toContain('Role: Specialist AE, one Salesforce Data 360 Specialist Account Executive (AE).');
    expect(a).toContain('$100,000');
    expect(a).not.toContain('VDP');
    expect(a).toContain('record type SalesEvents');
    const s = renderPersonaBlock(personaOf({}));
    expect(s).toContain('each with an SE task type, 250 h a quarter');
    expect(s).toContain('Role: SE (Solutions Engineer), one Salesforce Solutions Engineer (SE).');
  });

  it('names a role once when its level reads the same (29-persona-qa: no "Specialist AE (Specialist AE)")', () => {
    expect(roleTitle(personaOf({ persona: { id: 'ae' } }))).toBe('Specialist AE');
    expect(roleTitle(personaOf({}))).toBe('SE (Solutions Engineer)');
    expect(roleTitle(personaOf({ persona: { id: 'se', level: 'manager' } }))).toBe('SE manager (Solutions Engineer)');
  });
});

describe('settings and bootstrap', () => {
  it('the persona, feedback and guide sections are optional on input and patchable', () => {
    expect(SettingsSectionKey.options).toEqual(expect.arrayContaining(['persona', 'feedback', 'guide']));
    expect(PersonaSettings.parse({ version: 1 })).toEqual({ version: 1, id: 'se', level: null, rules: {}, customRules: [], thresholds: {}, features: {}, connectors: {} });
    expect(SETTINGS_SECTION_SCHEMAS.persona.safeParse({ id: 'ae', thresholds: { staleNotesDays: 10 } }).success).toBe(true);
    expect(SETTINGS_SECTION_SCHEMAS.persona.safeParse({ id: 'cfo' }).success).toBe(false);
    expect(SETTINGS_SECTION_SCHEMAS.feedback.safeParse({ channelId: 'not-a-channel' }).success).toBe(false);
  });

  it('bootstrap writes the persona; an AE starts from the AE policy', () => {
    const p = BootstrapProfile.parse({ email: 'ada.placeholder@example.com', name: 'Ada Placeholder', timezone: 'America/Denver', persona: 'ae' });
    expect(defaultSections(p).persona).toMatchObject({ id: 'ae', level: 'ic' });
    expect(templateFor(p)).toBe('ae');
    expect(rolePolicy('ae', '2026-11-11T00:00:00.000Z', 'pol').policy).toMatchObject({ role: 'ae', name: AE_POLICY.name });
    const se = BootstrapProfile.parse({ email: 'ada.placeholder@example.com', name: 'Ada Placeholder', timezone: 'America/Denver', role: 'se_manager' });
    expect(defaultSections(se).persona).toMatchObject({ id: 'se', level: 'manager' });
    expect(templateFor(se)).toBe('se_manager');
  });

  it('the mock saves the persona section like any other', async () => {
    const ds = createMockDataSource({ seedPath: 'src/mock/seed.example.json', autoplay: false, clockMode: 'seed' });
    try {
      const s = Settings.parse(await ds.getSettings({} as never));
      expect(personaOf(s).id).toBe('se');
      const r = await ds.patchSettings({ params: { section: 'persona' }, body: { ifVersion: s.persona.version, value: { id: 'ae', features: { vdp: true } } } } as never);
      expect(personaOf(r.entity as Settings)).toMatchObject({ id: 'ae', features: { vdp: true } });
    } finally {
      ds.dispose();
    }
  });
});
