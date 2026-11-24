'use client';
/** /dev/kit: PageHeader, DetailPanel (Done ▾ / Later ▾) and the ReviewQueue drain mode, with fake adapters. */
import { useMemo, useState } from 'react';
import { DetailPanel, doneRequest, laterRequest, PageHeader, ReviewQueue, type DetailSection, type ItemMenuHandlers, type ReviewAdapter } from '@/components/kit';
import { Button, ConfidenceWord } from '@/ui';
import { Section, Specimen } from '../ui/_kit/frame';
import { DRAFTS, NOW, SECTIONS_TEXT, TZ, type KitDraft } from './fixtures';

export function PageHeaderSection() {
  const [tab, setTab] = useState('log');
  return (
    <Section id="page-header" title="PageHeader" intro="One title source: the route table. The tab never changes the title (Activity stays Activity on every tab).">
      <Specimen label="With tabs" note="route 'time'" stack>
        <div className="rounded-lg border border-line bg-surface">
          <PageHeader
            route="time"
            rule={false}
            sentence="6 rows wait on you; 31 h logged this week, 28 in Org62."
            tabs={[
              { value: 'log', label: 'To log', count: 6 },
              { value: 'history', label: 'History' },
              { value: 'vdp', label: 'VDP', count: 2 },
            ]}
            tab={tab}
            onTab={setTab}
            actions={
              <Button size="sm" variant="primary">
                Log 6
              </Button>
            }
          />
        </div>
      </Specimen>
      <Specimen label="Entity page" note="route 'account' + crumb" stack>
        <div className="rounded-lg border border-line bg-surface">
          <PageHeader rule={false} route="account" crumb="Saltmere Health" sentence="Data 360 POC readout next Wednesday; blueprint due Friday." actions={<Button size="sm" variant="secondary">Open in Org62</Button>} />
        </div>
      </Specimen>
    </Section>
  );
}

const SECTIONS: DetailSection[] = [
  { id: 'why', title: 'Why it is here', order: 10, render: () => <p className="text-fg">{SECTIONS_TEXT.why}</p> },
  { id: 'next', title: 'Next step', order: 20, render: () => <p className="text-fg">{SECTIONS_TEXT.next}</p> },
  {
    id: 'evidence',
    title: 'Evidence',
    order: 30,
    collapsed: true,
    render: () => (
      <ul className="space-y-1 text-fg">
        {SECTIONS_TEXT.evidence.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
    ),
  },
];

export function DetailPanelSection() {
  const [last, setLast] = useState<string>('Press d, ⇧D or l in the panel, or open a menu.');
  const menus: ItemMenuHandlers = useMemo(
    () => ({
      now: NOW,
      tz: TZ,
      onDone: (c) => {
        const r = doneRequest(c);
        setLast(`Done ▾ ${c} → POST /items/wi-001/actions/${r.verb} ${JSON.stringify(r.body)}`);
      },
      onLater: (c, picked) => {
        const r = laterRequest(c, NOW, TZ, picked);
        setLast(r ? `Later ▾ ${c} → POST /items/wi-001/actions/${r.verb} ${JSON.stringify(r.body)}` : 'Later ▾ pick: no date yet');
      },
    }),
    [],
  );
  return (
    <Section id="detail-panel" title="DetailPanel" intro="Sections from a per-kind registry (ordered, conditional, collapsible) and the two item menus: Done ▾ (by me · someone else · not mine · not needed) and Later ▾ (tomorrow · next week · pick a date · not now). Each choice is an existing item verb; nothing here calls the API.">
      <Specimen label="Work item" note="Keys: d · ⇧D · l" stack>
        <div className="h-[30rem] overflow-hidden rounded-lg border border-line">
          <DetailPanel entity={{ kind: 'work_item', id: 'wi-001', label: 'Send the Saltmere solution blueprint' }} eyebrow="Work item" subtitle="Saltmere Health · due Fri 20 Nov · you ~45m" sections={SECTIONS} menus={menus} primary={{ label: 'Review draft', onClick: () => setLast('Primary: Review draft') }} />
        </div>
        <p className="font-mono text-caption break-all text-muted" data-testid="kit-detail-last">
          {last}
        </p>
      </Specimen>
    </Section>
  );
}

function DraftCard({ d, state }: { d: KitDraft; state?: 'new' | 'gone' }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 text-caption text-muted">
        <span className="font-bold text-fg">{d.where}</span>
        <span>· to {d.to}</span>
        <ConfidenceWord value={d.confidence} />
        {state === 'new' ? <span className="font-bold text-info-700">New</span> : null}
      </div>
      <p className="rounded-md bg-surface-muted p-4 text-body-lg text-fg">{d.text}</p>
      <p className="text-body text-muted">
        <b className="font-bold text-fg">Why drafted:</b> {d.why}. Nothing is sent until you confirm (dry run in the kit).
      </p>
    </div>
  );
}

export function ReviewQueueSection() {
  const [run, setRun] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const failed = useMemo(() => new Set<string>(), [run]); // eslint-disable-line react-hooks/exhaustive-deps
  const note = (s: string) => setLog((l) => [s, ...l].slice(0, 4));
  const adapter: ReviewAdapter<KitDraft> = useMemo(
    () => ({
      approve: async (d) => {
        if (d.fails && !failed.has(d.id)) {
          failed.add(d.id);
          throw new Error('Gmail is not answering. Nothing was sent; try again.');
        }
        note(`approve ${d.id}`);
      },
      snooze: (d) => note(`snooze ${d.id}`),
      dismiss: (d) => note(`dismiss ${d.id}`),
      undo: (b) => note(`undo ${b.verb} × ${b.items.length}`),
      labels: { approve: 'Approve & send', dismiss: 'Reject' },
      past: { dismiss: 'Rejected' },
    }),
    [failed],
  );
  return (
    <Section id="review-queue" title="ReviewQueue (drain mode)" intro="One card at a time over a stable order. a approve · e edit · s snooze · x reject · j/k move · z undo the open batch · Esc exit. Arrivals join the end; the end screen says what happened and when the next check runs. The third draft fails once to show the Retry card.">
      <Specimen label="Outbox drafts" note="Fake adapter: logs, never sends" stack>
        <div className="flex items-center gap-3">
          <Button size="xs" variant="quiet" onClick={() => setRun(run + 1)}>
            Reset
          </Button>
          <span className="font-mono text-caption text-muted" data-testid="kit-review-log">
            {log.join(' · ') || 'Click the card area, then use the keys.'}
          </span>
        </div>
        <div className="h-[32rem] overflow-hidden rounded-lg border border-line">
          <ReviewQueue<KitDraft>
            key={run}
            title="Review drafts"
            items={DRAFTS}
            adapter={adapter}
            renderCard={(d, ctx) => <DraftCard d={d} state={ctx.state} />}
            renderEditor={(d, close) => (
              <div className="flex flex-col gap-2">
                <textarea defaultValue={d.text} rows={3} className="w-full rounded-md border border-line-input bg-surface-input p-2 text-body text-fg" />
                <Button size="xs" variant="secondary" className="self-start" onClick={close}>
                  Keep edit
                </Button>
              </div>
            )}
            bulk={{ label: 'Approve all sure', filter: (d) => d.confidence === 'sure', describe: (d) => `${d.to} · ${d.where}` }}
            nextCheckMin={12}
            toastMs={10_000}
            autoFocus={false}
          />
        </div>
      </Specimen>
      <Specimen label="All clear" note="The terminal screen" stack>
        <div className="h-64 overflow-hidden rounded-lg border border-line">
          <ReviewQueue<KitDraft> title="Review drafts" items={[]} adapter={adapter} renderCard={() => null} nextCheckMin={12} autoFocus={false} />
        </div>
      </Specimen>
    </Section>
  );
}
