import { describe, expect, it } from 'vitest';

import { buildFlags, formatFeedbackMessage } from '../../src/server/feedback/format';

const report = {
  title: 'Footer is wrong',
  kind: 'bug' as const,
  summary: '',
  steps: [],
  expected: '',
  actual: '',
  diagnosis: { cause: '', files: [], confidence: 'low' as const },
  context: { version: '1.3.0', sha: 'abc1234def', persona: 'SE', page: 'Home · /', entityKind: null },
};

describe('the feedback post names the build (PKG-4)', () => {
  it('a build with local changes says "modified (n files)" and its channel, next to the sha', () => {
    const m = formatFeedbackMessage(report, 'Sam Placeholder', { dirty: 3, channel: 'dev' });
    expect(m.split('\n')[1]).toBe('v1.3.0 · `abc1234` · modified (3 files) · channel dev · persona SE · page Home · /');
  });
  it('a clean release build says only its channel', () => {
    expect(buildFlags({ dirty: 0, channel: 'stable' })).toEqual(['channel stable']);
    expect(buildFlags({ dirty: 1, channel: 'beta' })).toEqual(['modified (1 file)', 'channel beta']);
    expect(buildFlags(null)).toEqual([]);
  });
});
