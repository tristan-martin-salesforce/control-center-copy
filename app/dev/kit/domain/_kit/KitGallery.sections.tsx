'use client';
// The domain kit gallery's later sections: marks, start-by, deprecated, receipts, briefs, time. Split from KitGallery.tsx (max-lines).
import { useState } from 'react';

import type {
  BriefHighlight, Proposal, RailLane as RailLaneVm, ReceiptChange, RunState, SourceKind, WorkState,
} from '@/contract';
import {
  AccountTag, ActivityRow, ActivityRowHeader, AiMark, BriefHighlightCard, BriefSummary, EffortNote, HeaderStrip,
  ProposalDiff, RailLane, ReceiptCard, RunGlyph, StateGlyph, StatusBadge, StatusRail, useClock, type BadgeTone,
} from '@/components/domain';
import { EntityChip, SourceChip, StartBy } from '@/components/domain/lib';
import { Button } from '@/ui';
import { useKitLog } from './kit-log';
import { Section, Specimen } from './KitFrame';
import type { KitData } from './load';
import type { buildVariants } from './variants';

export function Marks() {
  const tones: BadgeTone[] = ['danger', 'warning', 'success', 'ai', 'now', 'neutral'];
  const kinds: SourceKind[] = ['slack', 'gmail', 'calendar', 'drive', 'gemini', 'org62', 'vdp', 'claude', 'manual'];
  const runStates: RunState[] = ['queued', 'running', 'waiting_on_you', 'done_review', 'done', 'failed', 'stale'];
  const workStates: WorkState[] = ['suggested', 'open', 'in_progress', 'waiting_on_me', 'waiting_on_others', 'likely_done', 'done', 'reopened', 'snoozed', 'dismissed'];
  const label: Record<BadgeTone, [string, string]> = {
    danger: ['ban', 'Blocked'],
    warning: ['clock', 'Start by 08:35'],
    success: ['check', 'Fits'],
    ai: ['sparkle', 'Drafted'],
    now: ['clock', 'Now'],
    neutral: ['clock', 'Snoozed'],
  };
  return (
    <Section id="marks" title="Marks" note="Color is an indicator, never identity: blue = the one action, now, selection · red = overdue, blocked, broken · amber = at risk, prep missing · green = ready · violet = AI. Accounts and sources are neutral. Status is always icon + word.">
      <div className="grid grid-cols-1 gap-x-10 gap-y-6 min-[1400px]:grid-cols-2">
        <Specimen label="StatusBadge · the six roles">
          <div className="flex flex-wrap gap-2">
            {tones.map((t) => (
              <StatusBadge key={t} tone={t} icon={label[t][0]}>
                {label[t][1]}
              </StatusBadge>
            ))}
            <StatusBadge tone="ai" dashed>
              Suggested
            </StatusBadge>
          </div>
        </Specimen>
        <Specimen label="Quiet actions, loud selection · quiet verb / secondary / the one filled">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="ghost" size="sm">
              Send draft
            </Button>
            <Button variant="secondary" size="md">
              Review 3
            </Button>
            <Button variant="primary" size="md" kbd="mod+enter">
              Open in Claude
            </Button>
          </div>
        </Specimen>
        <Specimen label="AccountTag (neutral) · AiMark · EffortNote">
          <div className="flex flex-wrap items-center gap-3">
            <AccountTag label="Account A" />
            <AccountTag label="Outbox" />
            <AccountTag label="Account B · plain" plain />
            <AiMark>Drafted for you</AiMark>
            <EffortNote youMin={20} agentMin={20} />
            <EffortNote youMin={50} />
          </div>
        </Specimen>
        <Specimen label="SourceChip · neutral glyphs, labelled and compact">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1">
              {kinds.map((k) => (
                <SourceChip key={k} source={k} />
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {kinds.map((k) => (
                <SourceChip key={k} source={k} compact />
              ))}
            </div>
          </div>
        </Specimen>
        <Specimen label="StartBy · calm / soon / late / headline · EntityChip">
          <div className="flex flex-wrap items-center gap-4">
            <StartByFromClock />
            <EntityChip kind="account" label="Account A" />
            <EntityChip kind="initiative" label="Initiative" />
            <EntityChip kind="person" label="Person" bare />
          </div>
        </Specimen>
        <Specimen label="RunGlyph · StateGlyph">
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-4 text-caption text-muted">
              {runStates.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <RunGlyph state={s} size={16} /> {s.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
            <div className="flex flex-wrap items-center gap-4 text-caption text-muted">
              {workStates.map((s) => (
                <span key={s} className="inline-flex items-center gap-1.5">
                  <StateGlyph state={s} size={16} /> {s.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
function StartByFromClock() {
  const { now } = useClock();
  const at = (m: number) => new Date(Date.parse(now) + m * 60_000).toISOString();
  return (
    <span className="flex flex-wrap items-center gap-4">
      <StartBy at={at(45)} />
      <StartBy at={at(10)} />
      <StartBy at={at(-5)} />
      <StartBy at={at(13)} size="lg" />
    </span>
  );
}
export function DeprecatedSection({ data }: { data: KitData }) {
  const cb = useKitLog();
  const lanes = data.today.rail;
  const railCb = { onEntryAction: cb('RailLane.onEntryAction'), onOpenEntry: cb('RailLane.onOpenEntry'), onOpenLane: cb('RailLane.onOpenLane'), onOpenEvidence: cb('RailLane.onOpenEvidence') };
  const healthy: RailLaneVm = { lane: 'health', label: 'HEALTH', count: 0, summary: '8/8 connected', entries: [], href: '/health', visible: true };
  const waiting = lanes.find((l) => l.lane === 'waiting_on_you');
  return (
    <Section id="deprecated" title="Deprecated" note="Design v2 has no status rail and no header strip: their content moved to Home's verb sections, the agent's plan and CapacityMeter. Kept compiling, restyled minimally, until the page lanes drop them.">
      <div className="flex flex-wrap items-start gap-6 opacity-90">
        <Specimen label="StatusRail · 380 px" className="w-[23.75rem]">
          <StatusRail className="h-[36rem]" lanes={lanes} {...railCb} onToggleLane={cb('StatusRail.onToggleLane')} />
        </Specimen>
        <div className="w-[23.75rem] space-y-6">
          {waiting ? (
            <Specimen label="RailLane · Waiting on you, expanded">
              <div className="rounded-lg border border-line bg-surface">
                <RailLane lane={waiting} expanded {...railCb} />
              </div>
            </Specimen>
          ) : null}
          <Specimen label="RailLane · Health, all connected">
            <div className="rounded-lg border border-line bg-surface">
              <RailLane lane={healthy} {...railCb} />
            </div>
          </Specimen>
          <Specimen label="StatusRail · empty">
            <StatusRail lanes={[]} />
          </Specimen>
        </div>
        <Specimen label="HeaderStrip" className="min-w-0 flex-1">
          <div className="flex h-12 items-center justify-end overflow-hidden rounded-lg border border-line bg-surface px-3">
            <HeaderStrip header={data.today.header} onOpenMeeting={cb('HeaderStrip.onOpenMeeting')} onOpenDeadline={cb('HeaderStrip.onOpenDeadline')} onOpenCatchUp={cb('HeaderStrip.onOpenCatchUp')} onOpenCapacity={cb('HeaderStrip.onOpenCapacity')} />
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
export function ReceiptsSection({ v }: { v: ReturnType<typeof buildVariants> }) {
  const cb = useKitLog();
  const [undone, setUndone] = useState<string[]>(['aud_kit_3']);
  const [proposals, setProposals] = useState<Record<string, Proposal['status']>>({});
  const settle = (p: Proposal, status: Proposal['status']) => setProposals((s) => ({ ...s, [p.id]: status }));
  const withStatus = (p: Proposal | null | undefined) => (p ? { ...p, status: proposals[p.id] ?? p.status } : null);
  const fieldProposal = withStatus(v.fieldProposal?.proposals.find((p) => p.status === 'pending'));
  const draftProposal = withStatus(v.touched?.proposals[0]);
  const conflict = withStatus(v.conflict);
  return (
    <Section id="receipts" title="ReceiptCard · ProposalDiff" note="The agent's work wears the agentic border and one ✦. Receipts: a mark per line, before → after, quiet Undo, Undo all. Staged (the agent's plan, or more than five changes): Accept all / Apply. Proposals: Apply / Keep mine; the 409 variant is amber.">
      <div className="grid grid-cols-1 items-start gap-6 min-[1400px]:grid-cols-2 min-[2200px]:grid-cols-3">
        <Specimen label="ReceiptCard · chat re-prioritize (one line undone)">
          <ReceiptCard
            receipt={v.receipt}
            undone={undone}
            onUndo={(c: ReceiptChange) => {
              setUndone((u) => [...u, c.auditId]);
              cb('ReceiptCard.onUndo')(c.auditId);
            }}
            onUndoAll={(r) => {
              setUndone(r.changes.map((c) => c.auditId));
              cb('ReceiptCard.onUndoAll')(r);
            }}
            onOpenEntity={cb('ReceiptCard.onOpenEntity')}
          />
        </Specimen>
        <Specimen label="ReceiptCard · staged (Apply)">
          <ReceiptCard receipt={v.staged} onApply={cb('ReceiptCard.onApply')} onOpenEntity={cb('ReceiptCard.onOpenEntity')} />
        </Specimen>
        {fieldProposal ? (
          <Specimen label="ProposalDiff · engine change to a locked field">
            <ProposalDiff
              proposal={fieldProposal}
              onApply={(p) => {
                settle(p, 'applied');
                cb('ProposalDiff.onApply')(p);
              }}
              onKeepMine={(p) => {
                settle(p, 'rejected');
                cb('ProposalDiff.onKeepMine')(p);
              }}
              onOpenSource={cb('ProposalDiff.onOpenSource')}
            />
          </Specimen>
        ) : null}
        {draftProposal ? (
          <Specimen label="ProposalDiff · draft body (text diff)">
            <ProposalDiff proposal={draftProposal} onApply={(p) => settle(p, 'applied')} onKeepMine={(p) => settle(p, 'rejected')} />
          </Specimen>
        ) : null}
        {conflict ? (
          <Specimen label="ProposalDiff · changed elsewhere (409)">
            <ProposalDiff proposal={conflict} conflict onApply={(p) => settle(p, 'applied')} onKeepMine={(p) => settle(p, 'rejected')} />
          </Specimen>
        ) : null}
        {fieldProposal ? (
          <Specimen label="ProposalDiff · strip (inside a card)">
            <div className="overflow-clip rounded-lg border border-line bg-surface">
              <ProposalDiff proposal={{ ...fieldProposal, status: 'pending' }} variant="strip" defaultDiffOpen onApply={cb('ProposalDiff.onApply')} onKeepMine={cb('ProposalDiff.onKeepMine')} className="border-t-0" />
            </div>
          </Specimen>
        ) : null}
      </div>
    </Section>
  );
}
export function BriefsSection({ data }: { data: KitData }) {
  const cb = useKitLog();
  const [status, setStatus] = useState<Record<string, BriefHighlight['status']>>({});
  const hs = (data.brief?.highlights ?? []).map((h) => ({ ...h, status: status[h.id] ?? h.status }));
  const set = (h: BriefHighlight, s: BriefHighlight['status']) => setStatus((x) => ({ ...x, [h.id]: s }));
  const [sel, setSel] = useState(data.briefs.watched[0]?.id ?? null);
  return (
    <Section id="briefs" title="Briefs" note="R-UI-21: reading material, never competes with Do now (no filled action). Neutral icons; only 'new' gets the accent dot.">
      <div className="grid grid-cols-1 items-start gap-6 min-[1400px]:grid-cols-[26rem_minmax(0,1fr)]">
        <Specimen label="BriefSummary · Watched + My opportunities">
          <div className="overflow-clip rounded-lg border border-line bg-surface">
            <p className="border-b border-line px-4 py-2.5 text-body font-bold text-fg-heading">Watched</p>
            {data.briefs.watched.map((b) => (
              <BriefSummary key={b.id} brief={b} selected={sel === b.id} onOpen={(x) => { setSel(x.id); cb('BriefSummary.onOpen')(x); }} />
            ))}
            <p className="border-y border-line px-4 py-2.5 text-body font-bold text-fg-heading">My opportunities</p>
            {data.briefs.opportunities.map((b) => (
              <BriefSummary key={b.id} brief={b} selected={sel === b.id} onOpen={(x) => { setSel(x.id); cb('BriefSummary.onOpen')(x); }} />
            ))}
            {data.briefs.watched[0] ? <BriefSummary brief={{ ...data.briefs.watched[0], id: 'gen', title: '#a-channel', status: 'generating', unread: false }} /> : null}
          </div>
        </Specimen>
        <Specimen label="BriefHighlightCard · Promote / Make task / Not relevant change state">
          <div className="grid grid-cols-1 gap-4 min-[1900px]:grid-cols-2">
            {hs.map((h) => (
              <BriefHighlightCard
                key={h.id}
                highlight={h}
                onPromote={(x) => { set(x, 'promoted'); cb('BriefHighlightCard.onPromote')(x); }}
                onMakeTask={(x) => { set(x, 'promoted'); cb('BriefHighlightCard.onMakeTask')(x); }}
                onDismiss={(x) => { set(x, 'dismissed'); cb('BriefHighlightCard.onDismiss')(x); }}
                onUndo={(x) => { set(x, 'new'); cb('BriefHighlightCard.onUndo')(x); }}
                onOpenSource={cb('BriefHighlightCard.onOpenSource')}
              />
            ))}
          </div>
        </Specimen>
      </div>
    </Section>
  );
}
export function TimeSection({ data }: { data: KitData }) {
  const cb = useKitLog();
  const [saving, setSaving] = useState<Record<string, 'saving' | 'saved'>>({});
  const rows = data.time.entries.slice(0, 10);
  return (
    <Section id="time" title="ActivityRow" note="R-UI-6 · autosave per row: edit a field; the status slot shows what the page would render (InlineStatus).">
      <div className="overflow-x-auto rounded-lg border border-line bg-surface">
        <div className="min-w-[90rem]">
          <ActivityRowHeader />
          {rows.map((e) => (
            <ActivityRow
              key={e.id}
              entry={e}
              taskTypes={data.taskTypes}
              opps={data.opps}
              statusSlot={saving[e.id] === 'saving' ? 'Saving…' : saving[e.id] === 'saved' ? 'Saved · just now' : e.userLockedFields.length ? 'Edited by you' : null}
              onChange={(patch, entry) => {
                cb('ActivityRow.onChange')(JSON.stringify(patch), entry.description);
                setSaving((s) => ({ ...s, [entry.id]: 'saving' }));
                setTimeout(() => setSaving((s) => ({ ...s, [entry.id]: 'saved' })), 700);
              }}
              onOpenSource={cb('ActivityRow.onOpenSource')}
            />
          ))}
        </div>
      </div>
    </Section>
  );
}
