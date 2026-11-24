/**
 * The `vdp` Outbox channel (approved 2026-11-10): one field change = one item, before → after; dry run records the
 * exact `update_use_case` payload and sends nothing; a live Apply goes through the guarded gateway only; read-back
 * via `get_use_case`. The live VDP transport is never called here (fakes only). Placeholders only.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type ActionDestination, type OutboxAction, type RouteKey, type RouteOutput, type VdpActionInput } from '../../src/contract';
import {
  adapterFor,
  channelOf,
  confirmDelivery,
  liveOutboxTransport,
  OutboxDelivery,
  OutboxGateway,
  OutboxLiveDisabledError,
  payloadHash,
  sendingOf,
  SimulatedOutboxTransport,
  type ToolCall,
} from '../../src/outbox';
import { MockDataSource } from '../../src/server/datasource/mock';
import { payloadFor } from '../../src/server/datasource/mock/render';
import { actionFamily, actionSummary } from '../../src/lib/actions';
import { AppError } from '../../src/server/errors';
import { coerceVdpValue, showVdpValue, vdpActionPayload } from '../../src/lib/vdp/payload';

const UC = 'aaaaaaa1-0000-4000-8000-000000000002';
/** A `vdp.*` action item (placeholders): one field, before → after. */
function act(o: Partial<VdpActionInput> = {}, action: OutboxAction = 'vdp.update_use_case'): ActionDestination {
  const input: VdpActionInput = { vdpSlug: 'acme-fy27-q4', vdpId: '11111111-1111-4111-8111-111111111111', useCaseId: UC, useCaseTitle: 'Service agent deflection', track: null, field: 'persona', before: null, value: 'Service operations lead', changes: [], itemKey: null, candidateId: null, pending: null, ...o };
  return { kind: 'action', action, target: { label: 'Acme Placeholder FY27 Q4 · Service agent deflection', url: 'https://vdp.example.test/vdp/acme-fy27-q4?tab=agentforce' }, input, changes: [{ label: 'Persona', before: showVdpValue(input.before), after: showVdpValue(input.value) }], text: null };
}
const dest = act();
const EMPTY = { type: 'doc' as const, content: [] };
const AT = '2026-11-10T17:00:00.000Z';
const confirmFor = (payload: Record<string, unknown>) => confirmDelivery({ draftId: 'd1', draftVersion: 1, mode: 'send', payloadHash: payloadHash(payload), confirmToken: 't', expectedToken: 't', at: AT });

describe('payload and tool call (src/lib/vdp/payload.ts + the vdp adapter)', () => {
  it('one field = the exact update_use_case call, with before → after', () => {
    const p = payloadFor(dest, EMPTY, 'send');
    expect(p).toEqual({
      api: 'vdp.update_use_case',
      server: 'vdp-app-fir',
      tool: 'update_use_case',
      vdp_slug: 'acme-fy27-q4',
      vdp_id: '11111111-1111-4111-8111-111111111111',
      use_case_id: UC,
      field: 'persona',
      before: null,
      after: 'Service operations lead',
      // D-59: every item lists the fields its one call sets (an item staged before it has just its one field)
      fields: [{ field: 'persona', before: null, after: 'Service operations lead' }],
      args: { id: UC, persona: 'Service operations lead' },
    });
    expect(adapterFor('vdp').toolCall(p, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'update_use_case', args: { id: UC, persona: 'Service operations lead' } });
    expect(channelOf(dest)).toBe('vdp');
    expect(actionFamily('vdp.update_vdp_header')).toBe('vdp');
    expect(actionSummary(dest)).toBe('Persona: (empty) → Service operations lead');
    // a malformed input is never sendable
    expect(vdpActionPayload({ action: 'vdp.update_use_case', input: { field: 'persona' } })).toMatchObject({ args: null, invalid: expect.stringContaining('malformed') });
    expect(channelOf({ kind: 'email', target: 'new', to: [{ email: 'x@example.com' }], cc: [], subject: '', threadId: null, inReplyTo: null })).toBe('gmail');
  });

  it('values follow the field rules (priority words, enums, dates, numbers, ids); empty never', () => {
    expect(coerceVdpValue('update_use_case', 'priority', 'high')).toEqual({ ok: true, value: '3 - High' });
    expect(coerceVdpValue('update_use_case', 'execution_phase', 'build')).toEqual({ ok: true, value: 'Build' });
    expect(coerceVdpValue('update_use_case', 'execution_target_date', '2027-02-30').ok).toBe(false);
    expect(coerceVdpValue('update_use_case', 'execution_duration_value', '12')).toEqual({ ok: true, value: 12 });
    expect(coerceVdpValue('update_vdp_header', 'fiscal_year', 'FY27')).toEqual({ ok: true, value: 27 });
    expect(coerceVdpValue('update_vdp_header', 'fiscal_quarter', 'Q3')).toEqual({ ok: true, value: 3 });
    expect(coerceVdpValue('update_vdp_header', 'salesforce_opportunity_id', '006short').ok).toBe(false);
    expect(coerceVdpValue('update_use_case', 'persona', '   ').ok).toBe(false);
    expect(coerceVdpValue('update_use_case', 'generated_fields', 'x').ok).toBe(false);
    const bad = vdpActionPayload(act({ field: 'priority', value: 'whenever' }));
    expect(bad).toMatchObject({ args: null, invalid: expect.stringContaining('Priority is one of') });
  });

  it('the adapter refuses draft mode, an invalid value, tampered args and any non-op tool', () => {
    const a = adapterFor('vdp');
    const p = vdpActionPayload(act({ value: 'Data team' }));
    expect(() => a.toolCall(p, 'draft')).toThrow(/VDP has no drafts/);
    expect(() => a.toolCall(vdpActionPayload(act({ field: 'priority', value: 'whenever' })), 'send')).toThrow(/invalid_request/);
    expect(() => a.toolCall({ ...p, args: { id: 'someone-else', persona: 'Data team' } }, 'send')).toThrow(/do not match/);
    expect(() => a.toolCall({ ...p, tool: 'delete_use_case' }, 'send')).toThrow(/not a VDP Outbox op/);
    expect(() => a.toolCall({ ...p, tool: 'generate_deal_contribution_notes' }, 'send')).toThrow(/not a VDP Outbox op/);
  });

  it('one Apply per use case: every missing input in ONE update_use_case; a new use case with all five in ONE create_use_case', () => {
    const changes = [
      { field: 'priority', before: null, value: 'high' },
      { field: 'division', before: null, value: 'Service' },
      { field: 'persona', before: null, value: 'Service operations lead' },
    ];
    const u = vdpActionPayload(act({ field: 'priority', value: 'high', changes, itemKey: `acme-fy27-q4:use_case:${UC}` }));
    expect(u).toMatchObject({ item_key: `acme-fy27-q4:use_case:${UC}`, fields: [{ field: 'priority', after: '3 - High' }, { field: 'division', after: 'Service' }, { field: 'persona', after: 'Service operations lead' }] });
    expect(adapterFor('vdp').toolCall(u, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'update_use_case', args: { id: UC, priority: '3 - High', division: 'Service', persona: 'Service operations lead' } });
    const five = ['title', 'priority', 'division', 'persona', 'details_input'].map((field, i) => ({ field, before: null, value: ['Order status agent', 'medium', 'Service', 'Agents', 'Placeholder details.'][i]! }));
    const c = vdpActionPayload(act({ useCaseId: null, track: 'agentforce', field: 'title', value: 'Order status agent', changes: five }, 'vdp.create_use_case'));
    expect(adapterFor('vdp').toolCall(c, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'create_use_case', args: { vdp_id: '11111111-1111-4111-8111-111111111111', track: 'agentforce', title: 'Order status agent', priority: '2 - Medium', division: 'Service', persona: 'Agents', details_input: 'Placeholder details.' } });
    // a new use case needs its title; a field set twice, or one the op doesn't take, is never sendable
    expect(vdpActionPayload(act({ useCaseId: null, track: 'd360', field: 'priority', value: 'high', changes: [{ field: 'priority', before: null, value: 'high' }] }, 'vdp.create_use_case'))).toMatchObject({ args: null, invalid: expect.stringContaining('needs Title') });
    expect(vdpActionPayload(act({ changes: [changes[0]!, changes[0]!] }))).toMatchObject({ args: null, invalid: expect.stringContaining('set twice') });
    expect(vdpActionPayload(act({ changes: [{ field: 'generated_fields', before: null, value: 'x' }] }))).toMatchObject({ args: null });
  });

  it('create_vdp: company, account, opps and fiscal period in ONE call; add_opportunity_ids only adds', () => {
    const company = '00000000-0000-4000-8000-000000000200';
    const changes = [
      { field: 'company_id', before: null, value: company },
      { field: 'fiscal_year', before: null, value: 27 },
      { field: 'fiscal_quarter', before: null, value: 4 },
      { field: 'salesforce_account_id', before: null, value: '001PLACEHOLDER0009' },
      { field: 'salesforce_opportunity_ids', before: null, value: ['006PLACEHOLDER0009', '006PLACEHOLDER0010'] },
    ];
    const v = vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'company_id', value: company, changes }, 'vdp.create_vdp'));
    expect(v.invalid).toBeUndefined();
    expect(adapterFor('vdp').toolCall(v, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'create_vdp', args: { company_id: company, fiscal_year: 27, fiscal_quarter: 4, salesforce_account_id: '001PLACEHOLDER0009', salesforce_opportunity_ids: ['006PLACEHOLDER0009', '006PLACEHOLDER0010'] } });
    expect(vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'fiscal_year', value: 27, changes: changes.slice(1) }, 'vdp.create_vdp'))).toMatchObject({ args: null, invalid: expect.stringContaining('needs VDP company') });
    const add = vdpActionPayload(act({ useCaseId: null, field: 'add_opportunity_ids', value: ['006PLACEHOLDER0002'], changes: [{ field: 'add_opportunity_ids', before: null, value: ['006PLACEHOLDER0002'] }] }, 'vdp.update_vdp_header'));
    expect(adapterFor('vdp').toolCall(add, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'update_vdp_header', args: { vdp_id: '11111111-1111-4111-8111-111111111111', add_opportunity_ids: ['006PLACEHOLDER0002'] } });
    // D-63: a closed-lost opp is taken off the header (a suggestion you approve); read back as gone
    const rm = vdpActionPayload(act({ useCaseId: null, field: 'remove_opportunity_ids', value: ['006PLACEHOLDER0002'], changes: [{ field: 'remove_opportunity_ids', before: null, value: ['006PLACEHOLDER0002'] }] }, 'vdp.update_vdp_header'));
    expect(adapterFor('vdp').toolCall(rm, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'update_vdp_header', args: { vdp_id: '11111111-1111-4111-8111-111111111111', remove_opportunity_ids: ['006PLACEHOLDER0002'] } });
    // D-63: the entitlement leveraged, one of three values (exact casing on the wire)
    const ent = vdpActionPayload(act({ useCaseId: null, field: 'entitlement_leveraged', value: 'flex', changes: [{ field: 'entitlement_leveraged', before: null, value: 'flex' }] }, 'vdp.update_vdp_header'));
    expect(ent.args).toEqual({ vdp_id: '11111111-1111-4111-8111-111111111111', entitlement_leveraged: 'Flex' });
    expect(coerceVdpValue('update_vdp_header', 'entitlement_leveraged', 'Seats').ok).toBe(false);
    expect(coerceVdpValue('update_vdp_header', 'add_opportunity_ids', '001PLACEHOLDER0002').ok).toBe(false);
    expect(coerceVdpValue('update_vdp_header', 'add_opportunity_ids', '006PLACEHOLDER0002, 006PLACEHOLDER0003')).toEqual({ ok: true, value: ['006PLACEHOLDER0002', '006PLACEHOLDER0003'] });
  });

  it('D-63: an item that waits for a parent’s new id carries placeholders: a dry run records it, a live write refuses it', () => {
    const changes = [
      { field: 'company_id', before: null, value: '' },
      { field: 'fiscal_year', before: null, value: 27 },
      { field: 'fiscal_quarter', before: null, value: 4 },
    ];
    const v = vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'company_id', value: '', changes, pending: { companyId: 'account:A9:create_company' } }, 'vdp.create_vdp'));
    expect(v).toMatchObject({ pending: ['company_id'], waits_for: ['account:A9:create_company'], args: { company_id: '(new company id)', fiscal_year: 27, fiscal_quarter: 4 } });
    expect(v.invalid).toBeUndefined();
    const a = adapterFor('vdp');
    expect(() => a.toolCall(v, 'send')).toThrow(/waits for an earlier item/);
    expect(a.dryRunCall!(v, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'create_vdp', args: { company_id: '(new company id)', fiscal_year: 27, fiscal_quarter: 4 } });
    const ta = vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'technical_architects', value: ['me@example.com'], changes: [{ field: 'technical_architects', before: null, value: ['me@example.com'] }], pending: { vdpId: 'account:A9:create_vdp' } }, 'vdp.set_vdp_owners'));
    expect(ta).toMatchObject({ vdp_id: '(new VDP id)', args: { vdp_id: '(new VDP id)', technical_architects: ['me@example.com'] } });
    // the delivery engine records a dry run with the placeholder; a live attempt is refused before any transport
    const engine = new OutboxDelivery({ gateway: null, now: () => new Date(AT) });
    const d = act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'technical_architects', value: ['me@example.com'], changes: [{ field: 'technical_architects', before: null, value: ['me@example.com'] }], pending: { vdpId: 'account:A9:create_vdp' } }, 'vdp.set_vdp_owners');
    const payload = payloadFor(d, EMPTY, 'send');
    const dry = engine.prepare({ draftId: 'd1', draftVersion: 1, destination: d, mode: 'send', payload, dryRun: true, attemptNo: 1, confirmation: confirmFor(payload) });
    expect(dry.toolCall.args).toMatchObject({ vdp_id: '(new VDP id)' });
    expect(() => engine.prepare({ draftId: 'd1', draftVersion: 1, destination: d, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation: confirmFor(payload) })).toThrow(/waits for an earlier item/);
  });

  it("the pending tools map to the upstream arguments exactly (vdp-app #10), and read back", async () => {
    const a = adapterFor('vdp');
    const one = (field: string, value: string | string[]) => [{ field, before: null, value }];
    const gen = vdpActionPayload(act({ field: 'ai_fields', value: 'generate', changes: one('ai_fields', 'generate') }, 'vdp.generate_use_case'));
    expect(a.toolCall(gen, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'generate_use_case', args: { vdp_id: '11111111-1111-4111-8111-111111111111', use_case_id: UC } });
    const owners = vdpActionPayload(act({ useCaseId: null, field: 'account_executives', value: ['ae@example.com'], changes: [...one('account_executives', ['AE@example.com']), ...one('technical_architects', ['ta@example.com'])] }, 'vdp.set_vdp_owners'));
    expect(a.toolCall(owners, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'set_vdp_owners', args: { vdp_id: '11111111-1111-4111-8111-111111111111', account_executives: ['ae@example.com'], technical_architects: ['ta@example.com'] } });
    // a role list replaces the current one ([] clears it): an empty list is never sendable
    expect(vdpActionPayload(act({ useCaseId: null, field: 'account_executives', value: [], changes: one('account_executives', []) }, 'vdp.set_vdp_owners'))).toMatchObject({ args: null });
    const company = vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'name', value: 'Initech Placeholder', changes: one('name', 'Initech Placeholder') }, 'vdp.create_company'));
    expect(a.toolCall(company, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'create_company', args: { name: 'Initech Placeholder' } });
    expect(vdpActionPayload(act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'name', value: 'X', changes: [...one('name', 'X'), ...one('salesforce_account_id', '001PLACEHOLDER0009')] }, 'vdp.create_company'))).toMatchObject({ args: null }); // no Org62 id upstream
    const asset = vdpActionPayload(act({ useCaseId: null, field: 'url', value: 'https://docs.example.com/d/1', changes: [...one('url', 'https://docs.example.com/d/1'), ...one('title', 'Discovery deck'), ...one('asset_type', 'Deck')] }, 'vdp.add_vdp_asset'));
    expect(a.toolCall(asset, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'add_vdp_asset', args: { vdp_id: '11111111-1111-4111-8111-111111111111', url: 'https://docs.example.com/d/1', title: 'Discovery deck', asset_type: 'Deck' } });
    expect(vdpActionPayload(act({ useCaseId: null, field: 'url', value: 'https://docs.example.com/d/1', changes: one('url', 'https://docs.example.com/d/1') }, 'vdp.add_vdp_asset'))).toMatchObject({ args: null, invalid: expect.stringContaining('Title') });
    // live Apply through the simulated VDP, then read back
    const sim = new SimulatedOutboxTransport(() => new Date(AT));
    const engine = new OutboxDelivery({ gateway: new OutboxGateway(sim), now: () => new Date(AT), isDryRun: () => false });
    for (const dv of [act({ field: 'ai_fields', value: 'generate', changes: one('ai_fields', 'generate') }, 'vdp.generate_use_case'), act({ useCaseId: null, field: 'url', value: 'https://docs.example.com/d/1', changes: [...one('url', 'https://docs.example.com/d/1'), ...one('title', 'Discovery deck')] }, 'vdp.add_vdp_asset')]) {
      const payload = payloadFor(dv, EMPTY, 'send');
      const confirmation = confirmFor(payload);
      const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dv, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation }), confirmation);
      expect(rec, String(payload.tool)).toMatchObject({ state: 'delivered', readback: 'confirmed' });
    }
    // D-69 (VD-21): each write is preceded by its live check (a read), then read back
    expect(sim.calls.map((c) => c.tool)).toEqual(['get_use_case', 'generate_use_case', 'get_use_case', 'get_vdp_assets', 'add_vdp_asset', 'get_vdp_assets']);
  });

  it('read-back covers every field the call set: opps added, a new VDP found by its link', async () => {
    const a = adapterFor('vdp');
    const add = vdpActionPayload(act({ useCaseId: null, field: 'add_opportunity_ids', value: ['006PLACEHOLD002'], changes: [{ field: 'add_opportunity_ids', before: null, value: ['006PLACEHOLD002'] }] }, 'vdp.update_vdp_header'));
    const ctx = { payload: add, mode: 'send' as const, write: { externalId: null, link: null } };
    await expect(a.readback(async () => ({ text: JSON.stringify({ vdp: { id: 'v', salesforceOpportunityIds: ['006PLACEHOLD001AAA', '006PLACEHOLD002AAA'] } }) }), ctx)).resolves.toMatchObject({ readback: 'confirmed' });
    await expect(a.readback(async () => ({ text: JSON.stringify({ vdp: { id: 'v', salesforceOpportunityIds: ['006PLACEHOLD001'] } }) }), ctx)).resolves.toMatchObject({ readback: 'unconfirmed', detail: expect.stringContaining('add_opportunity_ids') });
    const sim = new SimulatedOutboxTransport(() => new Date(AT));
    const engine = new OutboxDelivery({ gateway: new OutboxGateway(sim), now: () => new Date(AT), isDryRun: () => false });
    const company = '00000000-0000-4000-8000-000000000200';
    const dv = act({ vdpSlug: 'account:A9', vdpId: '', useCaseId: null, field: 'company_id', value: company, changes: [{ field: 'company_id', before: null, value: company }, { field: 'salesforce_opportunity_ids', before: null, value: ['006PLACEHOLDER0009'] }] }, 'vdp.create_vdp');
    const payload = payloadFor(dv, EMPTY, 'send');
    const confirmation = confirmFor(payload);
    const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dv, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation }), confirmation);
    expect(rec).toMatchObject({ state: 'delivered', readback: 'confirmed' });
    expect(sim.calls.map((c) => c.tool)).toEqual(['create_vdp', 'get_vdp']);
  });

  it('create_use_case and update_vdp_header map the same way', () => {
    const c = vdpActionPayload(act({ useCaseId: null, track: 'agentforce', field: 'title', value: 'Order status agent' }, 'vdp.create_use_case'));
    expect(adapterFor('vdp').toolCall(c, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'create_use_case', args: { vdp_id: '11111111-1111-4111-8111-111111111111', track: 'agentforce', title: 'Order status agent' } });
    const h = vdpActionPayload(act({ useCaseId: null, field: 'salesforce_opportunity_id', value: '006PLACEHOLDER0001' }, 'vdp.update_vdp_header'));
    expect(adapterFor('vdp').toolCall(h, 'send')).toEqual({ server: 'vdp-app-fir', tool: 'update_vdp_header', args: { vdp_id: '11111111-1111-4111-8111-111111111111', salesforce_opportunity_id: '006PLACEHOLDER0001' } });
  });
});

describe('delivery', () => {

  it('dry run: the exact payload and update_use_case call are recorded, and no transport is touched', async () => {
    const touched: ToolCall[] = [];
    const gw = new OutboxGateway({ callTool: async (c) => (touched.push(c), { text: '{}' }) });
    const engine = new OutboxDelivery({ gateway: gw, now: () => new Date(AT) });
    const payload = payloadFor(dest, EMPTY, 'send');
    const confirmation = confirmFor(payload);
    const rec0 = engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: true, attemptNo: 1, confirmation });
    const rec = await engine.deliver(rec0, confirmation);
    expect(rec).toMatchObject({ state: 'dry_run_delivered', dryRun: true, channel: 'vdp', toolCall: { server: 'vdp-app-fir', tool: 'update_use_case', args: { id: UC, persona: 'Service operations lead' } } });
    expect(rec.payload).toEqual(payload);
    expect(touched).toEqual([]);
  });

  it('live Apply: only through the gateway, then read back with get_use_case', async () => {
    const sim = new SimulatedOutboxTransport(() => new Date(AT));
    const engine = new OutboxDelivery({ gateway: new OutboxGateway(sim), now: () => new Date(AT), isDryRun: () => false });
    const payload = payloadFor(dest, EMPTY, 'send');
    const confirmation = confirmFor(payload);
    const rec = await engine.deliver(engine.prepare({ draftId: 'd1', draftVersion: 1, destination: dest, mode: 'send', payload, dryRun: false, attemptNo: 1, confirmation }), confirmation);
    expect(rec).toMatchObject({ state: 'delivered', readback: 'confirmed', readbackDetail: 'Verified in VDP ✓', result: { externalId: UC } });
    // D-69 (VD-21): the live check (get_use_case) right before the write
    expect(sim.calls.map((c) => c.tool)).toEqual(['get_use_case', 'update_use_case', 'get_use_case']);
  });

  it('read-back: a different value is unconfirmed, a missing use case is missing', async () => {
    const a = adapterFor('vdp');
    const payload = vdpActionPayload(act({ value: 'Data team' }));
    const ctx = { payload, mode: 'send' as const, write: { externalId: UC, link: null } };
    await expect(a.readback(async () => ({ text: JSON.stringify({ use_case: { id: UC, persona: 'Someone else' } }) }), ctx)).resolves.toMatchObject({ readback: 'unconfirmed' });
    await expect(a.readback(async () => ({ text: JSON.stringify({ use_case: null }) }), ctx)).resolves.toMatchObject({ readback: 'missing' });
    await expect(a.readback(async () => ({ text: JSON.stringify({ use_case: { id: UC, persona: 'Data team' } }) }), ctx)).resolves.toMatchObject({ readback: 'confirmed', matchedExternalId: UC });
  });

  it('the gateway refuses a VDP write the item did not name, and a delete', async () => {
    const gw = new OutboxGateway({ callTool: async () => ({ text: '{}' }) });
    const payload = { ...vdpActionPayload(act({ value: 'Data team' })), tool: 'delete_use_case' };
    await expect(gw.write({ draftId: 'd1', channel: 'vdp', mode: 'send', payload }, confirmFor(payload))).rejects.toThrow(/not a VDP Outbox op/);
  });

  it('the live transport sends VDP to the VDP transport only; Slack and Gmail stay fail-closed', async () => {
    const seen: ToolCall[] = [];
    const t = liveOutboxTransport({ vdp: { callTool: async (c) => (seen.push(c), { text: '{"use_case":{"id":"x"}}' }) } });
    await t.callTool({ server: 'vdp-app-fir', tool: 'update_use_case', args: { id: 'x', persona: 'y' } });
    expect(seen).toHaveLength(1);
    await expect(t.callTool({ server: 'slack', tool: 'slack_send_message', args: {} })).rejects.toThrow(OutboxLiveDisabledError);
    // relays are keyed by server AND tool: a VDP tool that is not an Outbox op never reaches the VDP relay
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'delete_use_case', args: {} })).rejects.toThrow(OutboxLiveDisabledError);
    await expect(t.callTool({ server: 'vdp-app-fir', tool: 'search_vdps', args: {} })).rejects.toThrow(OutboxLiveDisabledError);
    expect(seen).toHaveLength(1);
    await expect(liveOutboxTransport({ vdp: null }).callTool({ server: 'vdp-app-fir', tool: 'update_use_case', args: {} })).rejects.toThrow(OutboxLiveDisabledError);
  });

  it('Settings → Sending: VDP is always send (Apply), dry-run still ON by default', () => {
    expect(sendingOf(undefined)).toMatchObject({ dryRun: true, channels: { vdp: { mode: 'send' } } });
    expect(sendingOf({ channels: { slack: { mode: 'draft' }, gmail: { mode: 'draft' }, vdp: { mode: 'draft' } } } as never).channels.vdp.mode).toBe('send');
  });
});

describe('mock DataSource: coverage → one item → dry-run Apply', () => {
  const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
  let ds: MockDataSource;
  let sim: SimulatedOutboxTransport;
  beforeEach(() => {
    ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
    sim = new SimulatedOutboxTransport();
    ds.outbox.useTransport(sim);
  });
  afterEach(() => ds.dispose());
  async function call<K extends RouteKey>(key: K, input: unknown): Promise<RouteOutput<K>> {
    const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, input);
    const r = routes[key].response.safeParse(out);
    if (!r.success) throw new Error(`${key} response failed the contract: ${JSON.stringify(r.error.issues.slice(0, 3))}`);
    return out as RouteOutput<K>;
  }

  it('getVdpCoverage returns placeholder VDPs with app fixes (D-63: no handoffs)', async () => {
    const cov = await call('getVdpCoverage', {});
    expect(cov.vdps.length).toBeGreaterThan(0);
    expect(cov.vdpBaseUrl).toBe('https://vdp.example.test');
    const all = [...cov.vdps.flatMap((v) => v.gaps), ...cov.unlinked];
    expect(all.some((g) => g.code === 'use_case_field' && g.fix.kind === 'app')).toBe(true);
    expect(all.some((g) => g.fix.kind === 'handoff')).toBe(false);
    expect(cov.counts.gaps).toBe(all.length);
  });

  it('a gap becomes one pending Outbox item; dry-run dispatch records the exact update_use_case payload', async () => {
    const cov = await call('getVdpCoverage', {});
    const gap = cov.vdps.flatMap((v) => v.gaps).find((g) => g.code === 'use_case_field' && g.fix.kind === 'app')!;
    const fix = gap.fix as Extract<typeof gap.fix, { kind: 'app' }>;
    const made = await call('draftVdpUpdate', { body: { vdpSlug: gap.vdpSlug!, op: fix.op, field: fix.field, value: 'Service operations lead', useCaseId: gap.useCaseId, gapId: gap.id } });
    const d = made.entity.draft;
    expect(d).toMatchObject({
      status: 'ready',
      mode: 'send',
      userLockedFields: ['doc', 'destination', 'mode'],
      destination: { kind: 'action', action: 'vdp.update_use_case', input: { field: fix.field, before: null, useCaseId: gap.useCaseId, value: 'Service operations lead' }, changes: [{ before: null, after: 'Service operations lead' }] },
    });
    expect(d.plainText).toMatch(/: \(empty\) → Service operations lead$/);
    // read-only: an action item is approved or rejected, never edited
    const edit = await ds.patchDraft({ params: { id: d.id }, body: { ifVersion: d.version, doc: { type: 'doc', content: [] } } }).catch((e: unknown) => e);
    expect(edit).toBeInstanceOf(AppError);
    expect((edit as AppError).message).toMatch(/read-only/);
    const outbox = await call('getOutbox', {});
    // D-52: an admin item, applied on Time ▸ VDP: in `admin`, never in the Outbox's message groups
    expect(outbox.admin.items.some((i) => i.draft.id === d.id && i.group === 'pending_approval')).toBe(true);
    expect(outbox.groups.flatMap((g) => g.items).some((i) => i.draft.id === d.id)).toBe(false);
    expect(outbox.admin.pending).toBeGreaterThanOrEqual(1);
    const preview = await call('previewDraft', { params: { id: d.id }, body: { mode: 'send' } });
    expect(preview.dryRun).toBe(true);
    expect(preview.payload).toMatchObject({ tool: 'update_use_case', args: { id: gap.useCaseId, [fix.field]: 'Service operations lead' }, before: null, after: 'Service operations lead' });
    const res = await call('dispatchDraft', { params: { id: d.id }, body: { ifVersion: preview.version, mode: 'send', confirmToken: preview.confirmToken } });
    expect(res.dryRun).toBe(true);
    expect(res.payload).toEqual(preview.payload);
    expect(res.attempt).toMatchObject({ dryRun: true, outcome: 'rendered' });
    expect(sim.calls).toEqual([]); // nothing reached even the simulated destination
  });

  it('refuses an invalid value, an unknown VDP or use case, and a no-op change', async () => {
    const cov = await call('getVdpCoverage', {});
    const v = cov.vdps.find((x) => x.useCaseCount > 0)!;
    const appErr = async (body: unknown) => {
      const e = await ds.draftVdpUpdate({ body } as never).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(AppError);
      return e as AppError;
    };
    expect((await appErr({ vdpSlug: v.vdpSlug, op: 'update_use_case', field: 'priority', value: 'whenever', useCaseId: 'x' })).code).toBe('validation');
    expect((await appErr({ vdpSlug: 'no-such-vdp', op: 'update_use_case', field: 'persona', value: 'x', useCaseId: 'x' })).code).toBe('not_found');
    expect((await appErr({ vdpSlug: v.vdpSlug, op: 'update_use_case', field: 'persona', value: 'x', useCaseId: 'no-such-use-case' })).code).toBe('not_found');
    expect((await appErr({ vdpSlug: v.vdpSlug, op: 'update_vdp_header', field: 'fiscal_year', value: String(v.fiscalYear) })).code).toBe('validation');
  });
});
