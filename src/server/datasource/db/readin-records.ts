/**
 * Read-in context records on Postgres: the same read model the UI uses (model.ts), adapted to `ReadInRecords`
 * (src/llm/readin/context.ts), plus each item's reeval_generation and the private voice profile.
 * Kept apart from readin.ts so model.ts can import readInStates without an import cycle.
 */
import { sql } from 'drizzle-orm';

import type { Evidence } from '@/contract';
import type { Db } from '@/db/client';
import { loadVoiceProfile } from '@/engines/voice/store';
import { renderVoiceForPrompt } from '@/engines/voice/render';
import type { ReadInRecords } from '@/llm/readin/context';

import { loadModel } from './model';
import { everything } from './reads/scope';

export async function loadReadInRecords(db: Db, userId: string, now: Date, opts: { voiceChannel?: 'slack' | 'email' } = {}): Promise<ReadInRecords> {
  const model = await loadModel(db, userId, now, { scope: everything('read-in records') });
  const gens = new Map(
    ((await db.execute(sql`select id, reeval_generation as g from work_items where owner_user_id = ${userId}`)).rows as Array<{ id: string; g: string }>).map((r) => [r.id, Number(r.g)]),
  );
  const email = ((await db.execute(sql`select email from users where id = ${userId}`)).rows as Array<{ email: string }>)[0]?.email;
  let voice: string | null = null;
  try {
    const p = loadVoiceProfile();
    if (p) voice = renderVoiceForPrompt(p, { audience: 'internal', channel: opts.voiceChannel ?? 'slack' });
  } catch {
    voice = null;
  }
  const evidenceBy = new Map<string, Evidence[]>();
  for (const e of model.all('evidence')) evidenceBy.set(e.workItemId, [...(evidenceBy.get(e.workItemId) ?? []), e]);
  return {
    me: { id: model.ctx.me.id, name: model.ctx.me.name, ...(email ? { email } : {}) },
    timezone: model.ctx.timezone,
    now,
    workItem: (id) => model.get('workItems', id),
    workItems: () => model.all('workItems'),
    evidence: (id) => [...(evidenceBy.get(id) ?? [])],
    initiative: (id) => model.get('initiatives', id),
    account: (id) => model.get('accounts', id),
    opp: (id) => model.get('opps', id),
    event: (id) => model.get('events', id),
    person: (id) => model.get('people', id),
    drafts: (id) => model.all('drafts').filter((d) => d.workItemId === id),
    generation: (id) => gens.get(id) ?? 0,
    voice,
  };
}
