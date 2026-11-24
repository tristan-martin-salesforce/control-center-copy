'use client';
/** /dev/kit: ActionRow in every state, configured like today's rows, and a live QueueSection. */
import { useState, type ReactNode } from 'react';
import { StatusBadge } from '@/components/domain/lib/v2';
import { ActionRow, QueueSection, type ActionRowOverflow, type ActionRowProps } from '@/components/kit';
import { Button, SourceChip } from '@/ui';
import { Section, Specimen } from '../ui/_kit/frame';
import { ARRIVALS, ROWS, type KitRow } from './fixtures';

const noop = () => {};
const OVERFLOW: ActionRowOverflow[] = [
  { id: 'done', label: 'Done', icon: 'check', k: 'd', onClick: noop },
  { id: 'later', label: 'Later', icon: 'clock', k: 'l', onClick: noop },
  { id: 'edit', label: 'Edit', icon: 'edit', k: 'e', onClick: noop },
  { id: 'merge', label: 'Merge into an existing item', icon: 'merge', k: 'm', onClick: noop },
  { id: 'reject', label: 'Reject', icon: 'close', onClick: noop, tone: 'danger' },
];

function row(r: KitRow, over: Partial<ActionRowProps> = {}, key: string = r.id) {
  return (
    <ActionRow
      key={key}
      id={r.id}
      title={r.title}
      why={r.why}
      confidence={r.confidence}
      tint={r.ai ? 'ai' : null}
      source={r.source}
      meta={<span>{r.account}</span>}
      verb={{ label: 'Review', kbd: 'a', onClick: noop }}
      overflow={OVERFLOW}
      {...over}
    />
  );
}

function Box({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 flex-col rounded-lg border border-line bg-surface p-1.5">{children}</div>;
}

function Replay({ children }: { children: (n: number) => ReactNode }) {
  const [n, setN] = useState(0);
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div className="min-w-0 flex-1">{children(n)}</div>
      <Button size="xs" variant="quiet" onClick={() => setN(n + 1)}>
        Replay
      </Button>
    </div>
  );
}

export function ActionRowSection() {
  const [expanded, setExpanded] = useState(true);
  const [ticked, setTicked] = useState(true);
  const [r1, r2, r3, r4, r5] = ROWS as [KitRow, KitRow, KitRow, KitRow, KitRow];
  return (
    <Section id="action-row" title="ActionRow" intro="One row contract: lead, title, why, meta chips (confidence, ✦ AI / New, source), a quiet verb that fills when selected, overflow on hover (first three as icons, the rest in ⋯), an inline expansion, and the live states.">
      <Specimen label="Default" note="Quiet verb; hover for overflow" stack>
        <Box>{row(r1)}</Box>
      </Specimen>
      <Specimen label="Selected" note="Filled verb, overflow inline, blue edge" stack>
        <Box>{row(r2, { selected: true })}</Box>
      </Specimen>
      <Specimen label="Emphasis · in panel" note="#1 fills; open in the panel stays quiet" stack>
        <Box>
          {row(r4, { emphasis: true, edge: 'warning' })}
          {row(r3, { selected: true, inPanel: true })}
        </Box>
      </Specimen>
      <Specimen label="New" note="Arrival tint (~3 s), blue · violet for AI" stack>
        <Replay>
          {(n) => (
            <Box>
              {row(r1, { live: 'new', tint: 'new' }, `n${n}`)}
              {row(r2, { live: 'new', liveTone: 'ai' }, `a${n}`)}
            </Box>
          )}
        </Replay>
      </Specimen>
      <Specimen label="Leaving" note="Left elsewhere: fades in place, then collapses (Replay)" stack>
        <Replay>{(n) => <Box>{row(r3, { live: 'leaving' }, `l${n}`)}</Box>}</Replay>
      </Specimen>
      <Specimen label="Gone" note="Left while open in the panel: dimmed, verbs off" stack>
        <Box>{row(r4, { live: 'gone' })}</Box>
      </Specimen>
      <Specimen label="Held" note="Parked on something else: dashed, verb off" stack>
        <Box>{row(r5, { held: 'Waiting for VDP to refresh', lead: <Step n={2} />, verb: { label: 'Apply', onClick: noop } })}</Box>
      </Specimen>
      <Specimen label="Done" note="Struck title" stack>
        <Box>{row(r1, { done: true, verb: null, badge: <StatusBadge tone="success" icon="check">Done</StatusBadge> })}</Box>
      </Specimen>
      <Specimen label="As TriageRow" note="Dashed guess, Accept + Dismiss" stack>
        <Box>{row(r3, { dashed: true, verb: { label: 'Accept', kbd: 'a', onClick: noop }, altVerb: { label: 'Dismiss', onClick: noop } })}</Box>
      </Specimen>
      <Specimen label="As OutboxRow" note="Status badge, inline error with Retry" stack>
        <Box>
          {row(r4, {
            title: 'Slack · #ferrowpay-fraud',
            why: 'p95 scoring latency in the sandbox is 120 ms; I can show the trace on Friday.',
            edge: 'danger',
            badge: <StatusBadge tone="danger" icon="error">Not sent</StatusBadge>,
            verb: { label: 'Approve & send', kbd: 'a', onClick: noop },
            meta: <span>For: Answer Folasade on fraud-model latency · drafted 9m ago</span>,
            extra: <p className="pb-1 text-body text-danger-700">Slack is rate limiting. Nothing was sent. <button type="button" className="font-bold text-link hover:underline">Retry</button></p>,
          })}
        </Box>
      </Specimen>
      <Specimen label="As NeedRow" note="Tick, when, pickers inline, expansion open" stack>
        <Box>
          {row(r5, {
            check: { checked: ticked, onChange: () => setTicked(!ticked), label: 'Select this row' },
            lead: { top: 'Tue', bottom: '2.0 h' },
            selected: ticked,
            verb: null,
            chips: <SourceChip source="calendar" compact />,
            trailing: <Picker />,
            expansion: <p className="text-body text-fg">How it came in: the Tuesday workshop invite (4 Saltmere attendees) and 40 min of Claude session time on the blueprint.</p>,
            expanded,
            onExpandedChange: setExpanded,
          })}
        </Box>
      </Specimen>
    </Section>
  );
}

function Step({ n }: { n: number }) {
  return <span className="inline-flex size-6 items-center justify-center rounded-full border border-line-strong text-caption font-bold text-fg tabular-nums">{n}</span>;
}

function Picker() {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-line-input bg-surface-input px-2 text-caption text-fg">
      Saltmere · Data 360 POC <span className="text-faint">▾</span>
    </span>
  );
}

export function QueueSectionDemo() {
  const [items, setItems] = useState<KitRow[]>(ROWS.slice(0, 4));
  const [selectedId, setSelectedId] = useState<string | null>('wi-002');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [next, setNext] = useState(0);
  const arrive = (n: number) => {
    const fresh = ARRIVALS.slice(next, next + n).map((r) => ({ ...r, id: `${r.id}-${next}` }));
    setNext((next + n) % ARRIVALS.length);
    setItems((xs) => [...fresh, ...xs]);
  };
  return (
    <Section id="queue-section" title="QueueSection" intro="A verb-named section over the live-list pattern (D-73): stable order, arrivals at their natural place, more than three at once behind the “N new · Show” pill, departures fade, the selection moves to its neighbour. Cap 3, See all, Select all.">
      <Specimen label="Live" note="Try the buttons" stack>
        <div className="flex flex-wrap gap-2">
          <Button size="xs" variant="secondary" onClick={() => arrive(1)}>
            One arrives
          </Button>
          <Button size="xs" variant="secondary" onClick={() => arrive(4)}>
            Four arrive (pill)
          </Button>
          <Button size="xs" variant="secondary" onClick={() => setItems((xs) => xs.slice(0, -1))}>
            Last one handled elsewhere
          </Button>
          <Button size="xs" variant="quiet" onClick={() => setItems(ROWS.slice(0, 4))}>
            Reset
          </Button>
        </div>
        <QueueSection<KitRow>
          title="Reply"
          sub="asks waiting on you"
          items={items}
          resetKey="kit-reply"
          cap={3}
          selectedId={selectedId}
          onSelectedChange={setSelectedId}
          select={{ selected: ticked, onChange: setTicked }}
          action={<Button size="xs" variant="quiet">Review {items.length}</Button>}
          renderRow={(r, ctx) =>
            row(r, { selected: ctx.selected, live: ctx.live, liveTone: ctx.liveTone, check: { checked: ctx.checked, onChange: ctx.toggle, label: r.title }, onOpen: () => setSelectedId(r.id) })
          }
        />
      </Specimen>
      <Specimen label="Empty" note="Renders its empty line (or nothing)" stack>
        <QueueSection<KitRow> title="Chase" items={[]} resetKey="kit-chase" renderRow={() => null} empty={<p className="text-body text-muted">Nothing to chase. That&apos;s everything.</p>} />
      </Specimen>
    </Section>
  );
}
