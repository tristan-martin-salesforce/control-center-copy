'use client';
/**
 * Small Today-only parts built on @/ui primitives: the inline action error (UI-SPEC §9 "Couldn't … ·
 * Retry", persists until retried or dismissed), the pre-emption label, a popover anchored to a card or
 * row (opened by key or click), the snooze menu and the short tool-run form (explicit Run).
 */
import { useMemo, useState, type ReactNode } from 'react';
import type { NbaCard as NbaCardVm, ToolAdapter } from '@/contract';
import { useSheetQuery } from './useSheetQuery';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Icon } from '@/ui/Icon';
import { KbdHint } from '@/ui/Kbd';
import { Popover } from '@/ui/Popover';
import { Skeleton } from '@/ui/states';
import { StatePill } from '@/ui/badges';
import { fmtClock, fmtDay } from '@/ui/format';
import type { ActionError } from './useTodayActions';
import { snoozePresets } from './model';

export function ActionErrorLine({ error, onDismiss, className }: { error: ActionError; onDismiss: () => void; className?: string }) {
  return (
    <p role="alert" className={cn('flex items-center gap-1.5 rounded-md bg-danger-50 px-2.5 py-1 text-caption text-danger-700', className)}>
      <Icon name="error" size="xs" />
      <span className="min-w-0 flex-1 truncate">
        Couldn’t {error.verb}: {error.message}. Change rolled back.
      </span>
      <button type="button" onClick={error.retry} className="font-bold text-link hover:underline">
        Retry
      </button>
      <span aria-hidden className="text-faint">
        ·
      </span>
      <button type="button" onClick={onDismiss} className="text-muted hover:text-fg" aria-label="Dismiss error">
        Dismiss
      </button>
    </p>
  );
}

export function PreemptLine({ kind, text }: { kind: 'promoted' | 'preempt'; text: string }) {
  return (
    <p className={cn('mb-1 flex items-center gap-1 px-1 text-caption font-bold', kind === 'preempt' ? 'text-warning-700' : 'text-brand-700')}>
      <Icon name="arrowup" size="xs" />
      {text}
    </p>
  );
}

/** A popover anchored to an invisible point inside its (relative) parent, so keys can open it too. */
export function AnchoredPopover({
  open,
  onOpenChange,
  children,
  label,
  width = 280,
  placement = 'bottom-end',
  anchorClassName = 'right-4 top-9',
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  children: ReactNode | ((api: { close: () => void }) => ReactNode);
  label: string;
  width?: number;
  placement?: 'bottom-end' | 'bottom-start' | 'top-end' | 'left-start';
  anchorClassName?: string;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange} placement={placement} width={width} label={label} trigger={<span aria-hidden className={cn('pointer-events-none absolute size-px', anchorClassName)} />}>
      {children}
    </Popover>
  );
}

export function SnoozeMenu({ now, tz, onPick, onCancel }: { now: string; tz?: string; onPick: (until: string, label: string) => void; onCancel: () => void }) {
  const presets = useMemo(() => snoozePresets(now, tz), [now, tz]);
  const label = (iso: string) => {
    const sameDay = fmtDay(iso, tz) === fmtDay(now, tz);
    return sameDay ? fmtClock(iso, tz) : `${fmtDay(iso, tz)} ${fmtClock(iso, tz)}`;
  };
  return (
    <div className="py-1" role="menu" aria-label="Snooze until">
      <p className="eyebrow px-3 pt-1 pb-1.5">Snooze until</p>
      {presets.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="menuitem"
          data-autofocus={i === 0 ? '' : undefined}
          onClick={() => onPick(p.until, label(p.until))}
          onKeyDown={(e) => {
            if (/^[1-3]$/.test(e.key)) {
              e.preventDefault();
              const q = presets[Number(e.key) - 1];
              if (q) onPick(q.until, label(q.until));
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const items = Array.from((e.currentTarget.parentElement as HTMLElement).querySelectorAll<HTMLElement>('[role="menuitem"]'));
              const n = items.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1);
              items[(n + items.length) % items.length]?.focus();
            }
          }}
          className="flex h-8 w-full items-center gap-2 px-3 text-left text-body text-fg hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none"
        >
          <span className="w-3 text-micro text-faint tabular-nums">{i + 1}</span>
          <span className="flex-1">{p.label}</span>
          <span className="text-caption text-muted tabular-nums">{label(p.until)}</span>
        </button>
      ))}
      <div className="mt-1 flex items-center justify-end border-t border-line px-3 pt-1.5 pb-0.5">
        <button type="button" onClick={onCancel} className="inline-flex items-center gap-1 text-caption text-muted hover:text-fg">
          Cancel <KbdHint combo="escape" />
        </button>
      </div>
    </div>
  );
}

type Field = { key: string; label: string; type: 'string' | 'number' | 'boolean' | 'enum'; options?: string[]; required: boolean };

/** Every input the tool's schema names (never cut: a required 7th field must show, caps audit F-13). */
export function fieldsOf(adapter: ToolAdapter | undefined, prefill: Record<string, unknown>): Field[] {
  const schema = (adapter?.manifest.input.schema ?? {}) as { properties?: Record<string, { type?: string; title?: string; enum?: unknown[] }>; required?: string[] };
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  const keys = Object.keys(props).length ? Object.keys(props) : Object.keys(prefill);
  return keys.map((key) => {
    const p = props[key] ?? {};
    const type = p.enum ? 'enum' : p.type === 'number' || p.type === 'integer' ? 'number' : p.type === 'boolean' ? 'boolean' : 'string';
    return { key, label: p.title ?? key.replace(/([A-Z])/g, ' $1').replace(/[_-]/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), type, options: p.enum?.map(String), required: required.has(key) };
  });
}

/** A long form keeps its first six fields in view plus every required one; "More" folds the rest (optional only). */
export const FORM_FIRST = 6;
export function splitFields(fields: Field[]): { shown: Field[]; more: Field[] } {
  if (fields.length <= FORM_FIRST + 1) return { shown: fields, more: [] }; // one extra row is not worth a fold
  const shown = fields.filter((f, i) => i < FORM_FIRST || f.required);
  return { shown, more: fields.filter((f) => !shown.includes(f)) };
}

/** Short input form for a ToolAdapter run (R-UI-13). Explicit Run; errors stay inline. */
export function ToolRunForm({ nba, onRun, onCancel }: { nba: NbaCardVm; onRun: (adapterId: string, inputs: Record<string, unknown>, name?: string) => Promise<string | null>; onCancel: () => void }) {
  const tools = useSheetQuery('getTools');
  const adapterId = nba.toolAdapterId ?? '';
  const adapter = tools.data?.adapters.find((a) => a.manifest.id === adapterId);
  const prefill = nba.toolInputs ?? {};
  const fields = fieldsOf(adapter, prefill);
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...prefill }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const missing = fields.filter((f) => f.required && (values[f.key] === undefined || values[f.key] === ''));

  const submit = async () => {
    if (missing.length || busy) return;
    setBusy(true);
    setError(null);
    const err = await onRun(adapterId, values, adapter?.manifest.name);
    setBusy(false);
    if (err) setError(err);
  };

  const { shown, more } = splitFields(fields);
  const fieldRow = (f: Field, i: number) => (
    <label key={f.key} className="block">
      <span className="text-caption text-muted">
        {f.label}
        {f.required ? <span className="text-danger-700"> *</span> : null}
      </span>
      {f.type === 'boolean' ? (
        <input type="checkbox" className="ml-2 align-middle" checked={Boolean(values[f.key])} onChange={(e) => setValues({ ...values, [f.key]: e.target.checked })} />
      ) : f.type === 'enum' ? (
        <select
          value={String(values[f.key] ?? '')}
          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
          className="mt-0.5 h-8 w-full rounded-md border border-line-input bg-surface px-2 text-body focus:border-brand-600 focus:outline-none"
        >
          <option value="">Choose…</option>
          {f.options?.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          data-autofocus={i === 0 ? '' : undefined}
          type={f.type === 'number' ? 'number' : 'text'}
          value={values[f.key] === undefined || values[f.key] === null ? '' : String(values[f.key])}
          onChange={(e) => setValues({ ...values, [f.key]: f.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
          className="mt-0.5 h-8 w-full rounded-md border border-line-input bg-surface px-2 text-body placeholder:text-faint focus:border-brand-600 focus:outline-none"
        />
      )}
    </label>
  );

  return (
    <form
      className="p-3"
      aria-label={`Run ${adapter?.manifest.name ?? adapterId}`}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex items-center gap-2">
        <Icon name="apex" size="sm" className="text-brand-700" />
        <p className="min-w-0 flex-1 truncate text-body-lg font-bold text-fg-heading">{adapter?.manifest.name ?? adapterId}</p>
        {adapter ? <StatePill size="xs" tone={adapter.health.state === 'ok' ? 'ok' : adapter.health.state === 'down' ? 'risk' : 'neutral'} label={adapter.health.state === 'ok' ? 'Running' : adapter.health.state === 'down' ? 'Not running' : 'Unknown'} /> : null}
      </div>
      {adapter ? <p className="mt-0.5 line-clamp-2 text-caption text-muted">{adapter.manifest.description}</p> : null}
      {tools.isLoading ? <Skeleton count={3} className="mt-3" /> : null}
      <div className="mt-3 space-y-2">
        {shown.map((f, i) => fieldRow(f, i))}
        {more.length ? (
          <details className="rounded-md border border-line px-2 py-1" data-testid="tool-form-more">
            <summary className="cursor-pointer text-caption text-muted">More ({more.length} optional)</summary>
            <div className="mt-2 space-y-2">{more.map((f) => fieldRow(f, -1))}</div>
          </details>
        ) : null}
        {!fields.length && !tools.isLoading ? <p className="text-caption text-muted">This tool takes no inputs.</p> : null}
      </div>
      {error ? (
        <p role="alert" className="mt-2 flex items-start gap-1.5 rounded-md bg-danger-50 px-2 py-1 text-caption text-danger-700">
          <Icon name="error" size="xs" className="mt-0.5" />
          <span>Couldn’t start it: {error}</span>
        </p>
      ) : null}
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" type="submit" loading={busy} disabled={!!missing.length || !adapterId}>
          Run
        </Button>
      </div>
    </form>
  );
}
