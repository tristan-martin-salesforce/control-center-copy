/**
 * Pure state for one chat exchange: fold ChatSseEvents into a LiveTurn, then merge it with the persisted
 * thread so the list never shows a message twice (the server appends the user message before the
 * first event, and live invalidation refetches the thread mid-stream).
 */
import type { ApiErrorBody, ChatMessage, ChatSseEvent, ContextRef } from '@/contract';
import type { ChatMessageView, ChatTurnStatus, LiveTurn, TurnExtras } from './types';

let seq = 0;
export function localId(prefix: string): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function startTurn(input: { threadId: string; text: string; context: ContextRef[]; baseIds: string[]; now?: Date; allowExtraUsd?: number; continueMessageId?: string }): LiveTurn {
  return {
    ...(input.allowExtraUsd ? { allowExtraUsd: input.allowExtraUsd } : {}),
    ...(input.continueMessageId ? { continueMessageId: input.continueMessageId } : {}),
    key: localId('turn'),
    threadId: input.threadId,
    userText: input.text,
    context: input.context,
    sentAt: (input.now ?? new Date()).toISOString(),
    baseIds: input.baseIds,
    status: 'connecting',
    messageId: null,
    userMessageId: null,
    text: '',
    tools: [],
    receipts: [],
    proposals: [],
    resources: [],
    plans: [],
    error: null,
    lastEvent: null,
    attempt: 0,
  };
}

export const TERMINAL: ReadonlySet<ChatTurnStatus> = new Set(['done', 'error', 'stopped']);

/** The step-stop's catalog code (src/errors/catalog.ts, src/llm/chat/router.ts STEP_LIMIT_CODE): the API code stays `internal`. */
export const STEP_LIMIT_CODE = 'RATE.CHAT.STEP_LIMIT';
/** An answer stopped at Steps per message (P31-1): its button continues it ("Continue"), it never re-asks (P33-2). */
export const isStepLimitError = (e: Pick<ApiErrorBody, 'details'> | null | undefined): boolean =>
  (e?.details as { catalogCode?: unknown } | undefined)?.catalogCode === STEP_LIMIT_CODE;

export function reduceTurn(turn: LiveTurn, ev: ChatSseEvent): LiveTurn {
  if (TERMINAL.has(turn.status)) return turn;
  const t: LiveTurn = { ...turn, status: 'streaming', lastEvent: ev.type };
  switch (ev.type) {
    case 'start': // header (CONTRACT-1): the turn's ids arrive before any content
      return { ...t, messageId: t.messageId ?? ev.messageId, userMessageId: t.userMessageId ?? ev.userMessageId, ...(ev.route ? { route: ev.route } : {}) };
    case 'plan': {
      const has = t.plans.some((p) => p.id === ev.plan.id);
      return { ...t, plans: has ? t.plans.map((p) => (p.id === ev.plan.id ? ev.plan : p)) : [...t.plans, ev.plan] };
    }
    case 'text-delta':
      return { ...t, text: t.text + ev.delta, messageId: t.messageId ?? ev.messageId };
    case 'tool-start':
      return { ...t, tools: [...t.tools, { id: ev.id, name: ev.name, startSummary: ev.summary, summary: ev.summary, ok: null }] };
    case 'tool-progress':
      return { ...t, tools: t.tools.map((x) => (x.id === ev.id ? { ...x, progress: { done: ev.done, total: ev.total } } : x)) };
    case 'tool-result': {
      const has = t.tools.some((x) => x.id === ev.id);
      return {
        ...t,
        tools: has
          ? t.tools.map((x) => (x.id === ev.id ? { ...x, summary: ev.summary, ok: ev.ok, ...(ev.costUsd ? { costUsd: ev.costUsd } : {}), ...(ev.held ? { held: true } : {}) } : x))
          : [...t.tools, { id: ev.id, name: 'tool', startSummary: null, summary: ev.summary, ok: ev.ok, ...(ev.held ? { held: true } : {}) }],
      };
    }
    case 'receipt':
      return t.receipts.some((r) => r.id === ev.receipt.id) ? t : { ...t, receipts: [...t.receipts, ev.receipt] };
    case 'proposal':
      return t.proposals.some((p) => p.proposal.id === ev.proposal.id) ? t : { ...t, proposals: [...t.proposals, { proposal: ev.proposal, summary: ev.summary }] };
    case 'resource':
      return t.resources.some((r) => r.id === ev.resource.id && r.kind === ev.resource.kind) ? t : { ...t, resources: [...t.resources, ev.resource] };
    case 'usage-delta':
      // a spend ask clears once the hold moves past `asked` (answered)
      return { ...t, spentUsd: ev.spentUsd, spentModel: ev.model, ...(ev.hold ? { hold: ev.hold } : {}), ...(t.spendAsk && ev.hold && ev.hold.state !== 'asked' ? { spendAsk: null } : {}) };
    case 'spend-ask':
      return { ...t, spendAsk: { holdId: ev.holdId, question: ev.question, spentUsd: ev.spentUsd, heldUsd: ev.heldUsd, moreUsd: ev.moreUsd } };
    case 'done':
      return { ...t, status: 'done', messageId: ev.messageId, userMessageId: ev.userMessageId, threadId: ev.threadId, tools: settleTools(t.tools, true) };
    case 'error':
      return { ...t, status: 'error', error: ev.error, tools: settleTools(t.tools, false) };
  }
}

/** Tools still "running" when the turn ends did not report; mark them so no dot pulses forever. */
function settleTools(tools: LiveTurn['tools'], ok: boolean) {
  return tools.map((x) => (x.ok === null ? { ...x, ok } : x));
}

export function failTurn(turn: LiveTurn, error: ApiErrorBody): LiveTurn {
  return { ...turn, status: 'error', error, tools: settleTools(turn.tools, false) };
}

export function stopTurn(turn: LiveTurn): LiveTurn {
  return TERMINAL.has(turn.status) ? turn : { ...turn, status: 'stopped', tools: settleTools(turn.tools, false) };
}

/** Server messages that belong to this turn (not present when it started). */
export function newServerMessages(turn: LiveTurn, server: ChatMessage[]): ChatMessage[] {
  const base = new Set(turn.baseIds);
  return server.filter((m) => !base.has(m.id));
}

/**
 * True once the persisted thread holds this turn's answer: the done message id is there, or (error /
 * stopped / recovered) the server appended a user + assistant pair after the turn began.
 */
export function isReconciled(turn: LiveTurn, server: ChatMessage[]): boolean {
  if (!TERMINAL.has(turn.status)) return false;
  if (turn.messageId && server.some((m) => m.id === turn.messageId)) return true;
  const fresh = newServerMessages(turn, server);
  return fresh.some((m) => m.role === 'user') && fresh.some((m) => m.role === 'assistant');
}

export function extrasFor(turn: LiveTurn): TurnExtras {
  return {
    error: turn.error,
    stopped: turn.status === 'stopped',
    toolArgs: Object.fromEntries(turn.tools.filter((x) => x.startSummary).map((x) => [x.id, x.startSummary as string])),
    proposalSummaries: Object.fromEntries(turn.proposals.filter((p) => p.summary).map((p) => [p.proposal.id, p.summary as string])),
  };
}

/** The assistant message id a reconciled turn maps to (for keeping its extras). */
export function reconciledAssistantId(turn: LiveTurn, server: ChatMessage[]): string | null {
  if (turn.messageId && server.some((m) => m.id === turn.messageId)) return turn.messageId;
  return newServerMessages(turn, server).find((m) => m.role === 'assistant')?.id ?? null;
}

export function viewOfServer(m: ChatMessage, extras?: TurnExtras): ChatMessageView {
  const view: ChatMessageView = {
    id: m.id,
    threadId: m.threadId,
    role: m.role,
    at: m.at,
    text: m.text,
    context: m.context ?? [],
    isMorningBrief: m.isMorningBrief ?? false,
    tools: [],
    receipts: [],
    proposals: [],
    resources: [],
    streaming: false,
    // A persisted `error` part is the turn's real error (after a reload the live turn's extras are gone).
    error: extras?.error ?? (m.parts ?? []).find((p): p is Extract<ChatMessage['parts'][number], { type: 'error' }> => p.type === 'error')?.error ?? null,
    stopped: extras?.stopped ?? m.status === 'stopped',
    pending: false,
    plans: [],
    ...(m.usage ? { usage: m.usage } : {}),
    ...(m.route ? { route: m.route } : {}),
  };
  const parts = m.parts ?? [];
  for (const [i, p] of parts.entries()) {
    const prev = i > 0 ? parts[i - 1] : undefined;
    if (p.type === 'tool') view.tools.push({ id: p.id, name: p.name, startSummary: extras?.toolArgs[p.id] ?? null, summary: p.summary, ok: p.ok, ...(p.progress ? { progress: p.progress } : {}), ...(p.costUsd ? { costUsd: p.costUsd } : {}), ...(p.held ? { held: true } : {}) });
    else if (p.type === 'plan') (view.plans ??= []).push(p.plan);
    // an applied card's receipt (stored right after it) joins the card: one card in the thread, not two
    else if (p.type === 'receipt' && prev?.type === 'proposal' && (prev.status === 'applied' || prev.proposal.status === 'applied') && view.proposals.at(-1)?.proposal.id === prev.proposal.id) view.proposals.at(-1)!.receipt = p.receipt;
    else if (p.type === 'receipt') view.receipts.push(p.receipt);
    else if (p.type === 'proposal') view.proposals.push({ proposal: p.proposal, summary: extras?.proposalSummaries[p.proposal.id] ?? null });
    else if (p.type === 'resource') view.resources.push(p.resource);
  }
  return view;
}

export function viewsOfTurn(turn: LiveTurn): [ChatMessageView, ChatMessageView] {
  const live = !TERMINAL.has(turn.status);
  return [
    {
      id: turn.userMessageId ?? `${turn.key}_u`,
      threadId: turn.threadId,
      role: 'user',
      at: turn.sentAt,
      text: turn.userText,
      context: turn.context,
      isMorningBrief: false,
      tools: [],
      receipts: [],
      proposals: [],
      resources: [],
      streaming: false,
      error: null,
      stopped: false,
      pending: !turn.userMessageId && live,
      plans: [],
    },
    {
      id: turn.messageId ?? `${turn.key}_a`,
      threadId: turn.threadId,
      role: 'assistant',
      at: turn.sentAt,
      text: turn.text,
      context: [],
      isMorningBrief: false,
      tools: turn.tools,
      receipts: turn.receipts,
      proposals: turn.proposals,
      resources: turn.resources,
      streaming: live,
      status: turn.status,
      error: turn.error,
      stopped: turn.status === 'stopped',
      pending: false,
      ...(turn.spentUsd !== undefined ? { spentUsd: turn.spentUsd } : {}),
      ...(turn.spentModel ? { spentModel: turn.spentModel } : {}),
      ...(live && turn.spendAsk ? { spendAsk: turn.spendAsk } : {}),
      ...(turn.route ? { route: turn.route } : {}),
      plans: turn.plans,
    },
  ];
}

/**
 * What the list renders: persisted messages (with remembered extras) plus the live turn while it is not
 * yet reflected on the server. While live, only the messages that existed at send time are shown, so a
 * mid-stream refetch can't duplicate the exchange.
 */
export function mergeMessages(server: ChatMessage[], turn: LiveTurn | null, extras: Record<string, TurnExtras> = {}): ChatMessageView[] {
  if (!turn || isReconciled(turn, server)) return server.map((m) => viewOfServer(m, extras[m.id]));
  const base = new Set(turn.baseIds);
  return [...server.filter((m) => base.has(m.id)).map((m) => viewOfServer(m, extras[m.id])), ...viewsOfTurn(turn)];
}
