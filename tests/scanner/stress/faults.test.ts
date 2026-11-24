/** Fault injector semantics (deterministic, window-bound). */
import { describe, expect, it } from 'vitest';

import { FaultInjector } from '../../../scripts/stress/replay/faults';

describe('FaultInjector', () => {
  it('fires every call inside a `during` window when the rule has no other trigger', () => {
    let now = 1000;
    const f = new FaultInjector([{ kind: 'auth', during: { from: 2000, to: 3000 } }], 1, () => now);
    expect(f.decide('x')).toBeUndefined();
    now = 2500;
    expect(f.decide('x')?.kind).toBe('auth');
    expect(f.decide('y')?.kind).toBe('auth');
    now = 3000;
    expect(f.decide('x')).toBeUndefined();
  });

  it('nth / afterCalls / seeded probability are deterministic', () => {
    const a = new FaultInjector([{ kind: 'rate_limit', p: 0.3 }], 42);
    const b = new FaultInjector([{ kind: 'rate_limit', p: 0.3 }], 42);
    const seqA = Array.from({ length: 50 }, () => a.decide('t')?.kind ?? '-').join('');
    const seqB = Array.from({ length: 50 }, () => b.decide('t')?.kind ?? '-').join('');
    expect(seqA).toBe(seqB);
    const n = new FaultInjector([{ kind: 'timeout', nth: [2] }, { kind: 'auth', afterCalls: 3, tool: /search/ }]);
    expect([n.decide('search'), n.decide('search'), n.decide('read'), n.decide('read'), n.decide('search')].map((d) => d?.kind ?? '-')).toEqual(['-', 'timeout', '-', '-', 'auth']);
  });
});
