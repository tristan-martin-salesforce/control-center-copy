/**
 * CONTRACT-1 task 6: the contract's ToolAdapter is a view derived from the TOOLS manifest
 * (src/tools/manifest.ts). Seeds keep their legacy manifest shape and map onto the same view.
 */
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fieldsFromJsonSchema,
  requiredFieldKeys,
  Seed,
  toToolAdapter,
  toToolView,
  legacyManifestFromTools,
  ToolAdapter,
  ToolAdapterManifest,
  ToolAdapterSeedRow,
  toolViewFromLegacyManifest,
  ToolsPayload,
  ToolView,
  UNKNOWN_TOOL_HEALTH,
} from '@/contract';
import { loadManifests } from '@/tools/registry';
import type { MockDataSource } from '@/server/datasource/mock';
import { newDs, rawExampleSeed, ROOT } from './helpers';

const REG = path.join(ROOT, 'tools-registry');

describe('toToolView (TOOLS manifest → contract view)', () => {
  it('maps every committed manifest to a valid view with exactly the documented fields', async () => {
    const manifests = await loadManifests(REG);
    expect(manifests.length).toBeGreaterThanOrEqual(4);
    for (const m of manifests) {
      const v = ToolView.parse(toToolView(m));
      expect(Object.keys(v).sort()).toEqual(['description', 'estimatedDuration', 'fields', 'health', 'icon', 'id', 'launchKind', 'name', 'requiresConfirm'].sort());
      expect(v).toMatchObject({ id: m.id, name: m.name, description: m.description, icon: m.icon, launchKind: m.launch.kind, requiresConfirm: m.privacy.requiresConfirm, estimatedDuration: m.estimatedDuration });
      expect(v.fields).toEqual(m.input.fields);
      expect(v.health).toEqual(UNKNOWN_TOOL_HEALTH);
    }
  });

  it('carries the confirm gate and the run form (required keys) from the manifest', async () => {
    const byId = new Map((await loadManifests(REG)).map((m) => [m.id, m]));
    const pulse = toToolView(byId.get('pulse-footprint')!);
    expect(pulse.requiresConfirm).toBe(true);
    expect(pulse.launchKind).toBe('http');
    const talk = toToolView(byId.get('talk-track')!);
    expect(requiredFieldKeys(talk)).toEqual(byId.get('talk-track')!.input.fields.filter((f) => f.required).map((f) => f.key));
    expect(toToolView(byId.get('afd360-estimate-new')!).launchKind).toBe('claude_session');
  });

  it('toToolAdapter adds registry state and validates as a GET /tools row; the view does not alias the manifest', async () => {
    const [m] = await loadManifests(REG);
    const health = { state: 'ok' as const, checkedAt: '2026-11-05T09:00:00.000Z', message: null };
    const row = toToolAdapter(m, { health, recentRunIds: ['tr_1'] });
    expect(ToolAdapter.parse(row)).toMatchObject({ id: m.id, enabled: true, recentRunIds: ['tr_1'], health });
    expect(ToolsPayload.safeParse({ adapters: [row], recentRuns: [] }).success).toBe(true);
    row.fields[0].label = 'changed';
    expect(m.input.fields[0].label).not.toBe('changed');
  });

  it('every TOOLS manifest also yields a valid deprecated compatibility manifest (pre-CONTRACT-1 readers keep working)', async () => {
    for (const m of await loadManifests(REG)) {
      const legacy = ToolAdapterManifest.parse(legacyManifestFromTools(m));
      expect(legacy).toMatchObject({ id: m.id, name: m.name, description: m.description, icon: m.icon });
      expect(legacy.kind).toBe(m.launch.kind === 'claude_session' ? 'claude-session' : m.launch.kind);
      expect(legacy.safety.requiresApproval).toBe(m.privacy.requiresConfirm);
      expect(legacy.input.schema.required).toEqual(m.input.fields.filter((f) => f.required).map((f) => f.key));
      // and mapping it back gives the same run form keys and confirm gate
      const back = toolViewFromLegacyManifest(legacy);
      expect(back.fields.map((f) => [f.key, f.required])).toEqual(m.input.fields.map((f) => [f.key, f.required]));
      expect(back.requiresConfirm).toBe(m.privacy.requiresConfirm);
      expect(back.launchKind).toBe(m.launch.kind);
    }
  });
});

describe('legacy seed manifests → the same view', () => {
  const rows = () => (rawExampleSeed() as { toolAdapters: unknown[] }).toolAdapters;

  it('derives form fields from the JSON schema (required, titles, enums, prefill) and the confirm gate from requiresApproval', () => {
    const views = new Map(rows().map((r) => ToolAdapterSeedRow.parse(r)).map((v) => [v.id, v]));
    const talk = views.get('talk-track')!;
    expect(talk).toMatchObject({ launchKind: 'http', icon: 'wrench', requiresConfirm: true, estimatedDuration: null, enabled: true });
    expect(talk.fields.map((f) => [f.key, f.type, f.required, f.label])).toEqual([
      ['customer', 'string', true, 'Customer'],
      ['name', 'string', true, 'Talk track name'],
      ['eventId', 'string', false, 'Event'],
    ]);
    expect(talk.fields[0].prefill).toBe('{{task.account.name}}');
    const pulse = views.get('pulse-footprint')!;
    expect(pulse.fields.find((f) => f.key === 'format')).toMatchObject({ type: 'enum', options: [{ value: 'pptx', label: 'pptx' }, { value: 'link', label: 'link' }] });
    expect(pulse.health.state).toBe('down');
    expect(views.get('afd360-estimator')).toMatchObject({ launchKind: 'cli', requiresConfirm: false });
  });

  it('fieldsFromJsonSchema handles number/integer/boolean and unknown types', () => {
    const f = fieldsFromJsonSchema({ required: ['n'], properties: { n: { type: 'integer', minimum: 1, maximum: 9 }, x: { type: 'number' }, b: { type: 'boolean', default: true }, o: { type: 'object' } } });
    expect(f).toEqual([
      { key: 'n', label: 'n', required: true, type: 'number', integer: true, min: 1, max: 9 },
      { key: 'x', label: 'x', required: false, type: 'number', integer: false },
      { key: 'b', label: 'b', required: false, type: 'boolean', default: true },
      { key: 'o', label: 'o', required: false, type: 'string' },
    ]);
  });

  it('legacy icon / estimatedDuration are honoured when a seed supplies them', () => {
    const r = rows()[0] as { manifest: Record<string, unknown>; health: unknown };
    const v = toolViewFromLegacyManifest(Seed.shape.toolAdapters.element.parse({ ...r, manifest: { ...r.manifest, icon: 'presentation', estimatedDuration: { minSec: 60, maxSec: 600 } } }).manifest);
    expect(v).toMatchObject({ icon: 'presentation', estimatedDuration: { minSec: 60, maxSec: 600 } });
  });

  it('a parsed seed re-parses to the same value (the mock shifts dates and parses again)', () => {
    const once = Seed.parse(rawExampleSeed());
    const twice = Seed.parse(JSON.parse(JSON.stringify(once)));
    expect(twice.toolAdapters).toEqual(once.toolAdapters);
    expect(twice.settings).toEqual(once.settings);
  });
});

describe('mock serves the view', () => {
  let ds: MockDataSource;
  beforeEach(() => {
    ds = newDs();
  });
  afterEach(() => ds.dispose());

  it('GET /tools is a contract-valid list of views', async () => {
    const out = await ds.getTools({} as never);
    expect(ToolsPayload.safeParse(out).success).toBe(true);
    expect(out.adapters.map((a) => a.id).sort()).toEqual(['afd360-estimator', 'pulse-footprint', 'talk-track']);
  });

  it('runs validate inputs against the view fields (required + enum options)', async () => {
    await expect(ds.startToolRun({ params: { id: 'afd360-estimator' }, body: { inputs: { scenario: 'x' } } })).rejects.toMatchObject({ code: 'validation' });
    await expect(ds.startToolRun({ params: { id: 'afd360-estimator' }, body: { inputs: { account: 'Globex', format: 'pdf' } } })).rejects.toMatchObject({ code: 'validation', message: expect.stringMatching(/format/) });
    const ok = await ds.startToolRun({ params: { id: 'afd360-estimator' }, body: { inputs: { account: 'Globex', format: 'xlsx' } } });
    expect(ok.entity).toMatchObject({ adapterId: 'afd360-estimator', status: 'queued' });
  });
});
