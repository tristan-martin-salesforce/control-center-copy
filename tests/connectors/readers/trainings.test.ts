import { describe, expect, it } from 'vitest';
import { classifyLinks, parseCertTable, parseDue, parseLoeMinutes, resolveMonthDay, TrainingsFetcher } from '@/connectors/google/trainings';
import { expandWatchScopes, planWatch, WatchScopeFetcher, type WatchSubscription } from '@/connectors/watch';
import { clock, FakeGoogle, fx, ME, NOW, signal, WINDOW } from './helpers';

const ref = (s: string) => new Date(s);

describe('due-date parsing (brief 10 §2.4)', () => {
  it('prose with weekday: "by Friday, Oct. 16" resolves against the message date', () => {
    expect(parseDue('FY27 Compliance Training Is Here', 'complete all assigned modules by Friday, Oct. 16.', ref('2026-08-18T14:00:00Z'))).toMatchObject({ due: '2026-10-16', dueSource: 'prose', overdue: false });
  });
  it('"Due Oct 16", "Due: Oct 16" and numeric "Due Friday, 10/16"', () => {
    expect(parseDue('', 'Due Oct 16', ref('2026-08-18T00:00:00Z')).due).toBe('2026-10-16');
    expect(parseDue('', 'Due: Oct 16', ref('2026-08-18T00:00:00Z')).due).toBe('2026-10-16');
    expect(parseDue('', 'Due Friday, 10/16', ref('2026-08-18T00:00:00Z')).due).toBe('2026-10-16');
  });
  it('a date earlier than the message date rolls to next year', () => {
    expect(resolveMonthDay(0, 15, undefined, ref('2026-12-20T00:00:00Z'))).toBe('2027-01-15');
    expect(resolveMonthDay(11, 4, undefined, ref('2026-10-22T00:00:00Z'))).toBe('2026-12-04');
  });
  it('table cell: "Completion Due Date | December 4, 2026"', () => {
    expect(parseDue('', 'Completion Due Date | December 4, 2026', ref('2026-10-22T00:00:00Z'))).toMatchObject({ due: '2026-12-04', dueSource: 'table' });
  });
  it('relative subject ladder', () => {
    const r = ref('2026-08-10T12:00:00Z');
    expect(parseDue('Your V2MOM is due tomorrow', '', r)).toMatchObject({ due: '2026-08-11', dueSource: 'relative' });
    expect(parseDue('Reminder: due in two weeks', '', r).due).toBe('2026-08-24');
    expect(parseDue('Reminder: due today', '', r).due).toBe('2026-08-10');
  });
  it('overdue is a status even without a date', () => {
    expect(parseDue('Action Required: You Have Overdue Assignments', 'please finish', ref('2026-07-23T00:00:00Z'))).toEqual({ overdue: true });
  });
  it('no date at all', () => expect(parseDue('Welcome', 'hello', ref('2026-01-01T00:00:00Z'))).toEqual({ overdue: false }));
  it('level of effort tokens', () => {
    expect(parseLoeMinutes('LOE: 6.5hrs')).toBe(390);
    expect(parseLoeMinutes('Aug 18 - Oct 16 | 2h')).toBe(120);
    expect(parseLoeMinutes('1 hour 20 minute Trail')).toBe(80);
    expect(parseLoeMinutes('nothing')).toBeUndefined();
  });
  it('keeps only allowed learning links, and stores tracking redirects separately', () => {
    const l = classifyLinks(['https://trailhead.salesforce.com/content/employee/trails/x', 'https://click.mail.example.com/?qs=abc', 'https://evil.example.org/phish', 'https://readiness.my.site.com/act/s/a', 'https://acme.my.trailhead.com/content/employee/modules/m']);
    expect(l.links).toEqual(['https://trailhead.salesforce.com/content/employee/trails/x', 'https://readiness.my.site.com/act/s/a', 'https://acme.my.trailhead.com/content/employee/modules/m']);
    expect(l.linkTracked).toBe('https://click.mail.example.com/?qs=abc'); // tracking redirects are kept apart, never fetched
    expect(classifyLinks(['https://click.mail.salesforce.com/?qs=abc']).linkTracked).toBe('https://click.mail.salesforce.com/?qs=abc');
  });
  it('certification table rows from flat text', () => {
    const rows = parseCertTable('x Completion Due Date Salesforce Certified Data Cloud Consultant 1 Maintenance Behind Data Cloud Spring Release Notes December 4, 2026 Salesforce Certified AI Associate 1 Maintenance Behind AI Spring Release Notes December 4, 2026', ref('2026-10-22T00:00:00Z'));
    expect(rows.map((r) => [r.certification, r.due])).toEqual([['Salesforce Certified Data Cloud Consultant', '2026-12-04'], ['Salesforce Certified AI Associate', '2026-12-04']]);
  });
});

describe('TrainingsFetcher', () => {
  const g = () =>
    new FakeGoogle({
      search_gmail_messages: () => fx('trainings', 'search_trainings.txt'),
      get_gmail_messages_content_batch: () => fx('trainings', 'batch_trainings.txt'),
      get_events: () => fx('calendar', 'events.txt').replace('"ACME_CORP workshop"', '"MANDATORY Partner Readiness Session"'),
    });
  const mk = (google = g()) => new TrainingsFetcher({ google, me: ME, clock });
  const byTitle = (items: Array<{ title?: string; payload?: Record<string, unknown> }>) => Object.fromEntries(items.map((i) => [i.title, i.payload!]));

  it('emits training_notice items with due, status, system, links and LOE; skips noise', async () => {
    const r = await mk().fetch('gmail', null, WINDOW, { signal });
    expect(r.items.every((i) => i.kind === 'training_notice' && i.connector === 'trainings')).toBe(true);
    const p = byTitle(r.items);
    expect(p['FY27 Compliance Training Is Here']).toMatchObject({ system: 'ACT', due: '2026-10-16', dueSource: 'prose', mandatory: true, loeMinutes: 150, link: 'https://readiness.my.site.com/act/s/assignments' });
    expect(p['Action Required: You Have Overdue Consumption Simulation Assignments']).toMatchObject({ system: 'Forge', status: 'overdue', mandatory: true });
    expect(r.items.some((i) => /The Daily/.test(i.title ?? ''))).toBe(false);
  });

  it('a certification email yields one item per certification, due Dec 4', async () => {
    const r = await mk().fetch('gmail', null, WINDOW, { signal });
    const certs = r.items.filter((i) => (i.payload as { system: string }).system === 'Cert');
    expect(certs.map((c) => c.title)).toEqual(['Salesforce Certified Data Cloud Consultant', 'Salesforce Certified AI Associate']);
    expect(certs.every((c) => (c.payload as { due: string }).due === '2026-12-04')).toBe(true);
    expect(new Set(certs.map((c) => c.dedupeKey)).size).toBe(2);
  });

  it('status ladder from the due date: assigned > due_soon > overdue', async () => {
    const f = new TrainingsFetcher({ google: g(), me: ME, clock: () => new Date('2026-10-12T00:00:00Z') });
    const r = await f.fetch('gmail', null, WINDOW, { signal });
    expect(byTitle(r.items)['FY27 Compliance Training Is Here']).toMatchObject({ status: 'due_soon' });
    const late = new TrainingsFetcher({ google: g(), me: ME, clock: () => new Date('2026-10-20T00:00:00Z') });
    expect(byTitle((await late.fetch('gmail', null, WINDOW, { signal })).items)['FY27 Compliance Training Is Here']).toMatchObject({ status: 'overdue' });
  });

  it('itemKey lets a later reminder update the same training (brief 10 §2.5)', async () => {
    const r = await mk().fetch('gmail', null, WINDOW, { signal });
    const k = (r.items.find((i) => i.title === 'FY27 Compliance Training Is Here')!.payload as { itemKey: string }).itemKey;
    expect(k).toBe('ACT:fy27 compliance training');
  });

  it('cursor + idempotency + coverage', async () => {
    const f = mk();
    const r1 = await f.fetch('gmail', null, WINDOW, { signal });
    expect(r1.coverage.filter((c) => c.kind === 'email').length).toBe(4);
    expect(r1.coverage.some((c) => c.kind === 'query_window')).toBe(true);
    const r2 = await f.fetch('gmail', r1.nextCursor, WINDOW, { signal });
    expect(r2.items).toHaveLength(0);
  });

  it('calendar scope: mandatory sessions in the next 14 days, once', async () => {
    const f = mk();
    const r1 = await f.fetch('calendar', null, WINDOW, { signal });
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]!.payload).toMatchObject({ system: 'Calendar', mandatory: true, dueSource: 'calendar', due: '2026-03-11' });
    expect((await f.fetch('calendar', r1.nextCursor, WINDOW, { signal })).items).toHaveLength(0);
  });

  it('redacts credentials in excerpts', async () => {
    const g2 = g();
    g2.routes.get_gmail_messages_content_batch = () => fx('trainings', 'batch_trainings.txt').replace('Please complete', 'password: hunter2hunter2 Please complete');
    const r = await mk(g2).fetch('gmail', null, WINDOW, { signal });
    expect(JSON.stringify(r.items)).not.toContain('hunter2');
  });

  it('listForReconcile', async () => {
    const l = await mk().listForReconcile!('gmail', WINDOW, { signal });
    expect(l.length).toBe(4);
  });
});

describe('watch scope expansion (R-UI-21)', () => {
  const subs: WatchSubscription[] = [
    { id: 'w1', kind: 'slack_channel', ref: 'C0TEAMUPD', label: '#team-updates', why: 'team channel' },
    { id: 'w2', kind: 'opp', ref: '006XX0000000001', label: 'ACME_CORP renewal', period: 'daily' },
    { id: 'w3', kind: 'slack_channel', ref: 'C0OFF', label: '#off', enabled: false },
    { id: 'w4', kind: 'slack_channel', ref: 'C0TEAMUPD', label: 'dup' },
  ];

  it('expands enabled subscriptions to unique scopes', () => {
    expect(expandWatchScopes(subs)).toEqual(['slack:channel:C0TEAMUPD', 'opp:006XX0000000001']);
  });

  it('window is since the last brief, or the last 24 h for daily; Slack args use ts seconds', () => {
    const p = planWatch({ ...subs[0]!, lastBriefAt: '2026-03-10T12:00:00.000Z' }, null, NOW);
    expect(p.window).toEqual({ from: '2026-03-10T12:00:00.000Z', to: NOW.toISOString() });
    expect(p.slack).toMatchObject({ channelId: 'C0TEAMUPD', oldest: (Date.parse('2026-03-10T12:00:00.000Z') / 1000).toFixed(6) });
    const d = planWatch(subs[1]!, null, NOW);
    expect(d.window.from).toBe(new Date(NOW.getTime() - 86400_000).toISOString());
    expect(d.org62).toEqual({ oppId: '006XX0000000001' });
  });

  it('the fetcher emits one scope-plan item per run and advances the cursor to the window end', async () => {
    const f = new WatchScopeFetcher({ subscriptions: async () => subs, clock });
    expect(await f.scopes({ userId: 'u' })).toEqual(['slack:channel:C0TEAMUPD', 'opp:006XX0000000001']);
    const r1 = await f.fetch('slack:channel:C0TEAMUPD', null, WINDOW, { signal });
    expect(r1.items).toHaveLength(1);
    expect(r1.items[0]).toMatchObject({ connector: 'watch', kind: 'manual_note' });
    expect((r1.items[0]!.payload as { plan: { slack: { channelId: string } } }).plan.slack.channelId).toBe('C0TEAMUPD');
    expect(r1.nextCursor.at).toBe(NOW.toISOString());
    const f2 = new WatchScopeFetcher({ subscriptions: async () => subs, clock: () => new Date(NOW.getTime() + 3600_000) });
    await f2.scopes({ userId: 'u' });
    const r2 = await f2.fetch('slack:channel:C0TEAMUPD', r1.nextCursor, WINDOW, { signal });
    expect((r2.items[0]!.payload as { plan: { window: { from: string } } }).plan.window.from).toBe(NOW.toISOString());
  });
});
