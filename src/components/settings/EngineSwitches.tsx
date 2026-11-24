'use client';
/**
 * The engine switches that had no row in Settings (W12-5), each an instant versioned save through
 * `PATCH /settings/:section` (like Scanning and Display: one request at a time, rapid picks coalesce, a 409 rebases):
 *
 *   Sending ▸ Closing items for you   settings.closing.resolutionEngine   watch only (shadow, default) · the old closers
 *                                                                          (legacy) · the new check (live)
 *   Budgets ▸ Assistant model         settings.chat.routing               Auto · Always Haiku · Always Sonnet · Always Opus
 *   Budgets ▸ Ranking                 settings.priority.engine            v1 · preview beside it (shadow, default) ·
 *                                                                          v2 "make this my list"
 *
 * Health's Resolution and Ranking lines link here (#sending-closing, #budgets-ranking).
 */
import { useCallback, useEffect, useRef } from 'react';
import { DEFAULT_CHAT_SETTINGS, DEFAULT_CLOSING_SETTINGS, DEFAULT_PRIORITY_SETTINGS, type ChatSettings, type ClosingSettings, type PrioritySettings, type Settings } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { toast } from '@/client/toast';
import { Select } from './controls';
import { Block, Instant, Row, Section } from './form';

/** A plain-words pick (a select: the labels are sentences, too long for a segmented toggle at 1,440 px). */
function Pick<V extends string>({ id, label, value, options, onChange, testId }: { id: string; label: string; value: V; options: Array<{ value: V; label: string }>; onChange: (v: V) => void; testId: string }) {
  return (
    <Select id={id} aria-label={label} className="w-[22rem] max-w-full" value={value} onChange={(e) => onChange(e.target.value as V)} data-testid={testId}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  );
}

type Instants = { closing: ClosingSettings; chat: ChatSettings; priority: PrioritySettings };
type InstantKey = keyof Instants;
const DEFAULTS: { [K in InstantKey]: Instants[K] } = { closing: DEFAULT_CLOSING_SETTINGS, chat: DEFAULT_CHAT_SETTINGS, priority: DEFAULT_PRIORITY_SETTINGS };
const NOUN: Record<InstantKey, string> = { closing: 'closing', chat: 'Assistant', priority: 'ranking' };

/** One section's saved value and an instant setter (the pattern of Settings ▸ Scanning). */
export function useInstantSection<K extends InstantKey>(section: K) {
  const settings = useApi('getSettings');
  const server = (settings.data as (Settings & Partial<Instants>) | undefined)?.[section] as Instants[K] | undefined;
  const value = { ...DEFAULTS[section], ...(server ?? {}) } as Instants[K];
  const persist = useOptimisticMutation({
    route: 'patchSettings',
    topics: ['settings', 'health', 'today'],
    writeBack: false,
    // Last write wins: a 409 carries the whole Settings as `current`, so rebase on its section's version.
    rebase: ({ input, current }) => {
      const v = Number((current as unknown as Partial<Instants>)[section]?.version ?? current.version);
      return Number.isFinite(v) ? { ...input, body: { ...input.body!, ifVersion: v } } : null;
    },
    entityId: () => undefined,
    optimistic: (input, cache) => cache.setQuery<Settings>(queryKey('getSettings') as never, (old) => (old ? ({ ...old, [section]: { ...DEFAULTS[section], ...((old as Settings & Partial<Instants>)[section] ?? {}), ...input.body!.value } } as Settings) : old)),
    onError: () => toast({ key: `${section}-switch-save`, tone: 'warning', title: `Couldn't save the ${NOUN[section]} setting`, body: 'The last saved choice still applies.', action: { label: 'Retry', onClick: () => persist.retry() } }),
  });
  const queue = useRef<Partial<Instants[K]> | null>(null);
  const inflight = useRef(false);
  const lastVersion = useRef(0);
  const latest = useRef({ persist, version: server?.version ?? 0 });
  latest.current = { persist, version: server?.version ?? 0 };
  const flush = useCallback(() => {
    if (inflight.current || !queue.current || !latest.current.version) return;
    const patch = queue.current;
    queue.current = null;
    inflight.current = true;
    latest.current.persist
      .mutateAsync({ params: { section }, body: { ifVersion: Math.max(lastVersion.current, latest.current.version), value: patch as Record<string, unknown> } })
      .then((res) => {
        lastVersion.current = ((res.entity as Settings & Partial<Instants>)[section]?.version as number | undefined) ?? lastVersion.current;
      })
      .catch(() => undefined)
      .finally(() => {
        inflight.current = false;
        flush();
      });
  }, [section]);
  useEffect(() => flush(), [flush, server?.version]);
  const set = useCallback(
    (patch: Partial<Instants[K]>) => {
      queue.current = { ...queue.current, ...patch };
      flush();
    },
    [flush],
  );
  return { value, ready: !!server, set };
}

export const CLOSING_ENGINE_OPTIONS: Array<{ value: ClosingSettings['resolutionEngine']; label: string }> = [
  { value: 'shadow', label: 'Watch only (default)' },
  { value: 'legacy', label: 'The old closers' },
  { value: 'live', label: 'The new check' },
];
const CLOSING_ENGINE_HELP: Record<ClosingSettings['resolutionEngine'], string> = {
  shadow: 'The default. The old closers still close items for you; the new check runs beside them and only records what it would have done, so Health can compare the two.',
  legacy: 'Only the old closers decide; the new check does not run.',
  live: 'The new check decides what closes, with its reason and Undo on every close; the old closers stop.',
};

/** Sending ▸ Closing items for you (settings.closing.resolutionEngine). */
export function ClosingEngineSection() {
  const m = useInstantSection('closing');
  const v = m.value.resolutionEngine;
  return (
    <Section id="sending-closing" title="Closing items for you" meta="Which check closes finished work for you. Either way every close shows its reason and Undo." actions={<Instant />}>
      <Block id="closing-engine">
        <Row label="Closing items for you" htmlFor="closing-engine-pick" help={CLOSING_ENGINE_HELP[v]} testId="closing-engine-row">
          <Pick id="closing-engine-pick" label="Closing items for you" value={v} onChange={(x) => m.set({ resolutionEngine: x })} options={CLOSING_ENGINE_OPTIONS} testId="closing-engine" />
        </Row>
      </Block>
    </Section>
  );
}

export const ROUTING_OPTIONS: Array<{ value: ChatSettings['routing']; label: string }> = [
  { value: 'auto', label: 'Auto' },
  { value: 'haiku', label: 'Always Haiku' },
  { value: 'sonnet', label: 'Always Sonnet' },
  { value: 'opus', label: 'Always Opus' },
];
export const PRIORITY_ENGINE_OPTIONS: Array<{ value: PrioritySettings['engine']; label: string }> = [
  { value: 'v1', label: 'v1 only' },
  { value: 'shadow', label: 'Preview v2 beside it (default)' },
  { value: 'v2', label: 'v2: make this my list' },
];
const PRIORITY_ENGINE_HELP: Record<PrioritySettings['engine'], string> = {
  v1: 'Your list ranks the way it always has; the new ranking does not run.',
  shadow: 'The default. Your list stays on v1; v2 ranks beside it, Today offers Preview new ranking, and Health says how often they agree.',
  v2: 'Your list ranks by value and urgency fitted to your day (v2). Set it back to v1 at any time.',
};

/** Budgets ▸ the Assistant's model and the ranking engine, next to each other (settings.chat.routing, settings.priority.engine). */
export function RoutingAndRankingSection() {
  const chat = useInstantSection('chat');
  const pr = useInstantSection('priority');
  const routing = chat.value.routing;
  const engine = pr.value.engine;
  return (
    <Section id="budgets-ranking" title="Models and ranking" meta="Which model answers in the Assistant, and which engine ranks your list." actions={<Instant />}>
      <Block id="assistant-routing">
        <Row label="Assistant model" htmlFor="chat-routing-pick" help={routing === 'auto' ? 'Auto: Haiku for lookups and small actions, Sonnet for drafts and explanations, Opus for research. A message’s own choice in the composer still wins.' : 'Every message uses this model unless you pick another in the composer for that message.'} testId="chat-routing-row">
          <Pick id="chat-routing-pick" label="Assistant model" value={routing} onChange={(x) => chat.set({ routing: x })} options={ROUTING_OPTIONS} testId="chat-routing" />
        </Row>
      </Block>
      <Block id="priority-engine">
        <Row label="Ranking" htmlFor="priority-engine-pick" help={PRIORITY_ENGINE_HELP[engine]} testId="priority-engine-row">
          <Pick id="priority-engine-pick" label="Ranking" value={engine} onChange={(x) => pr.set({ engine: x })} options={PRIORITY_ENGINE_OPTIONS} testId="priority-engine" />
        </Row>
      </Block>
    </Section>
  );
}
