/**
 * Dev-preview thread for /assistant?embed=panel|page&fixture=1: every v2 message and card type in one
 * thread, built around real ids from the running mock (items, a Claude session, a draft) so the cards
 * that fetch live data have something to show. Copy is placeholder only; titles come from the seed.
 */
import type { ChatResource, ChatThread, Proposal, Receipt, WorkItem } from '@/contract';
import type { ChatActionsState, ChatMessageView, ChatToolView } from '@/client/chat';

export interface FixtureRefs {
  now: Date;
  items: Pick<WorkItem, 'id' | 'title'>[];
  runId: string | null;
  runTitle: string | null;
  draftId: string | null;
  draftLabel: string | null;
  scan: 'running' | 'done';
}

const at = (now: Date, minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();

function msg(p: Partial<ChatMessageView> & Pick<ChatMessageView, 'id' | 'role' | 'at'>): ChatMessageView {
  return { threadId: 'fx_today', text: '', context: [], isMorningBrief: false, tools: [], receipts: [], proposals: [], resources: [], streaming: false, error: null, stopped: false, pending: false, ...p };
}

const tool = (id: string, name: string, startSummary: string, summary: string, ok: boolean | null = true): ChatToolView => ({ id, name, startSummary, summary, ok });

export const FIXTURE_PROPOSAL_ID = 'fx_prop_move';
export const FIXTURE_AUDIT_ID = 'fx_aud_move';

export function fixtureProposal(r: FixtureRefs): Proposal {
  const second = r.items[1] ?? { id: 'fx_item_2', title: 'Post a short status to the sizing thread' };
  return {
    id: FIXTURE_PROPOSAL_ID,
    entity: { type: 'work_item', id: second.id, label: second.title, href: `/work/${second.id}` },
    changes: [
      { field: 'rank', label: 'Rank', before: 2, after: 1 },
      { field: 'startBy', label: 'Start by', before: null, after: at(r.now, -40) },
    ],
    reason: 'Moved ahead at your request',
    source: null,
    createdAt: at(r.now, 2),
    status: 'pending',
    actor: 'chat',
    baseVersion: null,
    textDiff: null,
    resolvedAt: null,
  };
}

export function fixtureAppliedReceipt(r: FixtureRefs): Receipt {
  const [a, b, c] = [r.items[0], r.items[1], r.items[2]].map((x, i) => x ?? { id: `fx_item_${i + 1}`, title: `Item ${i + 1}` });
  return {
    id: 'fx_rcpt_move',
    at: at(r.now, 1),
    actor: 'chat',
    summary: `Do now is updated. “${a.title}” is #2 now.`,
    staged: false,
    changes: [
      { auditId: FIXTURE_AUDIT_ID, entity: { type: 'work_item', id: b.id, label: b.title }, field: 'rank', label: 'Rank', before: 2, after: 1 },
      { auditId: FIXTURE_AUDIT_ID, entity: { type: 'work_item', id: c.id, label: c.title }, field: 'snoozedUntil', label: 'Snooze', before: null, after: at(r.now, -300) },
    ],
  };
}

export function fixtureActions(r: FixtureRefs, applied: boolean): ChatActionsState {
  if (!applied) return { undo: {}, proposals: {} };
  return { undo: {}, proposals: { [FIXTURE_PROPOSAL_ID]: { status: 'applied', auditId: FIXTURE_AUDIT_ID, receipt: fixtureAppliedReceipt(r) } } };
}

export function fixtureThreads(now: Date): ChatThread[] {
  const t = (id: string, title: string, minutesAgo: number, preview: string, isDefault = false): ChatThread => ({
    id,
    title,
    isDefault,
    createdAt: at(now, minutesAgo + 30),
    updatedAt: at(now, minutesAgo),
    messageCount: 6,
    lastMessagePreview: preview,
  });
  return [
    t('fx_today', 'Today', 2, '1 session running · 2 changes applied', true),
    t('fx_week', 'Week planning', 60 * 24, 'Deck Wednesday, then the review on Thursday'),
    t('fx_prep', 'Demo prep', 60 * 26, 'Smoke-test plan for both demos'),
    t('fx_sizing', 'Sizing numbers', 60 * 50, 'Which estimates hold up'),
    t('fx_logging', 'Activity logging backlog', 60 * 74, 'Rows waiting for confirmation'),
  ];
}

export function fixtureMessages(r: FixtureRefs): ChatMessageView[] {
  const [a, b, c] = [r.items[0], r.items[1], r.items[2]].map((x, i) => x ?? { id: `fx_item_${i + 1}`, title: `Item ${i + 1}` });
  const itemRes = (x: { id: string; title: string }): ChatResource => ({ kind: 'work_item', id: x.id, label: x.title, href: `/work/${x.id}` });
  const out: ChatMessageView[] = [
    msg({
      id: 'm-brief',
      role: 'assistant',
      at: at(r.now, 17),
      isMorningBrief: true,
      text: [
        `**Good morning.** Today's big one is the **customer review at 13:30**; the prep call is running now.`,
        `1. **${a.title}** before the review. The demos changed last night and haven't been run since.`,
        `2. **${b.title}** by the end of the day: you said you would.`,
        `3. **${c.title}** before the 14:30 prep.`,
        `Heads-up: one source needs re-auth, so its links are unverified. Two channels have items worth a look.`,
      ].join('\n\n'),
      resources: [
        { kind: 'brief', id: 'fx_brief_1', label: '#team-channel', href: '/briefs' },
        { kind: 'brief', id: 'fx_brief_2', label: '#partner-channel', href: '/briefs' },
      ],
    }),
    msg({ id: 'm-q1', role: 'user', at: at(r.now, 13), text: 'Do I need to do the activity logging today?' }),
    msg({
      id: 'm-a1',
      role: 'assistant',
      at: at(r.now, 13),
      text: "**No.** It's due Friday at 12:00. Confirming the rows takes about 30 minutes; want me to pull it into your open slot at 15:00, or leave it for tomorrow morning?",
      // Assistant v2: Auto routed this lookup to Haiku; the receipt is tier · steps · $
      route: { intent: 'lookup', tier: 'fast', model: 'haiku', why: 'a lookup', override: false },
      usage: { model: 'claude-haiku-5-5', inputTokens: 9_200, outputTokens: 180, costUsd: 0.0021, turns: 2, tier: 'fast', steps: 1, resumed: true },
    }),
    msg({ id: 'm-q2', role: 'user', at: at(r.now, 10), text: `Why is “${a.title}” #1?` }),
    msg({
      id: 'm-why',
      role: 'assistant',
      at: at(r.now, 10),
      tools: [
        tool('t1', 'slack.search', '"demo" · last 2 days', '3 threads'),
        tool('t2', 'slack.read_thread', 'prep thread', '2 messages'),
        tool('t3', 'calendar.events', 'today', '6 events, 2 declined'),
        tool('t4', 'priority.explain', a.title, '3 factors'),
      ],
      text: [
        "It's the only prep left for today's biggest meeting, and it has the earliest start-by.",
        '1. **A customer meeting today.** The 13:30 review is your one starred meeting, and your policy puts customer-facing prep first.',
        "2. **Slides done, demos untested.** They changed last night and haven't been run since.",
        "3. **Start by 08:35.** The agent's checks need about 20 minutes in the background, which leaves room to fix anything before 10:00.",
        `“${b.title}” is #2: it's due 17:00 and needs about 50 minutes of your time.`,
      ].join('\n\n'),
      resources: [{ kind: 'calendar_event', id: 'fx_evt', label: '13:30 customer review', href: '/today' }, itemRes(a)],
      route: { intent: 'explain', tier: 'balanced', model: 'sonnet', why: 'an explanation', override: false },
      usage: { model: 'claude-sonnet-5-5', inputTokens: 14_800, outputTokens: 420, costUsd: 0.0182, turns: 5, tier: 'balanced', steps: 4, resumed: true },
    }),
  ];
  if (r.draftId) {
    out.push(
      msg({ id: 'm-q3', role: 'user', at: at(r.now, 7), text: 'Draft the reply.' }),
      msg({
        id: 'm-draft',
        role: 'assistant',
        at: at(r.now, 7),
        text: "Here's a draft. It doesn't commit you to a date until you hear back.",
        resources: [{ kind: 'draft', id: r.draftId, label: r.draftLabel ?? 'Reply', href: '/outbox' }],
      }),
    );
  }
  if (r.runId) {
    out.push(
      msg({ id: 'm-q4', role: 'user', at: at(r.now, 5), text: 'Start the build-vs-buy deck.' }),
      msg({
        id: 'm-deck',
        role: 'assistant',
        at: at(r.now, 5),
        text: 'I set up a Claude Code session for it. It runs in the background, so it doesn\'t count against your time today. It opens only when you click **Open in Claude**.',
        resources: [{ kind: 'agent_run', id: r.runId, label: r.runTitle ?? 'Claude session', href: `/agents?run=${r.runId}` }],
      }),
    );
  }
  out.push(
    msg({ id: 'm-q5', role: 'user', at: at(r.now, 4), text: '/rescan slack 2d' }),
    msg({
      id: 'm-scan',
      role: 'assistant',
      at: at(r.now, 4),
      tools:
        r.scan === 'running'
          ? [tool('s1', 'slack.scan', 'Re-reading Slack since Tue 08:20 (2d)', 'Re-reading Slack since Tue 08:20 (2d)', null)]
          : [tool('s1', 'slack.scan', 'Re-reading Slack since Tue 08:20 (2d)', 'Scan started; it shows in the Health ledger'), tool('s2', 'linker.match', 'Matching Slack messages to your open items', 'Found 2 new items · 1 linked to an open item')],
      streaming: false,
    }),
    msg({ id: 'm-q6', role: 'user', at: at(r.now, 2), text: `Move “${b.title}” ahead of “${a.title}” and snooze “${c.title}” to 2 pm.` }),
    msg({
      id: 'm-move',
      role: 'assistant',
      at: at(r.now, 2),
      text: `Here's the change. It needs about 50 minutes of your time, so “${a.title}” starts by 09:20 instead, still hours before the 13:30 review.`,
      proposals: [{ proposal: fixtureProposal(r), summary: `“${b.title}” first, “${c.title}” after 2 pm` }],
    }),
    // Assistant v2: a research question shows its plan and price first, and waits for Run / Edit / Skip
    msg({ id: 'm-q7', role: 'user', at: at(r.now, 1), text: 'Have I done anything for Globex in the past?' }),
    msg({
      id: 'm-plan',
      role: 'assistant',
      at: at(r.now, 1),
      streaming: true,
      status: 'streaming',
      route: { intent: 'research', tier: 'strong', model: 'opus', why: 'a research question', override: false },
      spentUsd: 0.0042,
      spentModel: 'claude-opus-5-5',
      tools: [tool('p1', 'db.work_items', 'Querying work_items where account contains "globex"', 'work_items: 2 rows')],
      plans: [
        {
          id: 'fx_plan',
          steps: [
            { tool: 'query', what: 'Check what the app already has on Globex (items, opps, hours logged)', estUsd: 0.002 },
            { tool: 'run', run: 'research', what: 'Search Slack, Gmail, Calendar, Drive and Org62 for Globex work since 2024', estUsd: 0.45 },
          ],
          estimate: { p50: 0.152, p90: 0.452, basis: 'default' },
          status: 'waiting',
        },
      ],
    }),
  );
  return out;
}

/** A canned reply for the preview composer (fixture mode never calls the server). */
export function fixtureReply(text: string, now: Date, n: number): ChatMessageView[] {
  return [
    msg({ id: `fx_u_${n}`, role: 'user', at: now.toISOString(), text }),
    msg({ id: `fx_a_${n}`, role: 'assistant', at: now.toISOString(), text: 'This is the preview thread: replies are scripted only for the messages above. Drop `fixture=1` to talk to the mock.' }),
  ];
}
