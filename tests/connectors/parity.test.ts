/**
 * Parity (p1-connector-runtime): each connector's fetch over its recorded fixtures yields the same normalized items,
 * coverage and cursor through its transport directly and through the `ConnectorRuntime` the registry injects. The
 * file snapshots under `__snapshots__/parity/` were written from the direct path BEFORE the runtime seam landed
 * (commit "parity snapshots … before the runtime seam"); both paths must keep matching them.
 */
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { manifestOf } from '@/connectors/registry';
import { buildRuntime } from '@/connectors/runtime/build';
import { textPort } from '@/connectors/runtime/direct-mcp';
import { localFilesPort } from '@/connectors/runtime/local-files';
import { VdpClient } from '@/connectors/vdp/client';
import type { HookCallback, Options, SDKMessage } from '@/llm/provider';
import type { QueryFn } from '@/llm/skill-runner';

import { cleanupParity, directGoogle, directRelay, directVdp, googleOutputs, relayParses, sessionsOutputs, show, vdpOutputs, type GoogleWrap, type RelayRead, type SessionsWrap, type VdpMake } from './parity-harness';

const SNAP = join(__dirname, '__snapshots__', 'parity');

afterAll(cleanupParity);

async function expectSnapshots(google: GoogleWrap, vdp: VdpMake, sessions: SessionsWrap, relay: RelayRead) {
  for (const [k, v] of Object.entries(await googleOutputs(google))) await expect(show(v)).toMatchFileSnapshot(join(SNAP, `${k}.json`));
  await expect(show(await vdpOutputs(vdp))).toMatchFileSnapshot(join(SNAP, 'vdp.mine.json'));
  await expect(show(await sessionsOutputs(sessions))).toMatchFileSnapshot(join(SNAP, 'claude_sessions.all.json'));
  for (const [k, v] of Object.entries(await relayParses(relay))) await expect(show(v)).toMatchFileSnapshot(join(SNAP, `${k}.json`));
}

/** The relay over a fake run: the one tool is let through and its result is the recorded fixture text. */
const relayThroughRuntime: RelayRead = async (connector, tool, fixture) => {
  const text = await directRelay(connector, tool, fixture);
  const queryFn: QueryFn = ({ options }: { options: Options }) =>
    (async function* () {
      const pre = options.hooks!.PreToolUse![0]!.hooks[0] as HookCallback;
      await pre({ hook_event_name: 'PreToolUse', tool_name: options.allowedTools![0]!, tool_input: {}, session_id: 's', transcript_path: '', cwd: '' } as never, 'tu', { signal: new AbortController().signal });
      yield { type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text }] }] } } as unknown as SDKMessage;
      yield { type: 'result', total_cost_usd: 0, modelUsage: {} } as unknown as SDKMessage;
    })();
  const m = manifestOf(connector);
  const rt = buildRuntime(tool === 'slack_read_channel' ? manifestOf('watch') : m, { relay: { queryFn, mcpServersFor: (c) => ({ [c === 'org62' ? 'Org62-Sobject-Read' : 'slack']: { type: 'http', url: 'https://mcp.example.test' } }) } });
  return (await rt.call(tool, {})).text;
};

describe('connector parity over the recorded fixtures', () => {
  it('direct transport (the snapshots were written from it)', async () => {
    await expectSnapshots(directGoogle, directVdp, (o) => o, directRelay);
  });

  it('through the registry-injected ConnectorRuntime: identical items, coverage and cursors', async () => {
    await expectSnapshots(
      (fake, c) => textPort(buildRuntime(manifestOf(c), { mcp: fake })),
      (o) => new VdpClient({ ...o, runtime: buildRuntime(manifestOf('vdp'), { http: o }) }),
      (o) => ({ ...o, files: localFilesPort(buildRuntime(manifestOf('claude_sessions'), { roots: [o.sessionsDir, o.projectsDir, o.desktopDir] })) }),
      relayThroughRuntime,
    );
  });
});
