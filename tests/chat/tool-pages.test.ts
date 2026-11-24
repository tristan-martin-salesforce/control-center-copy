/**
 * Caps audit F-5 (26-caps-audit.md): what the Assistant's tools cut to a count reaches every item.
 *   chat_log_batch `applied`   a page of 10 applied canvases with the total and the next offset, paged to the end
 *   vdp_find_assets chips      four VDP chips, then one "+N more" chip to Activity ▸ VDP
 */
import { describe, expect, it } from 'vitest';
import type { LogCanvas } from '@/contract';
import { vdpAssetChips, VDP_ASSETS_RUN_CEILING_USD } from '@/llm/chat/tools';
import { APPLIED_PAGE, pageAppliedCanvases } from '@/server/datasource/log-canvases';

const canvas = (i: number, state: string): LogCanvas =>
  ({ draftId: `d-${String(i).padStart(2, '0')}`, title: `Canvas ${i}`, state, url: null, appliedAt: null, rows: 1, hours: 1, dcs: 0, useCases: 0, org62: null }) as unknown as LogCanvas;

describe('chat_log_batch: applied canvases page to the end', () => {
  const list = [...Array.from({ length: 23 }, (_, i) => canvas(i, 'verified')), canvas(99, 'pending')];

  it('the first page holds 10 with the total of applied ones and the next offset', () => {
    const p = pageAppliedCanvases(list);
    expect(p.applied).toHaveLength(APPLIED_PAGE);
    expect(p.appliedTotal).toBe(23); // the pending one is not applied
    expect(p.appliedNextOffset).toBe(10);
  });

  it('following appliedNextOffset reaches every applied canvas once', () => {
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const p = pageAppliedCanvases(list, { offset });
      seen.push(...p.applied.map((c) => c.draftId));
      offset = p.appliedNextOffset;
    }
    expect(seen).toHaveLength(23);
    expect(new Set(seen).size).toBe(23);
  });
});

describe('vdp_find_assets: queued VDP chips', () => {
  const q = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `vdp-${i}`, companyName: `Company ${i}` }));

  it('four or fewer: one chip each, no more chip', () => {
    expect(vdpAssetChips(q(4)).map((c) => c.id)).toEqual(['vdp:vdp-0', 'vdp:vdp-1', 'vdp:vdp-2', 'vdp:vdp-3']);
  });

  it('past four: a "+N more" chip to Activity ▸ VDP', () => {
    const chips = vdpAssetChips(q(9));
    expect(chips).toHaveLength(5);
    expect(chips.at(-1)).toMatchObject({ label: '+5 more VDPs · Assets to add', href: '/activity?view=vdp' });
    expect(vdpAssetChips(q(5)).at(-1)!.label).toBe('+1 more VDP · Assets to add');
  });

  it('names the per-run cost ceiling (safety)', () => {
    expect(VDP_ASSETS_RUN_CEILING_USD).toBe(50);
  });
});

describe('search: no hidden 10-hit Gmail/Drive path (caps audit F-9)', () => {
  it('the unreachable searchGoogle (clamped to 10) is gone; live Gmail and Drive search page through the search tool', async () => {
    const shared = await import('@/server/datasource/db/chat-be6.shared');
    expect('searchGoogle' in shared).toBe(false);
  });
});
