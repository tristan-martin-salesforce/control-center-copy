// @vitest-environment jsdom
/**
 * The onboarding asides read the same for every role (29-persona-qa): no "VDP changes" for a Specialist AE, and the
 * settings section under its current name, Profile & hours. Role-neutral words, so the asides need no persona.
 */
import { createElement as h } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@/components/composer/__tests__/dom';
import { ReviewAside } from '../steps.review';
import { SourcesAside } from '../steps.sources';

afterEach(async () => cleanup());

const text = () => document.body.textContent ?? '';

describe('onboarding asides: role-neutral words', () => {
  it('Sources: activity logs and record updates wait on Activity (no VDP words)', async () => {
    await render(h(SourcesAside));
    expect(text()).toContain('activity logs and record updates wait on Activity until you Apply them');
    expect(text()).not.toMatch(/VDP/);
  });

  it('Review: every log entry or record update waits; the section is Profile & hours', async () => {
    await render(h(ReviewAside));
    expect(text()).toContain('every log entry or record update waits on Activity until you Apply it');
    expect(text()).toContain('Settings ▸ Profile & hours');
    expect(text()).not.toMatch(/VDP|Profile & role/);
  });
});
