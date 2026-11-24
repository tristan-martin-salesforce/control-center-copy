/** The same conformance suite against BE-2a's reference InMemoryScannerStore (no database needed). */
import { randomUUID } from 'node:crypto';

import { InMemoryScannerStore } from '@/scanner/store-memory';

import { runScannerStoreConformance, type ConformanceHarness } from './store-conformance';

export async function makeMemoryHarness(): Promise<ConformanceHarness> {
  const store = new InMemoryScannerStore({ profile: { me: { userId: 'user_1', name: 'ME' }, aliases: { accounts: [], channels: [] } } });
  return {
    store,
    async seedAccount({ name, aliases }) {
      const id = `acct_${randomUUID().slice(0, 8)}`;
      store.profile.aliases!.accounts.push({ accountId: id, names: [name, ...(aliases ?? [])] });
      return id;
    },
    async seedInitiative({ title, purpose, accountId }) {
      return store.seedInitiative({ title, purpose, accounts: accountId ? [accountId] : [] });
    },
    async seedWorkItem(i) {
      return store.seedWorkItem({
        kind: i.kind ?? 'task',
        title: i.title,
        purpose: i.purpose,
        state: i.status ?? 'open',
        accounts: i.accountId ? [i.accountId] : [],
        initiativeId: i.initiativeId,
        people: i.counterparty ? [i.counterparty.name, ...(i.counterparty.email ? [i.counterparty.email] : [])] : [],
        resolution: i.resolution,
        involvement: i.involvement,
        doneAt: i.status === 'done' ? (i.doneAt ?? new Date().toISOString()) : undefined,
      });
    },
    async workItem(id) {
      const w = store.getWorkItem(id);
      return w ? { status: w.state, title: w.title } : null;
    },
    async evidence(workItemId) {
      return store.evidenceFor(workItemId).map((e) => ({ sourceItemId: e.sourceItemId, role: e.role }));
    },
    async countSourceItems(dedupeKey) {
      return store.getSourceItemByDedupe(dedupeKey) ? 1 : 0;
    },
    close: async () => undefined,
  };
}

runScannerStoreConformance('InMemoryScannerStore', makeMemoryHarness);
