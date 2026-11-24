import { InMemoryScannerStore, type StoreProfile } from '../../../../src/scanner/store-memory';
import { FakeClock } from '../../../../src/scanner/runtime/clock';
import { ScannerRuntime, type ReevaluateReason } from '../../../../src/scanner/runtime/scanner-runtime';
import { slackSpec, type ConnectorSpec } from '../../../../src/scanner/runtime/connectors';
import type { CadenceConfig } from '../../../../src/scanner/runtime/cadence';
import { ScriptedSkillRunner, type Script } from './scripted-runner';

export const PROFILE: StoreProfile = {
  me: { userId: 'user_1', name: 'ME', email: 'me@example.com', slackId: 'U0ME00001', org62UserId: '005XX000000ME01AAA' },
  watchList: [],
  aliases: {
    accounts: [
      { accountId: 'ACME', names: ['ACME', 'ACME Corp', 'org62:001XX0000000001AAA'] },
      { accountId: 'GLOBEX', names: ['GLOBEX', 'GLOBEX Inc', 'org62:001XX0000000002AAA'] },
    ],
    channels: [],
  },
};

export function makeWorld(opts: { now: string; script: Script; specs?: ConnectorSpec[]; profile?: StoreProfile; cadence?: Partial<CadenceConfig>; softCapUsd?: number; hardCapUsd?: number }) {
  const clock = new FakeClock(opts.now);
  const store = new InMemoryScannerStore({ clock, profile: structuredClone(opts.profile ?? PROFILE), softCapUsd: opts.softCapUsd, hardCapUsd: opts.hardCapUsd });
  const runner = new ScriptedSkillRunner(opts.script);
  const reevaluated: Array<{ ids: string[]; reason: ReevaluateReason }> = [];
  const specs = opts.specs ?? [slackSpec({ mcpServers: () => ({}) })];
  const runtime = new ScannerRuntime({
    store,
    runner,
    specs,
    clock,
    reevaluate: async (ids, reason) => {
      reevaluated.push({ ids, reason: reason as ReevaluateReason });
    },
    cadence: opts.cadence,
  });
  return { clock, store, runner, runtime, reevaluated };
}

export const INBOX = { connector: 'slack' as const, scope: 'inbox' };
