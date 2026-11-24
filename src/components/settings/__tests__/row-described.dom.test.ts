// @vitest-environment jsdom
/** Settings Row (30-a11y): the helper, or the error that replaces it, describes the field (aria-describedby). */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { Row } from '../form';

const { act } = await import('react');

afterEach(async () => cleanup());

const field = () => document.getElementById('f-name')!;

describe('Row aria-describedby', () => {
  it('links the helper to the field the label names', async () => {
    await render(h(Row, { label: 'Name', htmlFor: 'f-name', help: 'As it shows in Slack' , children: h('input', { id: 'f-name' })}));
    expect(field().getAttribute('aria-describedby')).toBe('f-name-desc');
    expect(document.getElementById('f-name-desc')!.textContent).toBe('As it shows in Slack');
  });

  it('links the error (an alert) in its place, and keeps a describedby the field already had', async () => {
    await render(h(Row, { label: 'Name', htmlFor: 'f-name', error: 'Name is required' , children: h('input', { id: 'f-name', 'aria-describedby': 'own' })}));
    expect(field().getAttribute('aria-describedby')).toBe('own f-name-desc');
    const err = document.getElementById('f-name-desc')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toBe('Name is required');
  });

  it('drops the link when the text goes', async () => {
    const r = await render(h(Row, { label: 'Name', htmlFor: 'f-name', error: 'Name is required' , children: h('input', { id: 'f-name' })}));
    await act(async () => r.root.render(h(Row, { label: 'Name', htmlFor: 'f-name' , children: h('input', { id: 'f-name' })})));
    expect(field().hasAttribute('aria-describedby')).toBe(false);
  });

  it('a row named by labelId describes the control that points at it', async () => {
    await render(h(Row, { label: 'Days', labelId: 'l-days', help: 'Working days' , children: h('div', { role: 'group', 'aria-labelledby': 'l-days', id: 'g' })}));
    expect(document.getElementById('g')!.getAttribute('aria-describedby')).toBe('l-days-desc');
  });
});
