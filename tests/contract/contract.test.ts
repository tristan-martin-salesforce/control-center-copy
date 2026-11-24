import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  API_ERROR_STATUS,
  ItemActionRequest,
  PatchDraftRequest,
  ROUTE_KEYS,
  Seed,
  WorkKind,
  WorkState,
  RunState,
  buildPath,
  routes,
} from '@/contract';
import { parseSeed, shiftDates, SeedError } from '@/server/datasource/mock/seed-loader';

const root = path.resolve(__dirname, '../..');
const seedPath = path.join(root, 'src/mock/seed.example.json');
const raw = JSON.parse(readFileSync(seedPath, 'utf8'));

describe('contract', () => {
  it('the committed example seed validates against the Seed contract', () => {
    const r = Seed.safeParse(raw);
    if (!r.success) console.error(r.error.issues.slice(0, 10));
    expect(r.success).toBe(true);
  });

  it('the example seed is rich enough to render every surface and state', () => {
    const seed = Seed.parse(raw);
    expect(seed.workItems.length).toBeGreaterThanOrEqual(30);
    expect(new Set(seed.workItems.map((w) => w.state))).toEqual(new Set(WorkState.options));
    expect(new Set(seed.workItems.map((w) => w.kind))).toEqual(new Set(WorkKind.options));
    expect(new Set(seed.agentRuns.map((r) => r.state))).toEqual(new Set(RunState.options));
    expect(seed.initiatives).toHaveLength(3);
    // D-69: four more accounts and opps for the VDP company identity (a child, a subsidiary, Needs you, a mapping)
    expect(seed.accounts).toHaveLength(9);
    expect(seed.opps).toHaveLength(13);
    expect(seed.missedOpps).toHaveLength(4);
    expect(seed.briefs.filter((b) => b.kind === 'channel')).toHaveLength(1);
    expect(seed.briefs.filter((b) => b.kind === 'opp')).toHaveLength(2);
    expect(seed.watches).toHaveLength(2);
    expect(seed.connectors).toHaveLength(8);
    expect(new Set(seed.connectors.map((c) => c.state)).size).toBeGreaterThanOrEqual(4);
    expect(seed.toolAdapters.map((t) => t.id).sort()).toEqual(['afd360-estimator', 'pulse-footprint', 'talk-track']);
    expect(seed.jobs.some((j) => j.status === 'dead')).toBe(true);
    expect(seed.settings.policy.version).toBe(3);
    expect(seed.policyVersions.map((v) => v.version)).toEqual([1, 2, 3]);
    expect(seed.chatThreads.some((t) => t.messages.some((m) => m.isMorningBrief))).toBe(true);
    expect(new Set(seed.drafts.map((d) => d.destination.kind))).toEqual(new Set(['slack', 'email']));
    expect(new Set(seed.activity.map((a) => a.status)).size).toBe(9);
    const today = seed.calendar.events.filter((e) => e.start.slice(0, 10) === seed.meta.asOf.slice(0, 10));
    expect(today.length).toBeGreaterThanOrEqual(7);
    expect(today.length).toBeLessThanOrEqual(9);
    expect(today.some((e) => e.attendance === 'missed' && e.takeaways)).toBe(true);
    expect(seed.workItems.some((w) => w.userLockedFields.length > 0)).toBe(true);
    expect(seed.workItems.filter((w) => w.resolution === 'handed_off')).toHaveLength(2);
    expect(seed.workItems.some((w) => w.loopedBackIn)).toBe(true);
    expect(seed.workItems.some((w) => w.isBackground && w.kind === 'commitment')).toBe(true);
    expect(seed.scenario?.length).toBeGreaterThanOrEqual(7);
  });

  it('seed references resolve (no dangling ids)', () => {
    const seed = Seed.parse(raw);
    const items = new Set(seed.workItems.map((w) => w.id));
    const nbas = new Set(seed.nbas.map((n) => n.id));
    const drafts = new Set(seed.drafts.map((d) => d.id));
    const runs = new Set(seed.agentRuns.map((r) => r.id));
    const events = new Set(seed.calendar.events.map((e) => e.id));
    for (const w of seed.workItems) {
      if (w.nbaId) expect(nbas.has(w.nbaId), `${w.id}.nbaId`).toBe(true);
      for (const r of w.runIds) expect(runs.has(r), `${w.id}.runIds`).toBe(true);
      if (w.servesEventId) expect(events.has(w.servesEventId), `${w.id}.servesEventId`).toBe(true);
    }
    for (const n of seed.nbas) {
      expect(items.has(n.workItemId), `${n.id}.workItemId`).toBe(true);
      if (n.draftId) expect(drafts.has(n.draftId), `${n.id}.draftId`).toBe(true);
    }
    for (const e of seed.evidence) expect(items.has(e.workItemId), `${e.id}.workItemId`).toBe(true);
    for (const s of seed.scenario ?? []) {
      for (const a of s.actions) {
        if ('itemId' in a) expect(items.has(a.itemId), `${s.id}.itemId`).toBe(true);
        if ('nbaId' in a) expect(nbas.has(a.nbaId), `${s.id}.nbaId`).toBe(true);
        if ('runId' in a) expect(runs.has(a.runId), `${s.id}.runId`).toBe(true);
      }
    }
  });

  it('the example seed carries no real-looking secrets or private paths', () => {
    const text = readFileSync(seedPath, 'utf8');
    expect(text).not.toMatch(/xox[abp]-|sk-ant-|ghp_|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH) PRIVATE KEY/);
    expect(text).not.toMatch(/tristan/i);
  });

  it('every route has a generated route file exporting its method', () => {
    for (const key of ROUTE_KEYS) {
      const def = routes[key];
      const dir = def.path
        .split('/')
        .filter(Boolean)
        .map((s) => (s.startsWith(':') ? `[${s.slice(1)}]` : s));
      const file = path.join(root, 'app/api/v1', ...dir, 'route.ts');
      expect(existsSync(file), `${key} → ${file}`).toBe(true);
      expect(readFileSync(file, 'utf8')).toContain(`export const ${def.method} = handle('${key}');`);
    }
  });

  it('maps error codes to HTTP statuses', () => {
    expect(API_ERROR_STATUS.conflict).toBe(409);
    expect(API_ERROR_STATUS.validation).toBe(400);
    expect(API_ERROR_STATUS.not_found).toBe(404);
    expect(API_ERROR_STATUS.upstream_unavailable).toBe(503);
  });

  it('request schemas accept typical bodies and reject bad ones', () => {
    expect(ItemActionRequest.safeParse({ ifVersion: 2, resolution: 'handed_off', detail: { personName: 'Kim Tran' } }).success).toBe(true);
    expect(ItemActionRequest.safeParse({ ifVersion: 0 }).success).toBe(false);
    expect(PatchDraftRequest.safeParse({ ifVersion: 1, doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] } }).success).toBe(true);
    expect(buildPath('/items/:id/actions/:verb', { id: 'w 1', verb: 'done' })).toBe('/items/w%201/actions/done');
  });

  it('shiftDates moves instants and days by whole days, keeping wall-clock time', () => {
    const out = shiftDates({ a: '2026-11-05T16:02:00.000Z', b: '2026-11-05', c: 'not a date', d: [{ e: '2026-11-04T01:00:00Z' }] }, 3);
    expect(out.a).toBe('2026-11-08T16:02:00.000Z');
    expect(out.b).toBe('2026-11-08');
    expect(out.c).toBe('not a date');
    expect(out.d[0].e).toBe('2026-11-07T01:00:00.000Z');
  });

  it('parseSeed fails loudly with readable paths', () => {
    const broken = { ...raw, workItems: [{ ...raw.workItems[0], state: 'nope' }] };
    expect(() => parseSeed(broken, 'test seed')).toThrow(SeedError);
    expect(() => parseSeed(broken, 'test seed')).toThrow(/workItems\.0\.state/);
  });
});
