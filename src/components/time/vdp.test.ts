/**
 * Time ▸ VDP (D-52, D-59), pure parts: the fiscal label, the head sentence from the shared summary, the status chip,
 * who does an item, an Apply's form values, and the admin queue. Admin items: canvases and VDP changes, never
 * messages. Placeholders only.
 *
 * Changed with D-59 (2026-11-11): gap rows, their sort and the "N the app can fix · M to do in VDP" sentence are gone;
 * the server sends one status and the open items per VDP (src/engines/vdp/status.ts), so these tests now check the
 * shaping of those instead of re-deriving them on the client.
 */
import { describe, expect, it } from 'vitest';
import { adminDraftHref, adminSurfaceOf, isAdminDraft, type Draft, type OutboxItem, type VdpApply, type VdpStatus } from '@/contract';
import { adminQueue, adminTitle, applyDefaults, applyNeedsInput, applyReady, fiscalLabel, nextReadText, STATUS_CHIP, statusLine, vdpSentence, whoText } from './vdp-derive';

const draft = (id: string, action: string, input: Record<string, unknown>, updatedAt = '2026-11-10T10:00:00.000Z'): Draft =>
  ({ id, status: 'ready', updatedAt, plainText: '', destination: { kind: 'action', action, target: { label: 'Acme FY27 Q4 · Deflection', url: null }, input, changes: [{ label: 'Persona', before: null, after: 'Ops lead' }], text: '' } }) as unknown as Draft;
const item = (d: Draft, group: OutboxItem['group'] = 'pending_approval'): OutboxItem => ({ draft: d, group, workItem: null, previewText: '', history: [], source: null });

describe('admin items', () => {
  it('are structured actions, never messages, and open on Time', () => {
    const vdp = draft('d1', 'vdp.update_use_case', { vdpSlug: 'acme', useCaseId: 'u1', field: 'persona' });
    const canvas = draft('d2', 'slack_canvas.create', { eventIds: ['a'] });
    expect(isAdminDraft(vdp) && isAdminDraft(canvas)).toBe(true);
    expect(isAdminDraft({ destination: { kind: 'slack', target: 'channel', channelId: 'C0', channelName: '#x', threadTs: null } } as never)).toBe(false);
    expect(adminDraftHref(vdp)).toBe('/activity?view=vdp&draft=d1');
    expect(adminDraftHref(canvas)).toBe('/activity?view=week&draft=d2');
    expect(adminTitle(canvas)).toBe('Logging batch · Acme FY27 Q4 · Deflection');
    // a feedback report waiting to be sent is named as one (not a canvas)
    expect(adminTitle(draft('d3', 'feedback.post', {}))).toBe('Feedback · Acme FY27 Q4 · Deflection');
    // the feedback post (D-56) is a message, the Outbox's own: never an item that waits on Activity
    expect(isAdminDraft(draft('d3', 'feedback.post', {}))).toBe(false);
    expect(adminSurfaceOf(draft('d3', 'feedback.post', {}))).toBeNull();
    // a forecast canvas is applied on Time ▸ Forecast, a logging canvas on Week, a VDP change on VDP
    const forecast = draft('d4', 'slack_canvas.create', { eventIds: [], forecast: { kind: 'specialist_forecast', updates: [] } });
    expect([adminSurfaceOf(canvas), adminSurfaceOf(forecast), adminSurfaceOf(vdp)]).toEqual(['log', 'forecast', 'vdp']);
    expect(adminDraftHref(forecast)).toBe('/activity?view=forecast&draft=d4');
  });

  it('the waiting list puts pending before failed, newest first', () => {
    const a = item(draft('a', 'vdp.update_use_case', {}, '2026-11-10T09:00:00.000Z'));
    const b = item(draft('b', 'vdp.update_use_case', {}, '2026-11-10T11:00:00.000Z'));
    const f = item(draft('f', 'vdp.update_use_case', {}, '2026-11-10T12:00:00.000Z'), 'failed');
    expect(adminQueue([a, f, b]).map((i) => i.draft.id)).toEqual(['b', 'a', 'f']);
  });
});

describe('the VDP list and head', () => {
  const status = (state: VdpStatus['state'], o: Partial<VdpStatus> = {}): VdpStatus => ({ state, open: 0, appCanFix: 0, waiting: 0, label: state, nextReadAt: '2026-11-10T16:30:00.000Z', ...o });

  it('labels the fiscal period', () => {
    expect(fiscalLabel({ fiscalYear: 27, fiscalQuarter: 4 })).toBe('FY27 Q4');
    expect(fiscalLabel({ fiscalYear: 2027, fiscalQuarter: 4 })).toBe('FY27 Q4');
    expect(fiscalLabel({ fiscalYear: null, fiscalQuarter: null })).toBeNull();
  });

  it('the head says VDPs by status, from the shared summary', () => {
    const c = { summary: { needYou: 3, waiting: 2, done: 9, past: 4, notInVdp: 0, appCanFix: 5 }, lastReadAt: '2026-11-10T05:00:00.000Z' };
    expect(vdpSentence(c)).toBe('3 VDPs need you · 2 waiting · 9 done');
    expect(vdpSentence({ ...c, summary: { ...c.summary, needYou: 1, notInVdp: 2 } })).toBe('1 VDP needs you · 2 waiting · 9 done · 2 not in VDP yet');
    expect(vdpSentence({ ...c, lastReadAt: null })).toMatch(/has not been read yet/);
    expect(vdpSentence(undefined)).toMatch(/Loading/);
  });

  it('color marks state only: open = act, done = ready, waiting and past = neutral; the panel line says who does what', () => {
    expect([STATUS_CHIP.open.tone, STATUS_CHIP.done.tone, STATUS_CHIP.waiting.tone, STATUS_CHIP.past.tone]).toEqual(['now', 'success', 'neutral', 'neutral']);
    const now = Date.parse('2026-11-10T16:00:00.000Z');
    // D-63: no handoffs: the rest wait for a value you type, or for VDP's MCP to take them
    expect(statusLine(status('open', { open: 3, appCanFix: 2, waiting: 1, label: '3 open' }), now, 'UTC')).toBe('3 open · 2 the app can push · 1 need a value or wait for VDP · 1 waiting');
    expect(statusLine(status('waiting', { label: 'Waiting for VDP to refresh' }), now, 'UTC')).toBe('Waiting for VDP to refresh · next read 16:30');
    expect(statusLine(status('done'), now, 'UTC')).toMatch(/^Done/);
    expect(nextReadText('2026-11-10T15:00:00.000Z', now, 'UTC')).toBe('next read due now');
    expect(whoText({ who: 'app' })).toBe('the app can fix');
    expect(whoText({ who: 'app', kind: 'find_assets' })).toBe('the app looks for them here');
    expect(whoText({ who: 'app', policy: 'auto' })).toBe('autopilot can apply it');
  });

  it('an Apply starts from the suggestions; required fields and at least one value gate it; ids are not typed', () => {
    const a: VdpApply = {
      key: 'acme:use_case:u1',
      op: 'update_use_case',
      label: 'Fill in 2 fields',
      fields: [
        { field: 'persona', label: 'Persona', current: null, suggested: null, options: [], required: false, multiline: false, fixed: false },
        { field: 'priority', label: 'Priority', current: null, suggested: null, options: ['3 - High', '2 - Medium', '1 - Low'], required: false, multiline: false, fixed: false },
      ],
    };
    expect(applyDefaults(a)).toEqual({ persona: '', priority: '' });
    expect(applyNeedsInput(a)).toBe(true);
    expect(applyReady(a, { persona: '', priority: '' })).toBe(false);
    expect(applyReady(a, { persona: 'Data team', priority: '' })).toBe(true);
    const add: VdpApply = { key: 'opp:O5:add', op: 'update_vdp_header', label: 'Add the opportunity', fields: [{ field: 'add_opportunity_ids', label: 'Org62 opportunities to add', current: null, suggested: ['006PLACEHOLD005'], options: [], required: true, multiline: false, fixed: true }] };
    expect(applyNeedsInput(add)).toBe(false); // nothing to type: Apply stages at once
    expect(applyReady(add, {})).toBe(true);
    expect(applyDefaults(add)).toEqual({ add_opportunity_ids: '006PLACEHOLD005' });
  });
});
