// @vitest-environment jsdom
/**
 * ActionRow (01-ui-audit R10): slots, the quiet/loud verb, states (new · leaving · gone · selected · held), overflow
 * past the inline icons into ⋯, and the row's keys.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { ActionRow, type ActionRowProps } from '../ActionRow';

const { act } = await import('react');

async function mount(props: Partial<ActionRowProps> = {}) {
  const r = await render(h(ActionRow, { id: 'wi-001', title: 'Send the Saltmere blueprint', why: 'Marisol asked for it by Friday', ...props }));
  const row = r.container.querySelector<HTMLElement>('[data-row]')!;
  const key = async (k: string, init: KeyboardEventInit = {}) => act(async () => void row.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...init })));
  return { r, row, key };
}

afterEach(async () => cleanup());

describe('ActionRow', () => {
  it('draws title, why, confidence, tint, source link and the lead', async () => {
    const { row } = await mount({ confidence: 'guess', tint: 'ai', source: { label: 'Open in Slack', url: 'https://example.com/s/1' }, lead: { top: '08:35', bottom: 'in 13m' } });
    expect(row.getAttribute('aria-label')).toBe('Send the Saltmere blueprint');
    expect(row.textContent).toContain('Marisol asked for it by Friday');
    expect(row.textContent).toContain('Guess');
    expect(row.querySelector('[data-tint="ai"]')).not.toBeNull();
    expect(row.querySelector<HTMLAnchorElement>('[data-testid="row-source-link"]')!.href).toBe('https://example.com/s/1');
    expect(row.querySelector('[data-slot="lead"]')!.textContent).toBe('08:35in 13m');
  });

  it('the verb is quiet until the row is selected (and stays quiet in the panel)', async () => {
    const verb = { label: 'Review', onClick: vi.fn(), kbd: 'a' };
    const quiet = await mount({ verb });
    expect(quiet.row.querySelector('[data-row-verb]')!.getAttribute('data-row-verb')).toBe('quiet');
    await cleanup();
    const loud = await mount({ verb, selected: true });
    expect(loud.row.querySelector('[data-row-verb]')!.getAttribute('data-row-verb')).toBe('filled');
    expect(loud.row.getAttribute('aria-selected')).toBe('true');
    expect(loud.row.querySelector('[data-edge]')!.getAttribute('data-edge')).toBe('now');
    await cleanup();
    const panel = await mount({ verb, selected: true, inPanel: true });
    expect(panel.row.querySelector('[data-row-verb]')!.getAttribute('data-row-verb')).toBe('quiet');
  });

  it('danger beats selection on the edge', async () => {
    const { row } = await mount({ edge: 'danger', selected: true });
    expect(row.querySelector('[data-edge]')!.getAttribute('data-edge')).toBe('danger');
  });

  it('live states: new carries the tint, leaving is hidden from AT, gone turns the verbs off', async () => {
    const n = await mount({ live: 'new', liveTone: 'ai' });
    expect(n.row.getAttribute('data-live')).toBe('new');
    expect(n.row.getAttribute('data-live-tone')).toBe('ai');
    await cleanup();
    const l = await mount({ live: 'leaving' });
    expect(l.row.getAttribute('aria-hidden')).toBe('true');
    await cleanup();
    const onClick = vi.fn();
    const g = await mount({ live: 'gone', verb: { label: 'Approve', onClick } });
    expect(g.row.textContent).toContain('Handled elsewhere');
    expect(g.row.querySelector<HTMLButtonElement>('[data-row-verb]')!.disabled).toBe(true);
    await g.key('Enter', { metaKey: true });
    expect(onClick).not.toHaveBeenCalled();
  });

  it('held: dashed, the reason first, the verb off', async () => {
    const { row } = await mount({ held: 'Waiting for VDP to refresh', verb: { label: 'Apply', onClick: vi.fn() } });
    expect(row.hasAttribute('data-held')).toBe(true);
    expect(row.textContent).toContain('Waiting for VDP to refresh ·');
    expect(row.querySelector('[data-edge]')!.className).toContain('border-dashed');
    expect(row.querySelector<HTMLButtonElement>('[data-row-verb]')!.disabled).toBe(true);
  });

  it('overflow: the first three are icon buttons, the rest in the ⋯ menu', async () => {
    const mk = (id: string) => ({ id, label: id, icon: 'edit', onClick: vi.fn() });
    const { row } = await mount({ overflow: [mk('edit'), mk('snooze'), mk('done'), mk('merge'), mk('reject')] });
    const hover = row.querySelector('[data-row-actions="hover"]')!;
    expect([...hover.querySelectorAll('[data-testid^="overflow-"]')].map((b) => b.getAttribute('data-testid'))).toEqual(['overflow-edit', 'overflow-snooze', 'overflow-done', 'overflow-more']);
  });

  it('keys: Enter opens details, ⇧Enter the page, ⌘↵ the verb, Space the expansion, single keys their verbs', async () => {
    const onOpen = vi.fn();
    const verb = vi.fn();
    const done = vi.fn();
    const onExpandedChange = vi.fn();
    const { key } = await mount({ onOpen, verb: { label: 'Review', onClick: verb }, keys: { d: done }, expansion: h('p', null, 'picker'), expanded: false, onExpandedChange });
    await key('Enter');
    await key('Enter', { shiftKey: true });
    await key('Enter', { metaKey: true });
    await key(' ');
    await key('d');
    expect(onOpen.mock.calls).toEqual([['details'], ['page']]);
    expect(verb).toHaveBeenCalledTimes(1);
    expect(onExpandedChange).toHaveBeenCalledWith(true);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('the expansion shows when expanded and a click inside it does not open the row', async () => {
    const onOpen = vi.fn();
    const { row } = await mount({ onOpen, expansion: h('span', { 'data-picker': '' }, 'Pick an opp'), expanded: true });
    const picker = row.querySelector<HTMLElement>('[data-picker]')!;
    await act(async () => picker.click());
    expect(onOpen).not.toHaveBeenCalled();
    await act(async () => row.click());
    expect(onOpen).toHaveBeenCalledWith('details');
  });

  it('the tick box toggles without opening the row', async () => {
    const onChange = vi.fn();
    const onOpen = vi.fn();
    const { row } = await mount({ onOpen, check: { checked: false, onChange, label: 'Select this row' } });
    await act(async () => row.querySelector<HTMLInputElement>('[data-testid="row-check"]')!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});

describe('ActionRow density="compact" and "group" (Activity-at-scale C3)', () => {
  const compact = (props: Partial<ActionRowProps> = {}) =>
    mount({ why: undefined, density: 'compact', lead: 'Thu 19 10:00', amount: '1.5 h', where: h('span', null, '87% likely Globex · Data 360 Expansion'), whereLabel: '87 percent likely Globex · Data 360 Expansion', ...props });

  it('one line: tick · when · title · hours · where · verb · chevron, no why line, no expansion', async () => {
    const { row } = await compact({ check: { checked: false, onChange: vi.fn(), label: 'Tick' }, verb: { label: 'Accept', onClick: vi.fn() }, onOpen: vi.fn() });
    expect(row.getAttribute('data-density')).toBe('compact');
    expect(row.className).toContain('min-h-11');
    const slots = [...row.querySelectorAll('[data-testid="row-check"],[data-slot="lead"],[data-slot="title"],[data-slot="amount"],[data-slot="where"],[data-row-verb],[data-testid="row-chevron"]')];
    expect(slots.map((s) => s.getAttribute('data-slot') ?? s.getAttribute('data-testid') ?? 'verb')).toEqual(['row-check', 'lead', 'title', 'amount', 'where', 'verb', 'row-chevron']);
    expect(row.querySelector('[data-slot="title"]')!.getAttribute('title')).toBe('Send the Saltmere blueprint');
    expect(row.querySelector('[data-slot="expansion"]')).toBeNull();
  });

  it('aria: the row is named by its title, the where cell by what it says', async () => {
    const { row } = await compact({ onEditingChange: vi.fn() });
    expect(row.getAttribute('role')).toBe('row');
    expect(row.getAttribute('aria-label')).toBe('Send the Saltmere blueprint');
    expect(row.querySelector('[data-slot="where"]')!.getAttribute('aria-label')).toBe('87 percent likely Globex · Data 360 Expansion');
  });

  it('the editor is absent until the where cell is clicked, then replaces it; Esc ends the edit', async () => {
    const onEditingChange = vi.fn();
    const editor = h('select', { 'data-picker': '', 'aria-label': 'Opportunity' });
    const off = await compact({ editor, editing: false, onEditingChange });
    expect(off.row.querySelector('[data-picker]')).toBeNull();
    await act(async () => off.row.querySelector<HTMLButtonElement>('[data-slot="where"]')!.click());
    expect(onEditingChange).toHaveBeenCalledWith(true);
    await cleanup();
    const on = await compact({ editor, editing: true, onEditingChange });
    const picker = on.row.querySelector<HTMLElement>('[data-picker]')!;
    expect(on.row.querySelector('[data-slot="where"]')).toBeNull();
    await act(async () => void picker.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
  });

  it('the chevron, Enter and a click on the title open the details; a click on where does not', async () => {
    const onOpen = vi.fn();
    const { row, key } = await compact({ onOpen, onEditingChange: vi.fn() });
    await act(async () => row.querySelector<HTMLButtonElement>('[data-testid="row-chevron"]')!.click());
    await key('Enter');
    await act(async () => row.querySelector<HTMLElement>('[data-slot="title"]')!.click());
    await act(async () => row.querySelector<HTMLButtonElement>('[data-slot="where"]')!.click());
    expect(onOpen.mock.calls).toEqual([['details'], ['details'], ['details']]);
  });

  it('Space and x tick the row', async () => {
    const onChange = vi.fn();
    const { key } = await compact({ check: { checked: false, onChange, label: 'Tick' } });
    await key(' ');
    await key('x');
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('failure: a red ▲ and the plain reason in the where cell, the edge danger', async () => {
    const { row } = await compact({ failure: 'Not found in Org62 after the batch ran' });
    const where = row.querySelector('[data-slot="where"]')!;
    expect(where.hasAttribute('data-failure')).toBe(true);
    expect(where.textContent).toBe('▲Not found in Org62 after the batch ran');
    expect(where.className).toContain('text-danger-700');
    expect(row.querySelector('[data-edge]')!.getAttribute('data-edge')).toBe('danger');
  });

  it('widths (R2-2): the title takes two shares, the where cell one; the lead shortens in a narrow lane', async () => {
    const { row } = await compact({ leadShort: 'Thu 10:00' });
    const title = row.querySelector('[data-slot="title"]')!;
    const where = row.querySelector('[data-slot="where"]')!;
    expect(title.className).toContain('flex-[2]');
    expect(title.className).toContain('min-w-0');
    expect(where.className).toContain('flex-1');
    expect(where.hasAttribute('data-fit')).toBe(false);
    expect(row.querySelector('[data-slot="lead"]')!.className).toContain('@max-[44rem]/lane:hidden');
    const short = row.querySelector('[data-slot="lead-short"]')!;
    expect(short.textContent).toBe('Thu 10:00');
    expect(short.className).toContain('@max-[44rem]/lane:inline');
  });

  it('widths: with the group naming the target the where cell keeps its natural width (whereFit)', async () => {
    const { row } = await compact({ where: h('span', null, '87% likely ✓'), whereFit: true });
    const where = row.querySelector('[data-slot="where"]')!;
    expect(where.hasAttribute('data-fit')).toBe(true);
    expect(where.className).toContain('flex-initial');
    expect(where.className).not.toContain('flex-1');
    expect(row.querySelector('[data-slot="lead-short"]')).toBeNull();
  });

  it('failure (R2-10): the short reason in the row, the full sentence as its title and name', async () => {
    const { row } = await compact({ failure: 'Not found in Org62', failureDetail: 'Not found in Org62 after the batch ran', whereFit: true });
    const where = row.querySelector('[data-slot="where"]')!;
    expect(where.textContent).toBe('▲Not found in Org62');
    expect(where.getAttribute('title')).toBe('Not found in Org62 after the batch ran');
    expect(where.getAttribute('aria-label')).toBe('Failed: Not found in Org62 after the batch ran');
    expect(where.className).toContain('flex-none');
  });

  it('group: tick the group, its label and count in a rowheader, its one verb', async () => {
    const onChange = vi.fn();
    const accept = vi.fn();
    const { row, key } = await mount({ why: undefined, density: 'group', title: 'Suggested: Globex · Data 360 Expansion', count: 9, check: { checked: false, mixed: true, onChange, label: 'Tick the group' }, verb: { label: 'Accept 9', onClick: accept } });
    expect(row.querySelector('[role="rowheader"]')).not.toBeNull();
    expect(row.querySelector('[data-slot="count"]')!.textContent).toBe('9');
    expect(row.querySelector<HTMLInputElement>('[data-testid="row-check"]')!.indeterminate).toBe(true);
    expect(row.querySelector('[data-testid="row-chevron"]')).toBeNull();
    await key('x');
    await act(async () => row.querySelector<HTMLButtonElement>('[data-row-verb]')!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(accept).toHaveBeenCalledTimes(1);
  });
});
