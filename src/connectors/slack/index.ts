/** Slack: its manifest, its parsers, and its injected read transport (a one-tool Claude relay, decision H-3). */
import { buildRuntime, type RuntimeDeps } from '../runtime/build';
import type { ConnectorRuntime } from '../runtime/types';

import { slackManifest } from './manifest';

export { slackManifest } from './manifest';
export * from './parse';

/** The runtime Slack reads go through (fetch-then-interpret calls `runtime.call('slack_search_public_and_private', …)`). */
export const slackRuntime = (relay: RuntimeDeps['relay'] = {}): ConnectorRuntime => buildRuntime(slackManifest, { relay });
