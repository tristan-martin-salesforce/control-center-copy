/** The Slack MCP search takes keywords / filters / channel_types (no `query`): the recorder reads them, an unknown search is never "to me". */
import { describe, expect, it } from 'vitest';

import { createRunState } from '../../../src/llm/cc-tools';
import { SlackAutoRecorder } from '../../../src/llm/slack-rec';
import { InMemoryScannerStore } from '../../../src/scanner/store-memory';
import { PROFILE } from '../runtime/helpers/world';

const ME = 'U0PLACEME';
const W = { from: '2026-11-06T15:00:00.000Z', to: '2026-11-06T17:00:00.000Z' };
const TOOL = 'mcp__slack__slack_search_public_and_private';

const hit = (channelLine: string, id: string, ts: string, text = 'an alert fired') => ({
  results: `# Search Results\n\n## Messages (1 results)\n### Result 1 of 1\nChannel: ${channelLine} (ID: ${id})\nFrom: Bot <bot@example.com> (ID: U0PLACEBOT)\nTime: 2026-11-06 09:45:42 MST\nMessage_ts: ${ts}\nPermalink: [link](https://example.slack.com/archives/${id}/p1)\nText: \n${text}\n\n---\n\n`,
});

async function setup() {
  const store = new InMemoryScannerStore({ profile: { ...structuredClone(PROFILE), me: { ...PROFILE.me, slackId: ME } } as never });
  const ctx = await store.getContext({ connector: 'slack', scope: 'inbox' });
  const { runId } = await store.startRun({ scope: { connector: 'slack', scope: 'inbox' }, trigger: 'catch_up', window: W });
  const state = createRunState({ runId, connector: 'slack', window: W, context: ctx });
  return { state, rec: new SlackAutoRecorder(store, state, ctx) };
}
const payloadOf = (state: Awaited<ReturnType<typeof setup>>['state'], key: string) => state.items.get(key)?.payload as { query?: string; toMe?: boolean } | undefined;

describe('Slack search arguments (keywords / filters)', () => {
  it('a mention in keywords is "mentions" and addressed to me', async () => {
    const { state, rec } = await setup();
    await rec.onToolResult(TOOL, { keywords: [`<@${ME}>`], channel_types: 'public_channel,private_channel' }, hit('#team', 'C0TEAM001', '1793979942.000100'), 't1');
    expect(payloadOf(state, 'slack:C0TEAM001:1793979942.000100')).toMatchObject({ query: 'mentions', toMe: true });
  });

  it('a bare mention in filters, or an unrecognised search, is "other" and never addressed to me', async () => {
    const { state, rec } = await setup();
    await rec.onToolResult(TOOL, { filters: `<@${ME}>` }, hit('#alerts', 'C0ALERT01', '1793979942.000200'), 't1');
    await rec.onToolResult(TOOL, { response_format: 'detailed' }, hit('#alerts2', 'C0ALERT02', '1793979942.000300'), 't2');
    for (const key of ['slack:C0ALERT01:1793979942.000200', 'slack:C0ALERT02:1793979942.000300']) {
      const p = payloadOf(state, key);
      expect(p?.query).toBe('other');
      expect(p?.toMe).toBeUndefined();
    }
  });

  it('a DM search drops results outside DMs and group DMs', async () => {
    const { state, rec } = await setup();
    const args = { filters: `-from:<@${ME}>` };
    await rec.onToolResult(TOOL, args, hit('#alerts', 'C0ALERT01', '1793979942.000400'), 't1');
    await rec.onToolResult(TOOL, args, hit('DM', 'D0PLACEDM1', '1793979942.000500', 'got a minute?'), 't2');
    expect(payloadOf(state, 'slack:C0ALERT01:1793979942.000400')).toBeUndefined();
    expect(payloadOf(state, 'slack:D0PLACEDM1:1793979942.000500')).toMatchObject({ query: 'dm', toMe: true });
  });

  it('has:file in filters marks the message as carrying a file', async () => {
    const { state, rec } = await setup();
    await rec.onToolResult(TOOL, { filters: `from:<@${ME}> has:file` }, hit('DM', 'D0PLACEDM1', '1793979942.000600', 'here you go'), 't1');
    expect((payloadOf(state, 'slack:D0PLACEDM1:1793979942.000600') as { hasFile?: boolean }).hasFile).toBe(true);
  });
});
