/**
 * D-98 (0036), the pure parts: the promoted-field registry's split and conversions, the VDP child rows round trip on
 * the recorded mirror fixtures, the Slack / Gmail landing values (never message text), and Org62 id matching.
 * No database (tests/db/data/sidecar-db.test.ts runs them on Postgres).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { id15, isOrg62Id, org62Key, sameOrg62Id } from '../../src/connectors/org62/ids';
import { parseGetUseCase, parseGetVdp, withUseCaseDetail } from '../../src/connectors/vdp/parse';
import { coveredAeOf } from '../../src/engines/attribution/dc';
import { viaOf } from '../../src/engines/attribution/discover';
import { gmailLanding } from '../../src/outbox/adapters/gmail';
import { slackLanding } from '../../src/outbox/adapters/slack';
import { parseNeedKey } from '../../src/server/datasource/db/needs-decisions';
import { fromColumn, PROMOTED, splitExt, toColumn } from '../../src/server/datasource/db/store/sidecar';
import { childRowsOf, withChildren } from '../../src/server/datasource/db/vdp-mirror';
import { fixture } from '../vdp/helpers';

const field = (table: string, name: string) => PROMOTED[table]!.find((f) => f.field === name)!;

describe('promoted ext fields (store/sidecar.ts)', () => {
  it('splitExt: promoted fields go to their columns and leave the kv; the rest stays; dcAssigned stays in the kv for its listed readers', () => {
    const s = splitExt('opportunities', { nextStep: 'Demo', products: ['Data 360'], ownerId: '6d4600f8-b15d-5cc4-8cf2-ed74f6d53589', dcAssigned: true, hoursQtd: 3, org62Url: 'https://x' });
    expect(Object.fromEntries([...s.columns].map(([f, v]) => [f.column, v]))).toEqual({ dc_assigned: true, next_step: 'Demo', products: ['Data 360'], owner_person_id: '6d4600f8-b15d-5cc4-8cf2-ed74f6d53589', left_book_at: null });
    expect(s.kv).toEqual({ dcAssigned: true, hoursQtd: 3, org62Url: 'https://x' });
  });

  it('every dual-written field names readers that exist and still read the kv copy of it', () => {
    const dual = Object.values(PROMOTED).flat().filter((f) => f.dual);
    expect(dual.length).toBeGreaterThan(0);
    for (const f of dual) for (const r of f.dual!.readers) expect(readFileSync(resolve(__dirname, '../..', r), 'utf8'), `${r} reads ${f.field}`).toContain(`'${f.field}'`);
  });

  it('splitExt: an object with only promoted fields leaves no kv row; null clears every column', () => {
    expect(splitExt('activity_entries', { logNote: 'n', logNoteBasis: 'meeting_notes' }).kv).toBeNull();
    const cleared = splitExt('accounts', null);
    expect([...cleared.columns.values()]).toEqual([null, null]);
    expect(cleared.kv).toBeNull();
  });

  it('a value the column cannot hold (a malformed uuid) stays in the kv instead of being lost', () => {
    const s = splitExt('opportunities', { ownerId: 'not-a-uuid' });
    expect(s.kv).toEqual({ ownerId: 'not-a-uuid' });
    expect(toColumn(field('opportunities', 'ownerId'), 'not-a-uuid')).toBeNull();
  });

  it('conversions round-trip the ext shapes (empty = absent)', () => {
    const left = field('opportunities', 'leftBookAt');
    expect(fromColumn(left, new Date(toColumn(left, '2026-11-05T09:00:00.000Z') as string))).toBe('2026-11-05T09:00:00.000Z');
    const dc = field('opportunities', 'dcAssigned');
    expect([toColumn(dc, undefined), fromColumn(dc, false), fromColumn(dc, true)]).toEqual([false, undefined, true]);
    const products = field('opportunities', 'products');
    expect([toColumn(products, []), fromColumn(products, null), fromColumn(products, ['A'])]).toEqual([null, undefined, ['A']]);
    const sbu = field('work_items', 'startByUser');
    expect(fromColumn(sbu, toColumn(sbu, { value: null }))).toEqual({ value: null });
  });

  it('need decision keys parse to (rule, subject)', () => {
    expect(parseNeedKey('cc.need/home:missed_dc/gap:missed_dc')).toEqual({ rule: 'home:missed_dc', subjectId: 'gap:missed_dc' });
    expect(parseNeedKey('cc.need/dc_gap/')).toBeNull();
    expect(parseNeedKey('cc.ext/x/y')).toBeNull();
  });
});

describe('VDP child rows (vdp-mirror.ts) on the recorded mirror fixtures', () => {
  const details = new Map([parseGetUseCase(fixture('get_use_case_1'))!, parseGetUseCase(fixture('get_use_case_2'))!].map((u) => [u.id, u]));
  const snaps = ['get_vdp_acme', 'get_vdp_globex', 'get_vdp_other'].map((n) => withUseCaseDetail(parseGetVdp(fixture(n))!, details));

  it('every fixture reads back the same from its child rows (use cases, assets, people, in order)', () => {
    for (const s of snaps) {
      const rows = childRowsOf(s);
      expect(withChildren({ ...s, useCases: [], assets: [], aes: [], tas: [], collaborators: [], createdBy: null }, rows)).toEqual(s);
    }
  });

  it('an asset keeps "Deliverable not read" apart from "untagged"', () => {
    const base = snaps[0]!;
    const s = { ...base, assets: [{ id: 'a1', title: 'Deck', url: 'https://x/1', type: null, description: null }, { id: 'a2', title: null, url: 'https://x/2', type: 'Doc', description: null, deliverableType: null }] };
    const back = withChildren(base, childRowsOf(s)).assets;
    expect('deliverableType' in back[0]!).toBe(false);
    expect(back[1]).toEqual({ id: 'a2', title: null, url: 'https://x/2', type: 'Doc', description: null, deliverableType: null });
  });
});

describe('Slack / Gmail landing values (09 R5)', () => {
  it('carry ids, the target and the mode, never the text, subject or an address', () => {
    const s = slackLanding({ channel: 'C0PLACE', thread_ts: '1730812345.000100', text: 'secret body' }, 'send', { externalId: '1730812399.000200', link: 'https://simulated.slack.com/archives/C0PLACE/p1730812399000200' });
    expect(s).toEqual({ destination: 'slack', externalId: '1730812399.000200', values: { channel: 'C0PLACE', thread_ts: '1730812345.000100', mode: 'send', tool: 'slack_send_message', link: 'https://simulated.slack.com/archives/C0PLACE/p1730812399000200' } });
    const g = gmailLanding({ to: ['a@example.test'], cc: ['b@example.test'], subject: 'Private subject', html: '<p>body</p>', text: 'body', threadId: 't1' }, 'draft', { externalId: 'd1', link: null });
    expect(g).toEqual({ destination: 'gmail', externalId: 'd1', values: { thread_id: 't1', recipients: '2', mode: 'draft', tool: 'draft_gmail_message', link: null } });
    expect(JSON.stringify([s, g])).not.toMatch(/secret body|Private subject|example\.test|<p>/);
  });
});

describe('Org62 ids (connectors/org62/ids.ts) and the attribution matchers', () => {
  const ID18 = '006PLACEHOLDER0XYZ';
  const ID15 = '006PLACEHOLDER0';

  it('the 15- and 18-character forms are one record; empty never matches', () => {
    expect(id15(ID18)).toBe(ID15);
    expect([sameOrg62Id(ID18, ID15), sameOrg62Id(ID15, ID18), sameOrg62Id(null, null), sameOrg62Id('', ''), sameOrg62Id(ID18, '006OTHERRECORD0')]).toEqual([true, true, false, false, false]);
    expect(org62Key(ID18)).toBe(org62Key(ID15));
    expect([isOrg62Id(ID18, '006'), isOrg62Id(ID15, '006'), isOrg62Id(ID18, '001'), isOrg62Id('cc:abc')]).toEqual([true, true, false, false]);
  });

  it('a covered AE named by a 15-character user id matches the opp owner the 18-character id names', () => {
    const covered = [{ name: 'Placeholder AE', email: null, org62UserId: '005PLACEHOLDERA' }];
    expect(coveredAeOf({ owner: { name: 'Someone else', email: null, org62UserId: '005PLACEHOLDERAXYZ' } } as never, covered as never)).toEqual(covered[0]);
    expect(viaOf({ team: [{ userId: '005PLACEHOLDERBXYZ', role: null }], ownerOrg62Id: '005PLACEHOLDERAXYZ' } as never, null, new Set(['005PLACEHOLDERA']))).toBe('covered_ae');
    expect(viaOf({ team: [{ userId: '005PLACEHOLDERBXYZ', role: null }], ownerOrg62Id: null } as never, '005PLACEHOLDERB', new Set())).toBe('discovered');
  });
});
