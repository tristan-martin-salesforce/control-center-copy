'use client';
/**
 * /dev/kit/domain: every domain component in design v2, every state, rendered from the mock DataSource's
 * real view models. Callbacks land in the bottom-right log. `?theme=light` for the light theme.
 */
import { useMemo, useState } from 'react';

import type { NbaVerb, WorkItem } from '@/contract';
import {
  AgentRunRow, AheadStrip, CapacityMeter, ConnectorRow, ConnectorRowHeader, DayRibbon, DaySpine, NbaCard,
  ResolvePicker, SectionColumn, Shelf, WorkGroup, WorkList, WorkRow,
} from '@/components/domain';
import { Button } from '@/ui';
import { agentBlocks, capacity, homeSections, pullForward, runOfDay } from './compose';
import { HomeSpecimen } from './HomeSpecimen';
import { KitLogProvider, useKitLog } from './kit-log';
import { KitFrame, Section, Specimen } from './KitFrame';
import type { KitData } from './load';
import { buildVariants, type CardProps } from './variants';
import { Marks, ReceiptsSection, BriefsSection, TimeSection, DeprecatedSection } from './KitGallery.sections';

const SECTIONS: Array<[string, string]> = [
  ['home', 'Home A composition'],
  ['marks', 'Marks'],
  ['nba', 'NbaCard'],
  ['rows', 'WorkRow'],
  ['day', 'DayRibbon · DaySpine'],
  ['capacity', 'CapacityMeter · AheadStrip · SectionColumn'],
  ['shelves', 'Shelves'],
  ['receipts', 'ReceiptCard · ProposalDiff'],
  ['agents', 'AgentRunRow'],
  ['briefs', 'Briefs'],
  ['health', 'ConnectorRow'],
  ['time', 'ActivityRow'],
  ['resolve', 'ResolvePicker'],
  ['deprecated', 'Deprecated'],
];

export function KitGallery({ data }: { data: KitData }) {
  return (
    <KitLogProvider quiet>
      <KitFrame now={data.now} tz={data.tz} sections={SECTIONS}>
        <Gallery data={data} />
      </KitFrame>
    </KitLogProvider>
  );
}

function Gallery({ data }: { data: KitData }) {
  const cb = useKitLog();
  const v = useMemo(() => buildVariants(data), [data]);
  const verbOf = useMemo(() => new Map(data.details.map((d) => [d.item.id, d.nba?.verb ?? null] as const)), [data.details]);
  const [hl, setHl] = useState<string | null>(null);
  const [rowSel, setRowSel] = useState<string | null>(data.today.nowStack.cards[1]?.item.id ?? null);

  const cardCb = {
    onPrimary: cb('NbaCard.onPrimary'),
    onAlternative: cb('NbaCard.onAlternative'),
    onSecondary: cb('NbaCard.onSecondary'),
    onNotNow: cb('NbaCard.onNotNow'),
    onOpenSource: cb('NbaCard.onOpenSource'),
    onOpenEntity: cb('NbaCard.onOpenEntity'),
    onOpen: cb('NbaCard.onOpen'),
    onApplyProposal: cb('NbaCard.onApplyProposal'),
    onKeepMine: cb('NbaCard.onKeepMine'),
    onUndoReopen: cb('NbaCard.onUndoReopen'),
  };
  const card = (label: string, c: CardProps | null, extra: Partial<Parameters<typeof NbaCard>[0]> = {}) =>
    c ? (
      <Specimen label={label} key={label}>
        <NbaCard {...c} {...cardCb} {...extra} />
      </Specimen>
    ) : null;

  const rowCb = {
    onOpen: (it: WorkItem, mode: 'sheet' | 'page') => {
      setRowSel(it.id);
      cb('WorkRow.onOpen')(it, mode);
    },
    onAction: cb('WorkRow.onAction'),
    onVerb: cb('WorkRow.onVerb'),
    onOpenSource: cb('WorkRow.onOpenSource'),
    onOpenEntity: cb('WorkRow.onOpenEntity'),
  };
  const nowItems = data.today.nowStack.cards.map((c) => c.item);
  const waitingOthers = data.details.filter((d) => d.item.state === 'waiting_on_others').map((d) => d.item);
  const doneItems = data.details.filter((d) => d.item.state === 'done').map((d) => d.item);
  const row = (it: WorkItem, extra: Partial<Parameters<typeof WorkRow>[0]> = {}) => (
    <WorkRow key={it.id} item={it} nbaVerb={verbOf.get(it.id) as NbaVerb | null} selected={rowSel === it.id} {...rowCb} {...extra} />
  );
  const cap = useMemo(() => capacity(data), [data]);
  const sec = useMemo(() => homeSections(data), [data]);
  const run = useMemo(() => runOfDay(data), [data]);
  const pulls = useMemo(() => pullForward(data), [data]);
  const lanes = useMemo(() => agentBlocks(data), [data]);
  const important = data.today.nowStack.cards.map((c) => c.item.refs.meeting?.id).filter((x): x is string => !!x);

  return (
    <>
      <Section id="home" title="Home A composition" note="Domain components only, in the mockup's arrangement (home-1-briefing). Selection moves the one filled button; hover a row or card for snooze / done / not now.">
        <HomeSpecimen data={data} />
      </Section>

      <Marks />

      <Section id="nba" title="NbaCard" note="The lead card: rank · neutral tag · ONE badge; 20–22 px title; why; effort split; ONE action (filled only when selected or #1). Focus a card: Space expands, Enter opens Details, ⌘↵ fires the action, e s n d ⇧D o ?.">
        <div className="space-y-8">
          <Specimen label="Lead row · #1 emphasis (filled) · #2 · #3 (secondary)">
            <div className="grid grid-cols-[1.3fr_1fr_1fr] items-stretch gap-6">
              {data.today.nowStack.cards.map((c, i) => (
                <NbaCard key={c.item.id} {...c} rank={i + 1} {...cardCb} className="h-full" draftLine={false} />
              ))}
            </div>
          </Specimen>
          <Specimen label="Compact (the with-panel layout) · #2 selected · #3 open in the panel (quiet action)">
            <div className="grid max-w-[64rem] grid-cols-[1.2fr_1fr_1fr] items-stretch gap-4">
              {data.today.nowStack.cards.map((c, i) => (
                <NbaCard key={c.item.id} {...c} rank={i + 1} compact selected={i === 1} filled={i === 0 ? false : undefined} inPanel={i === 2} {...cardCb} className="h-full" draftLine={false} />
              ))}
            </div>
          </Specimen>
          <div className="grid grid-cols-1 items-start gap-6 min-[1400px]:grid-cols-2 min-[2200px]:grid-cols-3">
            {card('Expanded · #1 · Start in Claude, plan block', v.now1, { defaultExpanded: true })}
            {card('Expanded · Slack draft in place · new evidence', v.now2, { defaultExpanded: true, selected: true })}
            {card('Expanded · update strip (draft revised) · email', v.now3, { defaultExpanded: true })}
            {card('Touched draft + new info → ProposalDiff strip', v.touched, { defaultExpanded: true })}
            {card('Low confidence · alternatives replace the action', v.guess, { defaultExpanded: true })}
            {card('Re-evaluating · calm wash on the why line, never blank', v.now2 ? { ...v.now2, item: { ...v.now2.item, reevaluating: true } } : null, { rank: 2 })}
            {card('Waiting on you · app run, inline answer', v.waitingApp, { defaultExpanded: true })}
            {card('Waiting on you · Claude session → Open in Claude', v.claudeWaiting, { defaultExpanded: true })}
            {card('Likely done · confirm with evidence', v.likely, { defaultExpanded: true })}
            {card('Looped back in (R-UI-22)', v.looped, { defaultExpanded: true })}
            {card('Reopened · new requirement', v.reopened, { defaultExpanded: true })}
            {card('Stale · connector broken (StaleMark)', v.stale, { defaultExpanded: true })}
            {card('Suggested · dashed, Triage only', v.suggested, { defaultExpanded: true, variant: 'triage' })}
            {card('Blocked (page-known) · red badge + edge', v.now3, { rank: 3, blocked: true })}
            {card('Run tool (R-UI-13)', v.runTool, { defaultExpanded: true })}
            {card('Log (activity)', v.log, { defaultExpanded: true })}
            {card('Review · Drive deliverable (R-UI-15)', v.deliverable, { defaultExpanded: true })}
            {card('Engine proposal on a locked field (inline)', v.fieldProposal, { defaultExpanded: true })}
            {card('Email · new thread', v.emailNew, { defaultExpanded: true })}
            {card('Collapsed · highlighted from the day ribbon', v.now1, { highlighted: true })}
          </div>
        </div>
      </Section>

      <Section id="rows" title="WorkRow · WorkList · WorkGroup" note="18 px title · muted why line · the state edge · a quiet verb (filled when selected). Hover: done / snooze / edit / source. j/k move; Enter opens. `dense` keeps a one-line row for long tables.">
        <div className="grid grid-cols-1 gap-8 min-[1700px]:grid-cols-[minmax(0,1fr)_26rem]">
          <Specimen label="Full width · grouped · a row selected (click another to move the filled verb)">
            <WorkList label="Work" className="max-h-[40rem] overflow-y-auto">
              <WorkGroup label="Do now" count={nowItems.length}>
                {nowItems.map((it) => row(it))}
              </WorkGroup>
              <WorkGroup label="Later today" count={data.today.moreToday.count} action={<span className="text-link">See all {data.today.moreToday.count} →</span>}>
                {data.today.moreToday.items.slice(0, 6).map((it) => row(it))}
              </WorkGroup>
              <WorkGroup label="WAITING ON OTHERS" count={waitingOthers.length}>
                {waitingOthers.map((it) => row(it))}
              </WorkGroup>
              <WorkGroup label="Done today" count={doneItems.length} defaultCollapsed>
                {doneItems.map((it) => row(it))}
              </WorkGroup>
            </WorkList>
          </Specimen>
          <Specimen label="Narrow (a Home column) · timing folds into the why line" className="max-w-[26rem]">
            <WorkList label="Narrow">{[...nowItems, ...data.today.moreToday.items.slice(0, 4)].map((it) => row(it, { hideMeta: true }))}</WorkList>
          </Specimen>
          <Specimen label="Dense · one-line table rows (Work page)" className="min-[1700px]:col-span-2">
            <WorkList label="Dense">{[...nowItems, ...data.today.moreToday.items.slice(0, 6)].map((it) => row(it, { dense: true }))}</WorkList>
          </Specimen>
          <Specimen label="Run of day · with the `when` column" className="max-w-[44rem]">
            <WorkList label="Run of day">
              {run.slice(0, 4).map((r, i) => (
                <WorkRow key={r.item.id} item={r.item} when={r.when} nbaVerb={r.verb} emphasis={i === 0 && !rowSel} selected={rowSel === r.item.id} {...rowCb} />
              ))}
            </WorkList>
          </Specimen>
        </div>
      </Section>

      <Section id="day" title="DayRibbon · DaySpine" note="True proportions (08:00–17:30, widened to fit). Past dims, a now line, declined meetings are ghosts, open time and planned work are dashed, ★ meetings carry their prep state, the agent's background runs get a violet lane. Hover a block: the linked card lights.">
        <div className="space-y-8">
          <Specimen label="DayRibbon · Home">
            <DayRibbon
              events={data.today.spine.events}
              slots={data.today.spine.slots}
              importantEventIds={important}
              highlightedItemId={hl}
              onHoverItem={setHl}
              onOpenEvent={cb('DayRibbon.onOpenEvent')}
              onOpenSlot={cb('DayRibbon.onOpenSlot')}
              onOpenTakeaways={cb('DayRibbon.onOpenTakeaways')}
              onOpenPrep={cb('DayRibbon.onOpenPrep')}
            />
          </Specimen>
          <div className="grid grid-cols-[minmax(26rem,36rem)_minmax(0,1fr)] items-start gap-8">
            <Specimen label="DaySpine · the Today timeline (drag a ▶ block onto open time to re-plan)">
              <DaySpine
                className="h-[48rem]"
                events={data.today.spine.events}
                slots={data.today.spine.slots}
                later={data.today.spine.later}
                agentBlocks={lanes}
                importantEventIds={important}
                highlightedItemId={hl}
                selectedItemId={rowSel}
                onHoverItem={setHl}
                onOpenEvent={cb('DaySpine.onOpenEvent')}
                onOpenPrep={cb('DaySpine.onOpenPrep')}
                onOpenTakeaways={cb('DaySpine.onOpenTakeaways')}
                onOpenSlot={cb('DaySpine.onOpenSlot')}
                onReplan={cb('DaySpine.onReplan')}
                onOpenLater={cb('DaySpine.onOpenLater')}
              />
            </Specimen>
            <Specimen label="Linked cards (hover a block)">
              <div className="space-y-3">
                {data.today.nowStack.cards.map((c, i) => (
                  <NbaCard key={c.item.id} {...c} rank={i + 1} {...cardCb} highlighted={hl === c.item.id} onHover={setHl} />
                ))}
              </div>
            </Specimen>
          </div>
        </div>
      </Section>

      <Section id="capacity" title="CapacityMeter · AheadStrip · SectionColumn" note="Only today-scoped, hands-on minutes count; agent time is a quiet violet note. Over only when it's true (hatched amber overflow). Sections are verb-named, capped at 3 (5 at 2,400 px), with See all N.">
        <div className="grid grid-cols-1 gap-8 min-[1500px]:grid-cols-2">
          <Specimen label="Inline (Home) · the mock day">
            <CapacityMeter youMin={cap.youMin} freeMin={cap.freeMin} agentMin={cap.agentMin} agentRuns={cap.agentRuns} />
          </Specimen>
          <Specimen label="Inline · fits, one agent run (mockup copy)">
            <CapacityMeter youMin={90} freeMin={390} agentRuns={1} />
          </Specimen>
          <Specimen label="Bar (Today header) · fits">
            <CapacityMeter variant="bar" youMin={90} freeMin={390} agentMin={20} />
          </Specimen>
          <Specimen label="Bar · truly over (hatched overflow)">
            <CapacityMeter variant="bar" youMin={460} freeMin={330} />
          </Specimen>
          <Specimen label="AheadStrip · 14 days from tomorrow (amber = prep missing)">
            <div className="max-w-[26rem]">
              <AheadStrip days={sec.aheadDays} onSelectDay={cb('AheadStrip.onSelectDay')} caption />
            </div>
          </Specimen>
          <Specimen label="AheadStrip · narrow (minor day labels drop)">
            <div className="max-w-[15rem]">
              <AheadStrip days={sec.aheadDays} />
            </div>
          </Specimen>
          <Specimen label="SectionColumn · batch action · capped · See all" className="max-w-[28rem]">
            <div className="rounded-lg border border-line bg-surface">
              <SectionColumn title="Reply & approve" count={data.today.moreToday.items.length} action={<Button size="sm" variant="ghost">Approve 2 ready</Button>} seeAllLabel="See all in Outbox →" onSeeAll={cb('SectionColumn.onSeeAll')}>
                {data.today.moreToday.items.map((it) => row(it, { hideMeta: true }))}
              </SectionColumn>
            </div>
          </Specimen>
          <Specimen label="SectionColumn · empty: renders nothing, or a calm line" className="max-w-[28rem]">
            <div className="rounded-lg border border-line bg-surface">
              <SectionColumn title="Chase" count={0} empty="Nobody to chase." />
              <SectionColumn title="Prep" count={0} />
            </div>
          </Specimen>
        </div>
      </Section>

      <Section id="shelves" title="Shelves" note="Pull-forward style rows: a when column, the edge, a title with a faint tag, a quiet verb (filled when selected), hover for snooze / renegotiate / let go.">
        <div className="grid max-w-[1600px] grid-cols-1 gap-8 min-[1400px]:grid-cols-2">
          <Shelf kind="fit_ins" entries={data.today.shelves.fitIns} total={data.today.spine.later.fitIns} onOpenAll={cb('Shelf.onOpenAll')} rowProps={{ onAction: cb('FitInRow.onAction'), onOpen: cb('FitInRow.onOpen'), onSnooze: cb('FitInRow.onSnooze') }} />
          <Shelf
            kind="pull_forward"
            subtitle={`not due today · ~${Math.max(0, Math.round((cap.freeMin - cap.youMin) / 60))}h open`}
            entries={pulls.length ? pulls : sec.ahead.map((d) => ({ item: d.item, hint: d.item.why, action: { label: 'Pull in', verb: 'start' as const } }))}
            max={4}
            selectedItemId={pulls[0]?.item.id ?? sec.ahead[0]?.item.id ?? null}
            onOpenAll={cb('Shelf.onOpenAll')}
            rowProps={{ onAction: cb('PullForward.onAction'), onOpen: cb('PullForward.onOpen'), onSnooze: cb('PullForward.onSnooze') }}
          />
          <Shelf
            kind="promises"
            entries={data.today.shelves.promises}
            total={data.today.spine.later.promises}
            onOpenAll={cb('Shelf.onOpenAll')}
            rowProps={{ onAction: cb('PromiseRow.onAction'), onOpen: cb('PromiseRow.onOpen'), onRenegotiate: cb('PromiseRow.onRenegotiate'), onLetGo: cb('PromiseRow.onLetGo') }}
          />
          <Shelf kind="fit_ins" entries={[]} />
        </div>
      </Section>

      <ReceiptsSection v={v} />

      <Section id="agents" title="AgentRunRow" note="Glyph = state: ○ queued · ◐ running (violet) · ⏸ waiting on you (amber) · ● review (accent) · ✓ done · ✕ failed · ☾ stale. Deep links go to the callback, never opened here.">
        <div className="grid grid-cols-1 items-start gap-8 min-[1500px]:grid-cols-[minmax(0,1fr)_26rem]">
          <Specimen label="Agents page width (second row selected)">
            <div className="overflow-clip rounded-lg border border-line bg-surface">
              {data.agents.runs.map((r, i) => (
                <AgentRunRow key={r.id} run={r} selected={i === 1} taskTitle={data.details.find((d) => d.item.id === r.workItemId)?.item.title} onAction={cb('AgentRunRow.onAction')} onOpenDeepLink={cb('AgentRunRow.onOpenDeepLink')} onOpenTask={cb('AgentRunRow.onOpenTask')} onAnswer={cb('AgentRunRow.onAnswer')} />
              ))}
            </div>
          </Specimen>
          <Specimen label="Narrow" className="max-w-[26rem]">
            <div className="overflow-clip rounded-lg border border-line bg-surface">
              {data.agents.runs.slice(0, 5).map((r) => (
                <AgentRunRow key={r.id} run={r} onAction={cb('AgentRunRow.onAction')} onOpenDeepLink={cb('AgentRunRow.onOpenDeepLink')} onAnswer={cb('AgentRunRow.onAnswer')} />
              ))}
            </div>
          </Specimen>
        </div>
      </Section>

      <BriefsSection data={data} />

      <Section id="health" title="ConnectorRow" note="R-UI-12. Sources are neutral glyphs; only the state is colored. Re-auth by reauth.kind: in-app · terminal command · refresh script · instructions.">
        <div className="overflow-x-auto rounded-lg border border-line bg-surface">
          <div className="min-w-[84rem]">
            <ConnectorRowHeader />
            {data.health.connectors.map((c) => (
              <ConnectorRow key={c.id} connector={c} onReauth={cb('ConnectorRow.onReauth')} onCopyCommand={cb('ConnectorRow.onCopyCommand')} onScan={cb('ConnectorRow.onScan')} onOpen={cb('ConnectorRow.onOpen')} />
            ))}
            {data.health.connectors[1] ? (
              <ConnectorRow
                connector={{ ...data.health.connectors[1], id: 'gmail_broken', state: 'auth_needed', lastError: { class: 'auth', message: 'invalid_grant: token expired', at: data.now, count: 1 }, impact: 'Email after 09:40 may be missing' }}
                onReauth={cb('ConnectorRow.onReauth')}
              />
            ) : null}
            {data.health.connectors[0] ? (
              <ConnectorRow
                connector={{ ...data.health.connectors[0], id: 'x', label: 'Zscaler tunnel', state: 'offline', reauth: { kind: 'instructions', label: 'Connect Zscaler', command: null, instructions: 'Off the corporate network: connect Zscaler, then scanning resumes on its own.' }, lastError: { class: 'offline', message: 'ENOTFOUND (off network)', at: data.now, count: 4 } }}
                onReauth={cb('ConnectorRow.onReauth')}
              />
            ) : null}
          </div>
        </div>
      </Section>

      <TimeSection data={data} />

      <Section id="resolve" title="ResolvePicker" note="R-UI-22 · ⇧D. Keys 1–7 pick a reason, Enter resolves, Esc cancels.">
        <div className="flex flex-wrap items-start gap-6">
          <ResolvePicker title={v.now2?.item.title} people={data.people} threadPeople={v.now2?.item.people.map((p) => p.id) ?? []} relatedItems={data.details.slice(0, 5).map((d) => ({ id: d.item.id, title: d.item.title }))} onResolve={cb('ResolvePicker.onResolve')} onCancel={cb('ResolvePicker.onCancel')} />
          <ResolvePicker title={v.now3?.item.title} defaultResolution="handed_off" people={data.people} threadPeople={v.now3?.item.people.map((p) => p.id) ?? []} onResolve={cb('ResolvePicker.onResolve')} onCancel={cb('ResolvePicker.onCancel')} />
          <ResolvePicker defaultResolution="duplicate" people={data.people} relatedItems={data.details.slice(0, 5).map((d) => ({ id: d.item.id, title: d.item.title }))} onResolve={cb('ResolvePicker.onResolve')} />
        </div>
      </Section>

      <DeprecatedSection data={data} />
    </>
  );
}
