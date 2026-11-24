/** Org62: its manifest and its injected read transport (a one-tool Claude relay of `soqlQuery`, decision H-3). */
import { buildRuntime, type RuntimeDeps } from '../runtime/build';
import type { ConnectorRuntime } from '../runtime/types';

import { org62Manifest } from './manifest';

export { org62Manifest } from './manifest';

/** The runtime Org62 reads go through (fixed SOQL templates: `runtime.call('soqlQuery', { query })`). */
export const org62Runtime = (relay: RuntimeDeps['relay'] = {}): ConnectorRuntime => buildRuntime(org62Manifest, { relay });
