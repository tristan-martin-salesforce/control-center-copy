'use client';
/**
 * The small interactions around a Triage item: inline edit-then-accept (`e`), the merge target picker
 * (`m`) and the dismiss reason dialog (`n`). Detail for every kind lives in the docked right panel.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { TriageItem, WorkItem } from '@/contract';
import { useApi } from '@/client/hooks';
import { DISMISS_REASONS } from '@/components/lists/triage-reasons';
import { Button, cn, Icon, Kbd, Overlay } from '@/ui';

// ── edit then accept ─────────────────────────────────────────────────────────────────────────

export function TriageEditor({ item, onSave, onCancel }: { item: WorkItem; onSave: (edits: { title: string; purpose: string | null }) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [purpose, setPurpose] = useState(item.purpose ?? '');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const save = () => {
    if (!title.trim()) return;
    onSave({ title: title.trim(), purpose: purpose.trim() ? purpose.trim() : null });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div role="group" aria-label="Edit before accepting" data-testid="triage-editor" onKeyDown={onKeyDown} className="grid max-w-[60rem] gap-3">
      <p className="text-body font-bold text-fg-heading">Edit, then accept</p>
      <label className="block text-caption text-muted">
        Title (verb first)
        <input
          ref={ref}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 h-9 w-full rounded-md border border-line-input bg-surface-input px-3 text-body text-fg placeholder:text-faint focus:border-focus focus:outline-none focus:shadow-focus"
        />
      </label>
      <label className="block text-caption text-muted">
        What it is for
        <input
          value={purpose}
          onChange={(e) => setPurpose(e.target.value)}
          placeholder="For: the meeting or deliverable this serves"
          className="mt-1 h-9 w-full rounded-md border border-line-input bg-surface-input px-3 text-body text-fg placeholder:text-faint focus:border-focus focus:outline-none focus:shadow-focus"
        />
      </label>
      <div className="flex items-center justify-end gap-2">
        <Button variant="quiet" size="sm" onClick={onCancel} kbd="escape">
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={save} disabled={!title.trim()} kbd="enter">
          Accept with edits
        </Button>
      </div>
    </div>
  );
}

// ── merge ─────────────────────────────────────────────────────────────────────────────────────

export function MergePicker({ source, onPick, onClose }: { source: TriageItem | null; onPick: (target: { id: string; title: string }) => void; onClose: () => void }) {
  const open = !!source;
  const open_ = useApi('listItems', { query: { tab: 'all_open' } }, { enabled: open });
  const [q, setQ] = useState('');
  const [cursor, setCursor] = useState(0);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQ('');
      setCursor(0);
    }
  }, [open, source?.id]);

  const list = useMemo(() => {
    const items = (open_.data?.items ?? []).filter((i) => i.id !== source?.id);
    const sw = source?.workItem;
    const score = (i: WorkItem) => (sw && i.refs.initiative && i.refs.initiative.id === sw.refs.initiative?.id ? 2 : 0) + (sw && i.refs.account && i.refs.account.id === sw.refs.account?.id ? 1 : 0);
    const needle = q.trim().toLowerCase();
    return items
      .filter((i) => !needle || `${i.title} ${i.refs.account?.label ?? ''} ${i.refs.initiative?.label ?? ''}`.toLowerCase().includes(needle))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 30);
  }, [open_.data, q, source]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setCursor((c) => Math.min(list.length - 1, c + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, c - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const t = list[cursor];
      if (t) onPick({ id: t.id, title: t.title });
    }
  };

  return (
    <Overlay open={open} onClose={onClose} labelledBy={id} position="top" className="p-0">
      <div onKeyDown={onKeyDown} className="w-[34rem] max-w-[92vw]" data-testid="merge-picker">
        <div className="border-b border-line px-4 pt-3 pb-2">
          <h2 id={id} className="truncate text-title text-fg-heading">
            Merge into an existing item
          </h2>
          <p className="truncate text-caption text-muted">“{source?.title}” becomes evidence on the item you pick.</p>
          <div className="mt-2 flex h-9 items-center gap-2 rounded-md border border-line-input bg-surface-input px-3 focus-within:border-focus focus-within:shadow-focus">
            <Icon name="search" size="sm" className="text-muted" />
            <input
              ref={input}
              data-autofocus
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setCursor(0);
              }}
              placeholder="Search open items"
              aria-label="Search open items"
              role="combobox"
              aria-expanded
              aria-controls={`${id}-list`}
              className="min-w-0 flex-1 bg-transparent text-body placeholder:text-faint focus:outline-none"
            />
          </div>
        </div>
        <ul id={`${id}-list`} role="listbox" aria-label="Open items" className="cc-scroll max-h-80 overflow-y-auto py-1">
          {list.map((i, idx) => (
            <li key={i.id} role="option" aria-selected={idx === cursor}>
              <button
                type="button"
                onMouseEnter={() => setCursor(idx)}
                onClick={() => onPick({ id: i.id, title: i.title })}
                className={cn('flex h-9 w-full items-center gap-2 px-4 text-left text-body', idx === cursor ? 'bg-selected' : 'hover:bg-surface-muted')}
              >
                <span className="min-w-0 flex-1 truncate font-bold text-fg">{i.title}</span>
                <span className="max-w-48 shrink-0 truncate text-caption text-muted">{i.refs.initiative?.label ?? i.refs.account?.label ?? ''}</span>
              </button>
            </li>
          ))}
          {!list.length ? <li className="px-4 py-3 text-caption text-muted">{open_.isLoading ? 'Loading…' : 'No open item matches.'}</li> : null}
        </ul>
        <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-caption text-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> move
          </span>
          <span>
            <Kbd>↵</Kbd> merge
          </span>
          <span>
            <Kbd>Esc</Kbd> cancel
          </span>
        </div>
      </div>
    </Overlay>
  );
}

// ── dismiss reasons ─────────────────────────────────────────────────────────────────────────────

export function DismissDialog({ item, onPick, onClose }: { item: TriageItem | null; onPick: (reason: string) => void; onClose: () => void }) {
  const id = useId();
  const reasons = item ? DISMISS_REASONS[item.kind] : [];
  const onKeyDown = (e: KeyboardEvent) => {
    const n = Number(e.key);
    if (n >= 1 && n <= reasons.length && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      onPick(reasons[n - 1]!.value);
    }
  };
  return (
    <Overlay open={!!item} onClose={onClose} labelledBy={id} className="p-4">
      <div onKeyDown={onKeyDown} className="w-[24rem] max-w-[90vw]" data-testid="dismiss-dialog">
        <h2 id={id} className="truncate text-title text-fg-heading">
          Dismiss: {item?.title}
        </h2>
        <p className="mt-0.5 text-caption text-muted">Why? It tunes what Triage suggests next time.</p>
        <div role="group" aria-label="Dismiss because" className="mt-3 flex flex-wrap gap-1.5">
          {reasons.map((r, i) => (
            <button
              key={r.value}
              type="button"
              data-autofocus={i === 0 ? '' : undefined}
              onClick={() => onPick(r.value)}
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-line-strong bg-surface px-3 text-body text-fg hover:bg-surface-muted focus-visible:outline-none focus-visible:shadow-focus"
            >
              <Kbd>{i + 1}</Kbd>
              {r.label}
            </button>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
