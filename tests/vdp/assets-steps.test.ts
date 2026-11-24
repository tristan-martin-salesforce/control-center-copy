/**
 * VDP details, pure parts: which links are assets and their keys (one key per Google file, whatever the link form),
 * dedupe against what the VDP holds, the deterministic matcher (mapped items first, then the asset's title, then a
 * mention: unsure), and the open items' order with its dependencies. Placeholders only.
 */
import { describe, expect, it } from 'vitest';

import type { VdpGap } from '../../src/contract';
import { assetKeyOf, assetKindOf, inVdp, linksInText, matchAssetItems, mergeDraft, sameAsset, type AccountResolver, type AssetItem, type AssetTarget } from '../../src/engines/vdp/assets';
import { vdpSteps } from '../../src/engines/vdp/steps';
import { draftsFromOutput } from '../../src/llm/research/vdp-assets';
import { assetCopyText, candidateView, effectiveSlug, slugByAccount } from '../../src/server/vdp/detail';
import { planFindAssets } from '../../src/server/vdp/find';

const DECK = 'https://docs.google.com/presentation/d/PLACEHOLDER0DECK0000000000001/edit';

describe('asset links', () => {
  it('one key per Google file, whatever the link form; other links lose query, fragment and trailing slash', () => {
    expect(assetKeyOf(DECK)).toBe('drive:PLACEHOLDER0DECK0000000000001');
    expect(assetKeyOf('https://docs.google.com/presentation/d/PLACEHOLDER0DECK0000000000001/view?usp=sharing#slide=id.p')).toBe('drive:PLACEHOLDER0DECK0000000000001');
    expect(assetKeyOf('https://drive.google.com/file/d/PLACEHOLDER0DECK0000000000001/view')).toBe('drive:PLACEHOLDER0DECK0000000000001');
    expect(assetKeyOf('https://WWW.Loom.com/share/abc/?t=1')).toBe('loom.com/share/abc');
  });

  it('knows what is an asset: files, canvases, recordings, demo orgs; never threads, mail, meetings, records or VDP', () => {
    expect(assetKindOf(DECK)).toBe('deck');
    expect(assetKindOf('https://docs.google.com/spreadsheets/d/PLACEHOLDER0SHEET000000000001/edit')).toBe('sheet');
    expect(assetKindOf('https://drive.google.com/file/d/PLACEHOLDER0VIDEO000000000001/view', { mime: 'video/mp4' })).toBe('recording');
    expect(assetKindOf('https://example.slack.com/docs/T0/F0PLACEHOLDER')).toBe('canvas');
    expect(assetKindOf('https://zoom.us/rec/share/PLACEHOLDER')).toBe('recording');
    expect(assetKindOf('https://acme-demo.lightning.force.com/lightning/page/home')).toBe('demo');
    for (const u of [
      'https://example.slack.com/archives/C0PLACEHOLDER/p1700000000000001',
      'https://mail.google.com/mail/u/0/#inbox/PLACEHOLDER',
      'https://zoom.us/j/123456789',
      'https://meet.google.com/abc-defg-hij',
      'https://org62.lightning.force.com/lightning/r/Opportunity/006PLACEHOLDER0XYZ/view',
      'https://vdp-app-fir-0000.example.herokuapp-internal.com/vdp/acme',
      'https://drive.google.com/drive/folders/PLACEHOLDER0FOLDER00000000001',
      'https://www.example.com/pricing',
    ])
      expect(assetKindOf(u), u).toBeNull();
  });

  it('dedupes against the VDP by link or by a title of 8+ characters', () => {
    const vdp = [{ url: 'https://docs.google.com/presentation/d/PLACEHOLDER0DECK0000000000001/view', title: 'Old name' }, { url: 'https://example.com/x', title: 'ACME Discovery Readout' }];
    expect(inVdp({ url: DECK, title: 'Anything' }, vdp)).toBe(true);
    expect(inVdp({ url: 'https://docs.google.com/document/d/PLACEHOLDER0DOC00000000000001/edit', title: 'acme discovery readout.pptx' }, vdp)).toBe(true);
    expect(sameAsset({ url: 'https://a.example/1', title: 'Deck' }, { url: 'https://b.example/2', title: 'Deck' })).toBe(false);
  });
});

describe('the matcher (no model call)', () => {
  const targets: AssetTarget[] = [
    { key: 'acc-1', accountId: 'acc-1', vdpSlug: 'acme-fy27-q4', companyName: 'ACME', inVdp: [{ url: 'https://docs.google.com/document/d/PLACEHOLDER0INVDP00000000001/edit', title: 'Already there' }] },
    { key: 'acc-2', accountId: 'acc-2', vdpSlug: null, companyName: 'Globex', inVdp: [] },
  ];
  const resolve: AccountResolver = (text) => (/\bacme\b/i.test(text) ? { accountId: 'acc-1', confidence: 0.8, via: 'title' } : /\bglobex\b/i.test(text) ? { accountId: 'acc-2', confidence: 0.8, via: 'title' } : /\binitech\b/i.test(text) ? { accountId: 'acc-9', confidence: 0.8, via: 'title' } : null);
  const item = (o: Partial<AssetItem>): AssetItem => ({ sourceItemId: o.sourceItemId ?? 'si-1', source: 'slack', title: null, text: '', url: 'https://example.slack.com/archives/C0PLACEHOLDER/p1', at: '2026-11-10T10:00:00.000Z', label: '#general', mapped: null, domains: [], links: [], ...o });

  it('a file in a mapped channel or mapped by the app is suggested; a title that names the account too; a mention alone is unsure', () => {
    const out = matchAssetItems(
      [
        item({ sourceItemId: 'a', label: '#acme-ext', mapped: { accountId: 'acc-1', confidence: 0.85, via: "the channel is ACME's" }, links: [{ url: DECK, title: 'Readout', mime: null }] }),
        item({ sourceItemId: 'b', source: 'drive', title: 'Globex · Architecture', label: 'Drive', links: [{ url: 'https://docs.google.com/document/d/PLACEHOLDER0DOC00000000000002/edit', title: 'Globex · Architecture', mime: null }] }),
        item({ sourceItemId: 'c', text: 'here is the demo for acme', label: 'Slack DM', links: [{ url: 'https://www.loom.com/share/PLACEHOLDER1', title: 'ACME demo walkthrough', mime: null }] }),
        // 2026-11-14 screen: an untitled link and a meeting's chat log are never candidates
        item({ sourceItemId: 'u', text: 'acme', label: 'Slack DM', links: [{ url: 'https://www.loom.com/share/PLACEHOLDER2', title: null, mime: null }] }),
        item({ sourceItemId: 'g', source: 'calendar', title: 'ACME sync', label: 'Calendar · ACME sync', links: [{ url: 'https://docs.google.com/document/d/PLACEHOLDER0CHAT0000000000001/edit', title: 'ACME sync - 2026/11/02 12:29 EST - Chat', mime: null }] }),
      ],
      targets,
      resolve,
    );
    const by = new Map(out.map((d) => [d.sourceItemIds[0], d]));
    expect(by.get('a')).toMatchObject({ targetKey: 'acc-1', vdpSlug: 'acme-fy27-q4', status: 'suggested', kind: 'deck', title: 'Readout', why: "Shared in #acme-ext: the channel is ACME's", sources: [{ source: 'slack', label: '#acme-ext' }] });
    expect(by.get('b')).toMatchObject({ targetKey: 'acc-2', vdpSlug: null, status: 'suggested', kind: 'doc', confidence: 0.8 });
    expect(by.get('c')).toMatchObject({ targetKey: 'acc-1', status: 'unsure', kind: 'recording', title: 'ACME demo walkthrough' });
    expect(by.has('u')).toBe(false);
    expect(by.has('g')).toBe(false);
  });

  it('nothing for another account, a non-asset link, or an asset the VDP already holds; demo orgs stay unsure', () => {
    const out = matchAssetItems(
      [
        item({ sourceItemId: 'x', text: 'initech deck', links: [{ url: DECK, title: 'Initech deck', mime: null }] }),
        item({ sourceItemId: 'y', text: 'acme thread', links: [{ url: 'https://example.slack.com/archives/C0PLACEHOLDER/p2', title: null, mime: null }] }),
        item({ sourceItemId: 'z', mapped: { accountId: 'acc-1', confidence: 0.9, via: 'mapped' }, links: [{ url: 'https://docs.google.com/document/d/PLACEHOLDER0INVDP00000000001/view', title: null, mime: null }] }),
        item({ sourceItemId: 'd', mapped: { accountId: 'acc-1', confidence: 0.9, via: 'mapped' }, links: [{ url: 'https://acme-demo.lightning.force.com/lightning/page/home', title: 'ACME demo org', mime: null }] }),
      ],
      targets,
      resolve,
    );
    expect(out.map((d) => d.sourceItemIds[0])).toEqual(['d']);
    expect(out[0]).toMatchObject({ kind: 'demo', status: 'unsure', confidence: 0.55 });
  });

  it('two sightings of one asset merge: the stronger reason, both sources', () => {
    const [a] = matchAssetItems([item({ sourceItemId: 'm1', text: 'acme', links: [{ url: DECK, title: 'ACME readout', mime: null }] })], targets, resolve);
    const [b] = matchAssetItems([item({ sourceItemId: 'm2', label: '#acme-ext', url: 'https://example.slack.com/archives/C0PLACEHOLDER/p9', mapped: { accountId: 'acc-1', confidence: 0.85, via: 'mapped' }, links: [{ url: `${DECK}?usp=sharing`, title: 'ACME readout', mime: null }] })], targets, resolve);
    const m = mergeDraft(a!, b!);
    expect(m).toMatchObject({ status: 'suggested', confidence: 0.85, title: 'ACME readout' });
    expect(m.sources).toHaveLength(2);
    expect(m.sourceItemIds.sort()).toEqual(['m1', 'm2']);
    // one batch with both sightings merges the same way
    expect(matchAssetItems([item({ sourceItemId: 'm1', text: 'acme', links: [{ url: DECK, title: null, mime: null }] }), item({ sourceItemId: 'm2', mapped: { accountId: 'acc-1', confidence: 0.85, via: 'mapped' }, links: [{ url: DECK, title: 'ACME readout', mime: null }] })], targets, resolve)).toHaveLength(1);
    // the stronger sighting came untitled: the merge keeps the weaker one's real title, so the asset isn't screened out
    const merged = matchAssetItems([item({ sourceItemId: 'm3', mapped: { accountId: 'acc-1', confidence: 0.85, via: 'mapped' }, links: [{ url: DECK, title: null, mime: null }] }), item({ sourceItemId: 'm4', text: 'acme', links: [{ url: DECK, title: 'ACME readout', mime: null }] })], targets, resolve);
    expect(merged).toMatchObject([{ title: 'ACME readout', confidence: 0.85 }]);
  });

  it('caps audit: a merge keeps every source and source item; every link of a text is read', () => {
    const [a] = matchAssetItems([item({ sourceItemId: 'm1', text: 'acme', links: [{ url: DECK, title: 'ACME readout', mime: null }] })], targets, resolve);
    const many = { ...a!, sources: Array.from({ length: 12 }, (_, i) => ({ ...a!.sources[0]!, label: `sighting ${i}` })), sourceItemIds: Array.from({ length: 30 }, (_, i) => `s${i}`) };
    const m = mergeDraft(a!, many);
    expect(m.sources.length).toBe(13);
    expect(m.sourceItemIds.length).toBe(31);
    const text = Array.from({ length: 25 }, (_, i) => `https://example.com/doc/${i}`).join(' and ');
    expect(linksInText(text)).toHaveLength(25);
    expect(linksInText(text, 3)).toHaveLength(3);
  });
});

describe('research output → candidates', () => {
  it('maps sure / likely / guess to confidence and status, and drops what the VDP holds', () => {
    const drafts = draftsFromOutput(
      {
        assets: [
          { title: 'ACME readout', url: DECK, why: 'Presented in the workshop', source: 'calendar', sourceLabel: 'Calendar · ACME workshop', confidence: 'sure', at: '2025-03-12' },
          { title: 'Demo', url: 'https://www.loom.com/share/PLACEHOLDER2', why: 'Linked near a mention', source: 'gmail', sourceLabel: 'Gmail · Re: demo', confidence: 'guess' },
          { title: 'Already there', url: 'https://docs.google.com/document/d/PLACEHOLDER0INVDP00000000001/edit', why: 'x', source: 'drive', sourceLabel: 'Drive', confidence: 'sure' },
        ],
        searched: [],
        notFound: [],
      },
      { key: 'acc-1', vdpSlug: 'acme-fy27-q4', accountId: 'acc-1', companyName: 'ACME', inVdp: [{ url: 'https://docs.google.com/document/d/PLACEHOLDER0INVDP00000000001/view', title: null }] },
    );
    expect(drafts.map((d) => [d.title, d.status, d.confidence, d.kind])).toEqual([
      ['ACME readout', 'suggested', 0.9, 'deck'],
      ['Demo', 'unsure', 0.5, 'recording'],
    ]);
    expect(drafts[0]!.sources[0]).toMatchObject({ source: 'calendar', at: '2025-03-12T12:00:00.000Z' });
  });

  it('each candidate carries the Assets-tab link and the text VDP\'s form takes; without a VDP it points to New VDP', () => {
    const rec = { id: 'c1', targetKey: 'acc-1', vdpSlug: null, accountId: 'acc-1', companyName: 'ACME', title: 'ACME readout', url: DECK, assetKey: 'drive:x', kind: 'deck' as const, why: 'Presented in the workshop', confidence: 0.9, origin: 'backfill' as const, status: 'suggested' as const, sources: [], firstSeenAt: '2026-11-10T10:00:00.000Z', statusAt: null };
    expect(assetCopyText(rec)).toBe(`Title: ACME readout\nLink (URL): ${DECK}\nType: Deck\nDescription: Presented in the workshop`);
    expect(candidateView(rec, { slug: 'acme', vdpUrl: 'https://vdp.example.test/vdp/acme', vdpLabel: 'ACME FY27 Q4', vdpBaseUrl: 'https://vdp.example.test' }).handoff).toMatchObject({ url: 'https://vdp.example.test/vdp/acme?tab=assets', label: "Add it on ACME FY27 Q4's Assets tab" });
    expect(candidateView(rec, { slug: null, vdpUrl: null, vdpLabel: null, vdpBaseUrl: 'https://vdp.example.test' }).handoff.url).toBe('https://vdp.example.test/vdp/new');
    // a candidate found before the VDP existed belongs to the account's newest VDP once there is one
    const byAccount = slugByAccount([{ vdpSlug: 'acme-q3', accountId: 'acc-1', fiscalYear: 27, fiscalQuarter: 3, lastActivityAt: null }, { vdpSlug: 'acme-q4', accountId: 'acc-1', fiscalYear: 27, fiscalQuarter: 4, lastActivityAt: null }] as never);
    expect(effectiveSlug(rec, byAccount)).toBe('acme-q4');
  });
});

const gap = (code: VdpGap['code'], o: Partial<VdpGap> = {}): VdpGap =>
  ({
    id: `acme:${code}:${o.useCaseId ?? ''}${o.title ?? ''}`,
    code,
    severity: 'medium',
    title: o.title ?? code,
    vdpSlug: 'acme',
    vdpUrl: 'https://vdp.example.test/vdp/acme',
    useCaseId: o.useCaseId ?? null,
    useCaseTitle: o.useCaseTitle ?? null,
    accountId: 'acc-1',
    opportunityId: null,
    fix: o.fix ?? { kind: 'app', op: 'update_vdp_header', field: 'salesforce_account_id', current: null, suggested: null, options: [], values: {}, known: false, unsupported: null },
  }) as VdpGap;

// Changed with D-59 (2026-11-11): the steps are the VDP's open items, the same list the Time ▸ VDP card shows. Each says
// who does it (an app item carries ONE Apply: every missing input of a use case, both fiscal fields), Find assets is
// an action on the assets item rather than an item of its own (it is not something "open"), and with no VDP yet the
// list is only what can happen now (create it), since the next VDP read brings the new VDP's own items.
describe('Steps (D-63): one item per VDP call, in sections, what each needs first, disabled when VDP can’t take it', () => {
  const app = (field: string, op: Extract<VdpGap['fix'], { kind: 'app' }>['op'] = 'update_use_case', o: Partial<Extract<VdpGap['fix'], { kind: 'app' }>> = {}) => ({ kind: 'app' as const, op, field, current: null, suggested: null, options: [], values: {}, known: false, unsupported: null, ...o });

  it('no VDP yet, VDP lacks the company: the company, the VDP under it, then its people, a use case, its Generate, Find assets', () => {
    const g = (code: VdpGap['code'], fix: VdpGap['fix'], id: string = code) => ({ ...gap(code, { fix }), id: `account:acc-9:${id}`, vdpSlug: null, accountId: 'acc-9' }) as VdpGap;
    const s = vdpSteps({
      key: 'account:acc-9',
      companyName: 'Initech',
      vdpLabel: null,
      gaps: [
        g('company_not_in_vdp', app('name', 'create_company', { suggested: 'Initech', known: true })),
        g('opp_without_vdp', app('company_id', 'create_vdp', { values: { fiscal_year: 27, fiscal_quarter: 4, salesforce_opportunity_ids: ['006PLACEHOLDER0XYZ'] }, known: true })),
        g('no_ae', app('account_executives', 'set_vdp_owners')),
        g('no_ta', app('technical_architects', 'set_vdp_owners', { suggested: ['me@example.com'], known: true })),
        g('no_use_case', app('title', 'create_use_case')),
        g('no_ai_fields', app('ai_fields', 'generate_use_case', { suggested: 'generate', known: true }), 'no_ai_fields:new'),
      ],
      candidates: [],
      useCases: [],
    });
    expect(s.map((x) => [x.kind, x.apply?.key ?? null, x.requires])).toEqual([
      ['create_company', 'account:acc-9:create_company', []],
      ['create_vdp', 'account:acc-9:create_vdp', ['account:acc-9:create_company']],
      ['ae', 'account:acc-9:new_vdp:owners:ae', ['account:acc-9:create_company', 'account:acc-9:create_vdp']],
      ['ta', 'account:acc-9:new_vdp:owners:ta', ['account:acc-9:create_company', 'account:acc-9:create_vdp']],
      ['create_use_case', 'account:acc-9:new_vdp:create_use_case', ['account:acc-9:create_company', 'account:acc-9:create_vdp']],
      ['ai_fields', 'account:acc-9:new_vdp:create_use_case:generate', ['account:acc-9:create_company', 'account:acc-9:create_vdp', 'account:acc-9:new_vdp:create_use_case']],
      ['find_assets', null, ['account:acc-9:create_company', 'account:acc-9:create_vdp']],
    ]);
    expect(s[0]!.title).toBe('Create Initech in VDP');
    expect(s[1]).toMatchObject({ title: 'Create the FY27 Q4 VDP', handoff: null, disabled: null });
    // the company id is the one the company item makes (passed in by the push): shown, not typed, not required here
    expect(s[1]!.apply!.fields[0]).toMatchObject({ field: 'company_id', fixed: true, required: false, suggested: null });
    expect(s.every((x) => x.handoff === null)).toBe(true);
  });

  it('a VDP: opportunities, people, use cases (a Generate under its inputs), assets, header; each with its section', () => {
    const s = vdpSteps({
      key: 'acme',
      companyName: 'ACME',
      vdpLabel: 'ACME FY27 Q4',
      gaps: [
        gap('no_ta', { fix: app('technical_architects', 'set_vdp_owners', { suggested: ['me@example.com'], known: true }) }),
        gap('no_assets', { title: 'No assets on the VDP', fix: { kind: 'in_app', action: 'find_assets', label: 'Find assets' } }),
        gap('no_ai_fields', { useCaseId: 'u2', useCaseTitle: 'Deflection', fix: app('ai_fields', 'generate_use_case', { suggested: 'generate', known: true }) }),
        gap('use_case_field', { useCaseId: 'u2', useCaseTitle: 'Deflection', title: 'Deflection: Persona is empty', fix: app('persona') }),
        gap('use_case_field', { useCaseId: 'u2', useCaseTitle: 'Deflection', title: 'Deflection: Execution phase is empty', fix: app('execution_phase') }),
        gap('no_fiscal_period', { title: 'Fiscal quarter is not set', fix: app('fiscal_quarter', 'update_vdp_header') }),
        gap('opp_not_on_vdp', { title: 'Add ACME renewal', opportunityId: 'o-2', fix: app('add_opportunity_ids', 'update_vdp_header', { suggested: ['006PLACEHOLDER0002'], known: true }) }),
        gap('no_ae', { fix: app('account_executives', 'set_vdp_owners') }),
        gap('no_entitlement', { title: 'Entitlement leveraged is not set', fix: app('entitlement_leveraged', 'update_vdp_header', { options: ['Data Services', 'Flex', 'Conversations'], unsupported: "VDP's MCP can't take this yet: update_vdp_header.entitlement_leveraged" }) }),
      ],
      candidates: [{ id: 'c1', status: 'unsure', title: 'Recording' }],
      useCases: [{ id: 'u1', title: 'Profile' }, { id: 'u2', title: 'Deflection' }],
      addAsset: true,
    });
    expect(s.map((x) => [x.kind, x.section])).toEqual([
      ['add_opp', 'opportunities'],
      ['ae', 'people'],
      ['ta', 'people'],
      ['use_case_fields', 'use_cases'],
      ['ai_fields', 'use_cases'],
      ['assets', 'assets'],
      ['fiscal_period', 'header'],
      ['entitlement', 'header'],
    ]);
    const fields = s.find((x) => x.kind === 'use_case_fields')!;
    expect(fields).toMatchObject({ title: 'Deflection: Persona, Execution phase', apply: { key: 'acme:use_case:u2', op: 'update_use_case', label: 'Fill in 2 inputs' } });
    expect(fields.apply!.fields.map((f) => [f.field, f.required])).toEqual([
      ['persona', true],
      ['execution_phase', true],
    ]);
    // Generate goes after the inputs: a child of that item, requiring it
    expect(s.find((x) => x.kind === 'ai_fields')).toMatchObject({ parentKey: 'acme:use_case:u2', requires: ['acme:use_case:u2'], apply: { key: 'acme:generate:u2' } });
    expect(s.find((x) => x.kind === 'assets')).toMatchObject({ title: 'Confirm 1 asset found for ACME', apply: null });
    expect(s.find((x) => x.kind === 'entitlement')).toMatchObject({ apply: { key: 'acme:entitlement' }, disabled: "VDP's MCP can't take this yet: update_vdp_header.entitlement_leveraged" });
    expect(s.every((x) => x.state !== 'blocked' && x.handoff === null)).toBe(true);
  });

  it('no candidate: Find assets (in-app); all marked added after the last read = waiting', () => {
    const base = { key: 'acme', companyName: 'ACME', vdpLabel: 'ACME FY27 Q4', useCases: [], lastReadAt: '2026-11-10T10:00:00.000Z' };
    const none = vdpSteps({ ...base, gaps: [gap('no_assets', { title: 'No assets on the VDP', fix: { kind: 'in_app', action: 'find_assets', label: 'Find assets' } })], candidates: [] });
    expect(none.map((x) => [x.kind, x.apply])).toEqual([['find_assets', null]]);
    const added = vdpSteps({ ...base, gaps: [], candidates: [{ id: 'c1', status: 'added', title: 'Deck', statusAt: '2026-11-10T10:05:00.000Z' }] });
    expect(added).toMatchObject([{ kind: 'assets', state: 'waiting' }]);
  });
});

describe('Find assets planning', () => {
  const cov = {
    vdps: [
      { vdpSlug: 'acme', accountId: 'acc-1', companyName: 'ACME', fiscalYear: 27, fiscalQuarter: 4, assetCount: 2, lastActivityAt: null, gaps: [] },
      { vdpSlug: 'globex', accountId: 'acc-2', companyName: 'Globex', fiscalYear: 27, fiscalQuarter: 4, assetCount: 0, lastActivityAt: null, gaps: [] },
    ],
    unlinked: [gap('company_not_in_vdp', { title: 'Initech has no VDP', accountId: 'acc-3' } as Partial<VdpGap>)].map((g) => ({ ...g, accountId: 'acc-3' })),
  } as never;
  const accounts = [{ id: 'acc-1', name: 'ACME' }, { id: 'acc-2', name: 'Globex' }, { id: 'acc-3', name: 'Initech' }];

  it('all: VDPs without assets first, then accounts without a VDP; stops at the total cap; skips what is running', () => {
    // planned at what a run costs ($0.20 with no history), not the $0.50 per-run ceiling
    const p = planFindAssets({ body: { all: true, capUsd: 0.4 }, coverage: cov, snapshots: [], accounts, runs: new Map(), perRunUsd: 0.5, dayLeftUsd: 3 });
    expect(p.queued.map((q) => q.key)).toEqual(['globex', 'account:acc-3']);
    expect(p.skipped).toEqual([{ key: 'acme', companyName: 'ACME', why: 'over the $0.40 cap' }]);
    expect(p).toMatchObject({ estimateUsd: 0.4, ceilingUsd: 1, capUsd: 0.4, perRunUsd: 0.5, runUsd: 0.2 });
    const running = planFindAssets({ body: { key: 'globex' }, coverage: cov, snapshots: [], accounts, runs: new Map([['globex', { status: 'running', startedAt: '2026-11-10T10:00:00.000Z', finishedAt: null, found: 0, costUsd: null, note: null }]]), perRunUsd: 0.5, dayLeftUsd: 3 });
    expect(running.queued).toEqual([]);
    expect(running.note).toMatch(/already looking/);
  });

  it('nothing runs once the day line is used up, and the note says where to raise it', () => {
    const p = planFindAssets({ body: { key: 'acme' }, coverage: cov, snapshots: [], accounts, runs: new Map(), perRunUsd: 0.5, dayLeftUsd: 0.01 });
    expect(p.queued).toEqual([]);
    expect(p.note).toMatch(/daily limit is used up.*Settings ▸ Budgets/);
  });
});
