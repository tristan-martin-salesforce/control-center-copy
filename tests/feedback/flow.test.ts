/**
 * D-56 · Report a bug / idea end to end on the mock DataSource: diagnose → stage (one Outbox item to the
 * server-resolved channel) → Send (dispatchDraft with the confirm token). Dry run blocks the post, "Post live" off
 * blocks it too, and a live send makes exactly one slack_send_message, to the configured channel. A fake transport
 * stands in for Slack: nothing leaves.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { routes, Seed, type RouteKey, type RouteOutput } from '../../src/contract';
import { MockDataSource } from '../../src/server/datasource/mock';
import { AppError } from '../../src/server/errors';
import { resolveFeedbackChannel, readTeamConfig } from '../../src/server/feedback/channel';
import { formatFeedbackMessage } from '../../src/server/feedback/format';
import { FakeMcp } from '../outbox/fake';

const seed = Seed.parse(JSON.parse(readFileSync(path.resolve(__dirname, '../../src/mock/seed.example.json'), 'utf8')));
const CHANNEL = 'C0FEEDBACK01';

let ds: MockDataSource;
let fake: FakeMcp;
beforeEach(() => {
  ds = new MockDataSource({ seed: structuredClone(seed), delays: { enrichMs: 5, stepMs: 5, chatTokenMs: 0, verifyMs: 5, reevalMs: 5 }, autoplay: false, clockMode: 'seed' });
  fake = new FakeMcp();
  ds.outbox.useTransport(fake);
});
afterEach(() => ds.dispose());

/** Parsed like the route handler, validated like its response. */
async function call<K extends RouteKey>(key: K, input: { params?: unknown; body?: unknown } = {}): Promise<RouteOutput<K>> {
  const def = routes[key] as { params?: { parse(v: unknown): unknown }; body?: { parse(v: unknown): unknown }; response: { safeParse(v: unknown): { success: boolean; error?: { issues: unknown[] } } } };
  const parsed: Record<string, unknown> = {};
  if (def.params) parsed.params = def.params.parse(input.params ?? {});
  if (def.body) parsed.body = def.body.parse(input.body ?? {});
  const out = await (ds[key as keyof MockDataSource] as (i: unknown) => Promise<unknown>).call(ds, parsed);
  const r = def.response.safeParse(out);
  if (!r.success) throw new Error(`${key} failed the contract: ${JSON.stringify(r.error?.issues.slice(0, 3))}`);
  return out as RouteOutput<K>;
}

async function patch(section: 'feedback' | 'sending', value: Record<string, unknown>) {
  const s = await call('getSettings');
  await call('patchSettings', { params: { section }, body: { ifVersion: s[section].version, value, ...(section === 'sending' ? { confirm: true } : {}) } });
}

async function report(text = 'The Time page should show the week hours but it shows 0 h') {
  const d = await call('diagnoseFeedback', { body: { kind: 'bug', text, context: { page: 'Time', route: '/time?tab=log', version: '0.1.0' } } });
  const staged = await call('stageFeedback', { body: { report: d.report, message: d.message } });
  return { d, staged: staged.entity };
}

const send = (s: RouteOutput<'stageFeedback'>['entity']) => call('dispatchDraft', { params: { id: s.draft.id }, body: { ifVersion: s.draft.version, mode: 'send', confirmToken: s.preview.confirmToken } });

describe('the channel', () => {
  it('config/team.json holds only the team channel (no secrets); settings win over it', () => {
    const file = path.resolve(__dirname, '../../config/team.json');
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    // the committed team default: a channel id and its name, nothing else (no tokens, no user data)
    expect(Object.keys(raw).sort()).toEqual(['feedbackChannelId', 'feedbackChannelName']);
    expect(raw.feedbackChannelId).toMatch(/^(|[CG][A-Z0-9]{6,})$/);
    expect(readTeamConfig(file)).toEqual(raw);
    const team = { feedbackChannelId: 'C0TEAMDEF01', feedbackChannelName: '#team-feedback' };
    expect(resolveFeedbackChannel({ channelId: '', channelName: '', postLive: true }, { dryRun: true }, team)).toMatchObject({ id: 'C0TEAMDEF01', source: 'team', live: false });
    expect(resolveFeedbackChannel({ channelId: CHANNEL, channelName: '#cc', postLive: true }, { dryRun: false }, team)).toMatchObject({ id: CHANNEL, source: 'settings', live: true });
    expect(resolveFeedbackChannel({ channelId: CHANNEL, channelName: '', postLive: false }, { dryRun: false }, team).live).toBe(false);
    expect(readTeamConfig('/nonexistent/team.json')).toEqual({ feedbackChannelId: '', feedbackChannelName: '' });
  });

  it('with no channel anywhere, staging refuses (nothing reaches the Outbox)', async () => {
    // no team default either: an empty team config, not the repo's (which names the team's channel)
    const prev = process.env.CC_TEAM_CONFIG;
    process.env.CC_TEAM_CONFIG = '/nonexistent/team.json';
    try {
      await noChannelAnywhere();
    } finally {
      if (prev === undefined) delete process.env.CC_TEAM_CONFIG;
      else process.env.CC_TEAM_CONFIG = prev;
    }
  });
});

async function noChannelAnywhere() {
  {
    const st = await call('getFeedback');
    expect(st.channel).toMatchObject({ id: '', source: 'none', live: false });
    const d = await call('diagnoseFeedback', { body: { kind: 'idea', text: 'A weekly digest would help' } });
    await expect(call('stageFeedback', { body: { report: d.report, message: d.message } })).rejects.toBeInstanceOf(AppError);
    expect((await call('getOutbox')).admin.items.some((x) => x.draft.destination.kind === 'action' && x.draft.destination.action === 'feedback.post')).toBe(false);
  }
}

describe('diagnose → stage → Send', () => {
  beforeEach(() => patch('feedback', { channelId: CHANNEL, channelName: '#cc-feedback' }));

  it('diagnose fills the report: title, steps, expected / actual, context, and a mrkdwn message', async () => {
    const { d } = await report();
    expect(d.diagnosedBy).toBe('fallback');
    expect(d.report).toMatchObject({ kind: 'bug', title: 'The Time page should show the week hours but it shows 0 h', expected: 'The Time page should show the week hours', actual: 'it shows 0 h', context: { version: '0.1.0', page: 'Time · /time?tab=log', persona: 'SE' } });
    // no "should": the whole text is what happened
    const plain = await call('diagnoseFeedback', { body: { kind: 'bug', text: 'The week shows 0 h but the Log has meetings' } });
    expect(plain.report).toMatchObject({ expected: '', actual: 'The week shows 0 h but the Log has meetings' });
    expect(d.report.diagnosis.files).toContain('src/components/time/TimePage.tsx');
    expect(d.message.split('\n')[0]).toBe(':beetle: *Bug: The Time page should show the week hours but it shows 0 h*');
    expect(d.message).toContain('v0.1.0 · channel dev · persona SE · page Time · /time?tab=log');
    expect(d.channel).toMatchObject({ id: CHANNEL, source: 'settings', dryRun: true, live: false });
  });

  it('stage makes ONE ready Outbox item to the configured channel, with the exact payload and a confirm token', async () => {
    const { staged } = await report();
    expect(staged.draft).toMatchObject({ status: 'ready', mode: 'send', destination: { kind: 'action', action: 'feedback.post', target: { label: '#cc-feedback' } } });
    expect(staged.preview.payload).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL, channelName: '#cc-feedback' });
    expect(staged.preview.confirmToken).toBeTruthy();
    expect(staged.preview.dryRun).toBe(true);
    const out = await call('getOutbox');
    // the feedback post is a message (D-56): the Outbox's own list, never an admin item that waits on Time
    const pendingList = out.groups.find((g) => g.group === 'pending_approval')!.items;
    expect(pendingList.filter((x) => x.draft.destination.kind === 'action' && x.draft.destination.action === 'feedback.post')).toHaveLength(1);
    expect(out.admin.items.filter((x) => x.draft.destination.kind === 'action' && x.draft.destination.action === 'feedback.post')).toHaveLength(0);
    expect((await call('getToday')).navCounts).toMatchObject({ adminWaiting: 0 });
  });

  it('global dry run blocks the post: the payload comes back, nothing is called', async () => {
    const { staged } = await report();
    const r = await send(staged);
    expect(r.dryRun).toBe(true);
    expect(r.payload).toMatchObject({ tool: 'slack_send_message', channel: CHANNEL });
    expect(r.attempt.outcome).toBe('rendered');
    expect(fake.calls).toEqual([]);
  });

  it('"Post live" off blocks it even with dry run off', async () => {
    await patch('feedback', { postLive: false });
    await patch('sending', { dryRun: false });
    const { staged } = await report();
    expect(staged.preview.dryRun).toBe(true);
    const r = await send(staged);
    expect(r.dryRun).toBe(true);
    expect(fake.calls).toEqual([]);
  });

  it('live: exactly one slack_send_message, top-level, to the configured channel only', async () => {
    await patch('sending', { dryRun: false });
    const { staged } = await report();
    const r = await send(staged);
    expect(r.dryRun).toBe(false);
    expect(fake.writes()).toEqual([{ server: 'slack', tool: 'slack_send_message', args: { channel_id: CHANNEL, message: expect.stringContaining('**Bug: The Time page should show the week hours') } }]);
    expect(Object.keys(fake.writes()[0]!.args).sort()).toEqual(['channel_id', 'message']);
    // the confirm token is single-use: a second Send of the same item is refused
    await expect(send(staged)).rejects.toBeInstanceOf(AppError);
    expect(fake.writes()).toHaveLength(1);
  });

  it('a wrong or missing confirm token never sends', async () => {
    await patch('sending', { dryRun: false });
    const { staged } = await report();
    await expect(call('dispatchDraft', { params: { id: staged.draft.id }, body: { ifVersion: staged.draft.version, mode: 'send', confirmToken: 'forged' } })).rejects.toBeInstanceOf(AppError);
    expect(fake.calls).toEqual([]);
  });

  it('editing after Send… replaces the earlier item: it leaves the Outbox, nothing sent', async () => {
    const { d, staged } = await report();
    const again = await call('stageFeedback', { body: { report: d.report, message: `${d.message}\nOne more detail.`, replaces: staged.draft.id } });
    const first = await call('getDraft', { params: { id: staged.draft.id } });
    expect(first.status).toBe('rejected');
    const pending = (await call('getOutbox')).groups.find((g) => g.group === 'pending_approval')!.items.filter((x) => x.draft.destination.kind === 'action' && x.draft.destination.action === 'feedback.post');
    expect(pending.map((x) => x.draft.id)).toEqual([again.entity.draft.id]);
  });
});

describe('the message format', () => {
  it('title line, kind, version / sha / persona / page, summary, steps, expected / actual, diagnosis, first name only', () => {
    const m = formatFeedbackMessage(
      {
        title: 'Log total is off',
        kind: 'bug',
        summary: 'The week total skips onsite rows.',
        steps: ['Open Time ▸ Log', 'Compare the week total'],
        expected: '12 h',
        actual: '9 h',
        diagnosis: { cause: 'buildActivityLog drops onsite frames', files: ['src/server/datasource/activity-log.ts'], confidence: 'medium' },
        context: { version: '0.1.0', sha: 'abc1234def', persona: 'SE', page: 'Time · /time?tab=log', entityKind: 'activity_entry' },
      },
      'Sam Placeholder',
    );
    expect(m).toBe(
      [
        ':beetle: *Bug: Log total is off*',
        'v0.1.0 · `abc1234` · persona SE · page Time · /time?tab=log · looking at: activity entry',
        '',
        '*Summary*',
        'The week total skips onsite rows.',
        '',
        '*Steps*',
        '1. Open Time ▸ Log',
        '2. Compare the week total',
        '',
        '*Expected:* 12 h',
        '*Actual:* 9 h',
        '',
        '*Diagnosis* (medium confidence)',
        'buildActivityLog drops onsite frames',
        'Files: `src/server/datasource/activity-log.ts`',
        '',
        '_Reported by Sam_',
      ].join('\n'),
    );
  });
});
