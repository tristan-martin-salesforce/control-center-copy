import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, MissedOpp, ToolAdapterManifest } from '@/contract';
import { isClaudeUrl, openClaudeUrl, openInClaudeUrl, parseNewLink, promptPreview, startInClaudeUrl } from '@/components/agents/claude';
import { groupOf, groupRuns, layoutOf, pendingMoves } from '@/components/agents/groups';
import { estimatedDurationOf, fieldsFromSchema, initialValues, startCommandOf, toInputs, validate } from '@/components/agents/schema-form';
import { fmtAmount, fmtDate } from '@/components/deals/format';
import { dcLockDeadline, dcPromptDraft, DEFAULT_FILTERS, evidenceChip, filterMissed, missedNotes } from '@/components/deals/missed';

function run(over: Partial<AgentRun>): AgentRun {
  return {
    id: 'r1',
    kind: 'claude_session',
    title: 'T',
    workItemId: null,
    state: 'running',
    startedAt: '2026-11-05T10:00:00.000Z',
    updatedAt: '2026-11-05T10:05:00.000Z',
    finishedAt: null,
    lastEvent: 'x',
    waiting: null,
    deepLink: null,
    sessionId: null,
    cwd: null,
    bgAgents: 0,
    toolRunId: null,
    progress: null,
    resultUrl: null,
    error: null,
    costUsd: null,
    scheduled: false,
    ...over,
  };
}

function missed(over: Partial<MissedOpp>): MissedOpp {
  return {
    id: 'm1',
    verdict: 'claim',
    oppId: 'o1',
    oppName: 'ACME · Renewal',
    accountName: 'ACME',
    amount: 400_000,
    stage: 'Proposal',
    closeDate: '2027-01-15',
    evidence: ['Data 360 product line', 'Your account, no DC on this opp'],
    otherDcs: [],
    status: 'new',
    dismissReason: null,
    claimedWorkItemId: null,
    dcRequestId: null,
    foundAt: '2026-11-05T09:00:00.000Z',
    ...over,
  };
}

describe('Claude deep links', () => {
  it('Open in Claude uses the contract deepLink exactly (local_… host session id)', () => {
    const url = 'claude://code/continue?session=local_2bc0a1f4-1111-2222-3333-444455556666';
    expect(openInClaudeUrl(run({ deepLink: url }))).toBe(url);
  });

  it('builds a continue link from the host session id when there is no deepLink', () => {
    expect(openInClaudeUrl(run({ sessionId: 'local_abc 1' }))).toBe('claude://code/continue?session=local_abc%201');
  });

  it('app and tool runs have no Claude link; a new-session link is Start, not Open', () => {
    expect(openInClaudeUrl(run({ kind: 'app_run', deepLink: 'claude://code/continue?session=x' }))).toBeNull();
    const fresh = 'claude://code/new?folder=%2FUsers%2Fme%2Frepo&q=hello%20%5Bcc%3Aw1%5D';
    expect(openInClaudeUrl(run({ deepLink: fresh }))).toBeNull();
    expect(startInClaudeUrl(run({ deepLink: fresh }))).toBe(fresh);
  });

  it('only opens claude:// URLs, via the injected opener, and only when called', () => {
    const opener = vi.fn();
    expect(opener).not.toHaveBeenCalled();
    expect(openClaudeUrl('https://example.com', opener)).toBe(false);
    expect(openClaudeUrl('javascript:alert(1)', opener)).toBe(false);
    expect(opener).not.toHaveBeenCalled();
    expect(openClaudeUrl('claude://code/needs-input', opener)).toBe(true);
    expect(opener).toHaveBeenCalledWith('claude://code/needs-input');
    expect(isClaudeUrl('claude://code/continue?session=a')).toBe(true);
  });

  it('decodes a new link into folder + prompt and previews 20 lines', () => {
    const prompt = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const url = `claude://code/new?folder=${encodeURIComponent('/Users/me/Projects/x')}&q=${encodeURIComponent(prompt)}`;
    const parsed = parseNewLink(url)!;
    expect(parsed.folder).toBe('/Users/me/Projects/x');
    const p = promptPreview(parsed.prompt, 20);
    expect(p.lines).toHaveLength(20);
    expect(p.hidden).toBe(10);
  });
});

describe('Agents grouping', () => {
  it('orders waiting, running, done-review, failed, stale, done and files scheduled apart', () => {
    const runs = [
      run({ id: 'd', state: 'done' }),
      run({ id: 'w', state: 'waiting_on_you', waiting: { reason: 'q', question: null, choices: [], since: '2026-11-05T10:00:00.000Z' } }),
      run({ id: 'q', state: 'queued' }),
      run({ id: 'f', state: 'failed' }),
      run({ id: 's', state: 'stale' }),
      run({ id: 'r', state: 'done_review' }),
      run({ id: 'auto', state: 'done', scheduled: true }),
    ];
    expect(groupRuns(runs).map((g) => g.key)).toEqual(['waiting_on_you', 'running', 'done_review', 'failed', 'stale', 'done', 'scheduled']);
    expect(groupOf(run({ state: 'waiting_on_you', scheduled: true }))).toBe('waiting_on_you');
  });

  it('holds a row in its group while the user is in the list, and counts the pending moves', () => {
    const before = [run({ id: 'a', state: 'running' }), run({ id: 'b', state: 'running' })];
    const held = layoutOf(before);
    const after = [run({ id: 'a', state: 'waiting_on_you', waiting: { reason: 'q', question: null, choices: [], since: '2026-11-05T10:10:00.000Z' } }), before[1]!];
    expect(groupRuns(after, held).map((g) => g.key)).toEqual(['running']);
    expect(pendingMoves(after, held)).toBe(1);
    expect(groupRuns(after).map((g) => g.key)).toEqual(['waiting_on_you', 'running']);
  });
});

describe('Tool run forms from JSON Schema', () => {
  const schema = {
    type: 'object',
    required: ['customer', 'windowDays'],
    properties: {
      customer: { type: 'string', title: 'Customer', maxLength: 10 },
      context: { type: 'string', title: 'Context' },
      windowDays: { type: 'integer', minimum: 1, maximum: 365 },
      format: { type: 'string', enum: ['pptx', 'link'] },
      dryRun: { type: 'boolean', default: true },
    },
  };

  it('derives fields, kinds and required flags', () => {
    const f = fieldsFromSchema(schema);
    expect(f.map((x) => [x.key, x.kind, x.required])).toEqual([
      ['customer', 'text', true],
      ['context', 'textarea', false],
      ['windowDays', 'number', true],
      ['format', 'select', false],
      ['dryRun', 'boolean', false],
    ]);
    expect(f[2]!.label).toBe('Window Days');
  });

  it('validates, then coerces to request inputs (empty optionals dropped, mustache prefill ignored)', () => {
    const f = fieldsFromSchema(schema);
    const v = initialValues(f, { customer: '{{task.account.name}}' });
    expect(v.customer).toBe('');
    expect(validate(f, v)).toEqual({ customer: 'Required', windowDays: 'Required' });
    const filled = { ...v, customer: 'ACME', windowDays: '30', format: 'pptx' };
    expect(validate(f, filled)).toEqual({});
    expect(toInputs(f, filled)).toEqual({ customer: 'ACME', windowDays: 30, format: 'pptx', dryRun: true });
    expect(validate(f, { ...filled, customer: 'way too long here', windowDays: '1.5' })).toEqual({ customer: 'At most 10 characters', windowDays: 'Enter a whole number' });
  });

  it('reads the start command and a duration estimate from the manifest', () => {
    const m = {
      kind: 'http',
      lifecycle: { start: { cwd: '~/Projects/talk-track', argv: ['npm', 'start'], env: { PORT: '4320' } } },
    } as unknown as ToolAdapterManifest;
    expect(startCommandOf(m)).toBe('cd ~/Projects/talk-track && PORT=4320 npm start');
    expect(estimatedDurationOf(m).derived).toBe(true);
    expect(estimatedDurationOf({ ...m, estimatedDuration: { minSec: 120, maxSec: 900 } } as never).label).toBe('2 min to 15 min');
  });
});

describe('Missed opps', () => {
  it('derives the DC lock deadline per fiscal quarter', () => {
    expect(dcLockDeadline('2026-09-30')).toBe('2026-11-03');
    expect(dcLockDeadline('2026-12-15')).toBe('2027-02-03');
    expect(dcLockDeadline('2027-01-15')).toBe('2027-02-03');
    expect(dcLockDeadline('2027-03-01')).toBe('2027-05-03');
    expect(dcLockDeadline('2027-06-01')).toBe('2027-08-03');
  });

  it('shows the lock note past the deadline, the split note with other DCs, and the stranded flag', () => {
    const n = missedNotes(missed({ closeDate: '2026-09-30', otherDcs: ['Dana R.'], stage: 'Dead - Duplicate' }), '2026-11-05');
    expect(n.lock).toMatch(/manager exception/);
    expect(n.split).toMatch(/not a second 100%/);
    expect(n.stranded).toMatch(/Stranded DC/);
    const clean = missedNotes(missed({}), '2026-11-05');
    expect(clean).toEqual({ split: null, lock: null, lockSoon: null, stranded: null });
  });

  it('filters by verdict, open vs closed, amount and scope, keeping rows touched this session', () => {
    const list = [
      missed({ id: 'a' }),
      missed({ id: 'b', verdict: 'check', amount: 50_000 }),
      missed({ id: 'c', stage: '08 - Closed' }),
      missed({ id: 'd', status: 'claimed' }),
    ];
    const ids = (f: Partial<typeof DEFAULT_FILTERS>, touched: string[] = []) => filterMissed(list, { ...DEFAULT_FILTERS, ...f }, new Set(touched)).map((m) => m.id);
    expect(ids({})).toEqual(['a', 'b', 'c']);
    expect(ids({ verdict: 'check' })).toEqual(['b']);
    expect(ids({ stage: 'closed' })).toEqual(['c']);
    expect(ids({ minAmount: 100_000 })).toEqual(['a', 'c']);
    expect(ids({}, ['d'])).toEqual(['a', 'b', 'c', 'd']);
    expect(ids({ scope: 'handled' })).toEqual(['d']);
  });

  it('writes the Slackbot DC Comment Upload prompt (draft only) with split and evidence', () => {
    const p = dcPromptDraft(missed({ otherDcs: ['Dana R.'] }));
    expect(p).toContain('DC Comment Upload');
    expect(p).toContain('Role: AI + Data Architect');
    expect(p).toContain('50% (shared with Dana R.');
    expect(p).toContain('- Data 360 product line');
    expect(dcPromptDraft(missed({}))).toContain('Split: 100%');
  });

  it('maps evidence strings to source chips and formats amounts and dates', () => {
    expect(evidenceChip('Slack strong: thread with the AE').source).toBe('slack');
    expect(evidenceChip('calendar 3 mtgs').source).toBe('calendar');
    expect(evidenceChip('Gemini notes: review').source).toBe('gemini');
    expect(fmtAmount(516_000)).toBe('$516k');
    expect(fmtAmount(1_250_000)).toBe('$1.25M');
    // Whole millions keep their zeros: the stage-1 Deals header read "$5M open" for $50.1M.
    expect(fmtAmount(50_143_715)).toBe('$50M');
    expect(fmtAmount(20_000_000)).toBe('$20M');
    expect(fmtAmount(100_000_000)).toBe('$100M');
    expect(fmtAmount(2_000_000)).toBe('$2M');
    expect(fmtAmount(4_500_000)).toBe('$4.5M');
    expect(fmtAmount(null)).toBe('—');
    expect(fmtDate('2027-01-15')).toBe('15 Jan 2027');
  });
});
