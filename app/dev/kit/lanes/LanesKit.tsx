'use client';
/**
 * Lanes kit: LanePage with three sample lanes ("Fix or approve" left; "Ready to log" and "Sending" stacked right).
 * The frame switches on #cc-main[data-panel] and the main container's width. One button drives the real panel; the
 * other flips the attribute directly (dev only) so both states can be screenshotted. `?columns=one` starts flipped.
 *
 * Each lane shows 8 compact rows (ActionRow `density="compact"` through CompactActivityRow) under a group header
 * (`density="group"`): ticks, the group tick, j / k, Space / x, the where cell's edit and the chevron all work here; the
 * chevron says which row it would open instead of opening the panel (the sample rows are not in the DataSource).
 */
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ActivityEntry } from '@/contract';
import { LanePage, RowGrid, type Lane } from '@/components/kit';
import { useRightPanel } from '@/components/shell/panel';
import { CompactActivityRow, CompactGroupHeader } from '@/components/time/CompactActivityRow';
import { CompactEditor } from '@/components/time/CompactEditor';
import { failureReason } from '@/components/time/compact-derive';
import { Button } from '@/ui/Button';
import { FIX_SAMPLE, READY_SAMPLE, SENDING_FAILED, SENDING_SAMPLE } from './compact-sample';

const PICK = { taskTypeRequired: true, taskTypes: ['Demo', 'Discovery', 'Solution Design'], internalActivity: true };
const SETTLE = 0.75;

type Ticks = { on: Set<string>; toggle: (ids: string[]) => void };

function useTicks(): Ticks {
  const [on, setOn] = useState<Set<string>>(new Set());
  const toggle = (ids: string[]) =>
    setOn((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      for (const id of ids) if (all) next.delete(id);
      else next.add(id);
      return next;
    });
  return { on, toggle };
}

interface GroupProps {
  id: string;
  label: string;
  rows: ActivityEntry[];
  groupVerb: string;
  rowVerb: (e: ActivityEntry) => string | null;
  failed?: Set<string>;
  /** The account · opp the group label names (lane 1): rows show only their confidence. */
  groupTarget?: string;
  ticks: Ticks;
  onOpen: (id: string) => void;
}

function Group({ id, label, rows, groupVerb, rowVerb, failed, groupTarget, ticks, onOpen }: GroupProps) {
  const [editing, setEditing] = useState<string | null>(null);
  const ids = rows.map((e) => e.id);
  const n = ids.filter((x) => ticks.on.has(x)).length;
  return (
    <RowGrid label={label}>
      <CompactGroupHeader
        id={`group-${id}`}
        label={label}
        count={rows.length}
        check={{ checked: n === rows.length, mixed: n > 0 && n < rows.length, onChange: () => ticks.toggle(ids), label: `Tick ${label}` }}
        verb={{ label: `${groupVerb} ${n || rows.length}`, onClick: () => {} }}
      />
      {rows.map((e) => {
        const v = rowVerb(e);
        return (
          <CompactActivityRow
            key={e.id}
            e={e}
            editor={(row) => <CompactEditor e={row} pick={PICK} />}
            settle={SETTLE}
            tz="UTC"
            check={{ checked: ticks.on.has(e.id), onChange: () => ticks.toggle([e.id]), label: `Tick ${e.description}` }}
            verb={v ? { label: v, onClick: () => {} } : null}
            menu={[
              { id: 'set', label: 'Set opp…', icon: 'edit', onClick: () => setEditing(e.id) },
              { id: 'leave', label: 'Leave out', icon: 'close', onClick: () => {} },
            ]}
            failure={failed?.has(e.id) ? failureReason(e) : null}
            groupTarget={groupTarget}
            editing={editing === e.id}
            onEditingChange={(on) => setEditing(on ? e.id : null)}
            selected={ticks.on.has(e.id)}
            onOpen={onOpen}
          />
        );
      })}
    </RowGrid>
  );
}

function setMainPanel(value: 'open' | 'closed') {
  document.getElementById('cc-main')?.setAttribute('data-panel', value);
}

export function LanesKit() {
  const panel = useRightPanel();
  const params = useSearchParams();
  const [flipped, setFlipped] = useState(params.get('columns') === 'one');
  const [opened, setOpened] = useState<string | null>(null);
  const fix = useTicks();
  const ready = useTicks();
  const sending = useTicks();
  useEffect(() => {
    if (!flipped) return;
    setMainPanel('open');
    return () => setMainPanel(panel.open ? 'open' : 'closed');
  }, [flipped, panel.open]);
  const onOpen = (id: string) => setOpened(id);
  const lanes: Lane[] = [
    {
      id: 'fix',
      span: 'left',
      header: { title: 'Fix or approve', count: 36, action: <Button size="sm" variant="primary">Accept 21 suggestions</Button> },
      body: <Group id="fix" label="Suggested: Example Co · Expansion" groupTarget="Example Co · Expansion" rows={FIX_SAMPLE} groupVerb="Accept" rowVerb={(e) => (e.suggestion ? 'Accept' : 'Internal')} ticks={fix} onOpen={onOpen} />,
    },
    {
      id: 'ready',
      span: 'right',
      header: { title: 'Ready to log', count: 11, action: <Button size="sm">Log 11 · 11 h</Button> },
      body: <Group id="ready" label="Tue 17 – Fri 20" rows={READY_SAMPLE} groupVerb="Log" rowVerb={() => null} ticks={ready} onOpen={onOpen} />,
    },
    {
      id: 'sending',
      span: 'right',
      header: { title: 'Sending', count: 2, failure: '2 not found', action: <Button size="sm">Apply</Button> },
      body: <Group id="sending" label="Batch 19 Nov · 4 of 8 checked" rows={SENDING_SAMPLE} groupVerb="Log again" rowVerb={(e) => (SENDING_FAILED.has(e.id) ? 'Log again' : null)} failed={SENDING_FAILED} ticks={sending} onOpen={onOpen} />,
    },
  ];
  return (
    <div className="flex flex-col gap-4 px-6 py-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="mr-auto max-w-[72ch] text-body text-muted">
          LanePage: two columns when <code>#cc-main[data-panel=&quot;closed&quot;]</code> and main is at least 1,100 px wide; one column, with lane pills and
          collapsed lanes, otherwise. Rows: the compact ActionRow (click where it goes to edit; › or Enter opens).
          {opened ? <span data-testid="kit-opened">{` Would open ${opened}.`}</span> : null}
        </p>
        <Button size="sm" onClick={() => setFlipped((f) => !f)}>
          {flipped ? 'Put data-panel back' : 'Flip data-panel to open'}
        </Button>
        <Button size="sm" onClick={() => (panel.open ? panel.close() : panel.openAssistant(null))}>
          {panel.open ? 'Close the panel' : 'Open the Assistant'}
        </Button>
      </div>
      <LanePage lanes={lanes} label="Sample lanes" />
    </div>
  );
}
