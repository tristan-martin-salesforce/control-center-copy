/**
 * Post-contract-bounds (26-caps-audit.md, "Contract bounds"): request bounds that were arbitrary are lifted, the real
 * bound named where it lives.
 */
import { describe, expect, it } from 'vitest';
import { EditCanvasRowRequest } from '@/contract';
import { UC_AGENT_TYPES } from '@/engines/activity/use-cases';
import { checkedUseCaseFields } from '@/server/time/canvas-review';

describe('EditCanvasRowRequest useCase.agentTypes', () => {
  it('takes more than the old 30 values; the Org62 picklist is the real bound', () => {
    const all = [...UC_AGENT_TYPES.d360, ...UC_AGENT_TYPES.agentforce];
    const agentTypes = Array.from({ length: 31 }, (_, i) => all[i % all.length]!);
    const r = EditCanvasRowRequest.parse({ ifVersion: 1, key: 'uc:abc', useCase: { agentTypes } });
    expect(r.useCase!.agentTypes).toHaveLength(31);
    expect(() => checkedUseCaseFields({ agentTypes: ['Not a picklist value'] })).toThrow();
  });
});
