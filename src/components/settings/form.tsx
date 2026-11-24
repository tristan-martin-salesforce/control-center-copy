'use client';
/**
 * Settings plumbing (UI-SPEC §8, §10): a draft per section (or block), an optimistic save with rollback and
 * 409 "changed elsewhere", the guard that warns before you leave with unsaved changes, and the v2 layout
 * pieces every section shares: a sticky section header that says how it saves, label-left rows and blocks.
 */
import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { RouteOutput, Settings } from '@/contract';
import { queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { Button, ChangedElsewhere, cn, Dialog } from '@/ui';
import { changedKeys, isDirty, same, type SectionId } from './derive';
import s from './settings.module.css';
import { BlockHeadingLevel } from './heading-level';

export { BlockHeadingLevel };
import { navigate } from '@/components/shell/router';

// ── Unsaved-changes guard ──────────────────────────────────────────────────────────────────

interface Guard {
  setDirty: (id: string, label: string, dirty: boolean) => void;
}
/** Stable (never changes), so reporting dirtiness never re-renders the reporters. */
const GuardCtx = createContext<Guard>({ setDirty: () => {} });
/** Ids that hold unsaved edits, formatted `<sectionId>:<block>`. */
const DirtyCtx = createContext<string[]>([]);

export function UnsavedGuard({ children }: { children: ReactNode }) {
  const dirty = useRef(new Map<string, string>());
  const [pending, setPending] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<Array<[string, string]>>([]);
  const setDirty = useCallback((id: string, label: string, d: boolean) => {
    const had = dirty.current.has(id);
    if (d === had) return;
    if (d) dirty.current.set(id, label);
    else dirty.current.delete(id);
    setSnapshot([...dirty.current.entries()]);
  }, []);

  useEffect(() => {
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current.size) return;
      e.preventDefault();
      e.returnValue = '';
    };
    // In-app links to another page: intercept in the capture phase while something is dirty.
    const onClick = (e: MouseEvent) => {
      if (!dirty.current.size || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as HTMLElement).closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== window.location.origin || a.pathname === window.location.pathname) return;
      e.preventDefault();
      e.stopPropagation();
      setPending(a.pathname + a.search);
    };
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', onClick, true);
    };
  }, []);

  const value = useMemo(() => ({ setDirty }), [setDirty]);
  const dirtyIds = useMemo(() => snapshot.map(([id]) => id), [snapshot]);
  const labels = [...new Set(snapshot.map(([, l]) => l))];
  return (
    <GuardCtx.Provider value={value}>
      <DirtyCtx.Provider value={dirtyIds}>{children}</DirtyCtx.Provider>
      <Dialog
        open={pending !== null}
        onClose={() => setPending(null)}
        title="Leave without saving?"
        description={`You have unsaved changes in ${labels.join(', ')}. They will be lost.`}
        cancelLabel="Stay"
        confirmLabel="Leave and discard"
        tone="danger"
        onConfirm={() => {
          const to = pending;
          dirty.current.clear();
          setSnapshot([]);
          setPending(null);
          if (to) navigate(to);
        }}
      />
    </GuardCtx.Provider>
  );
}

export function useReportDirty(id: string, label: string, dirty: boolean) {
  const g = useContext(GuardCtx);
  useEffect(() => {
    g.setDirty(id, label, dirty);
  }, [g, id, label, dirty]);
  useEffect(() => () => g.setDirty(id, label, false), [g, id, label]);
}

/** Section ids that hold unsaved edits (the nav's "Edited" mark). */
export function useDirtySections(): Set<SectionId> {
  const dirtyIds = useContext(DirtyCtx);
  return useMemo(() => new Set(dirtyIds.map((id) => id.split(':')[0] as SectionId)), [dirtyIds]);
}

// ── Section form ───────────────────────────────────────────────────────────────────────────

type SectionKey = 'profile' | 'agentBehavior' | 'sending' | 'budgets' | 'display' | 'time' | 'closing' | 'chat' | 'persona' | 'feedback';
type Val<K extends SectionKey> = Omit<Settings[K], 'version'>;
type PatchResult = RouteOutput<'patchSettings'>;

export interface SectionFormOptions {
  /** Topics to invalidate after a save (default: settings, health, today). */
  topics?: string[];
  /** An Undo toast after a save; the audit entry the patch returns is attached as its Undo. */
  toast?: (res: PatchResult, sent: Record<string, unknown>) => { title: string; body?: string; key?: string } | null;
  /** After a save lands: the server's settings, its audit id, and what was sent. */
  onSaved?: (res: PatchResult, sent: Record<string, unknown>) => void;
}

export function useSectionForm<K extends SectionKey>(section: K, keys: readonly (keyof Val<K>)[], label: string, navId: SectionId, opts?: SectionFormOptions) {
  const qc = useQueryClient();
  const q = useApi('getSettings');
  const server = q.data?.[section] as Settings[K] | undefined;
  const { version: _v, ...serverVal } = (server ?? {}) as Settings[K];
  const serverRef = serverVal as Val<K>;
  const [draft, setDraft] = useState<Val<K>>(serverRef);
  const [base, setBase] = useState<Val<K> | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /**
   * Keys you edited and haven't saved yet. Only untouched keys adopt server values (first load, live updates,
   * a save landing, "take theirs"), so an optimistic save that rolls back never takes your edit with it.
   */
  const [touched, setTouched] = useState<ReadonlySet<keyof Val<K>>>(() => new Set());
  if (server && (base === null || keys.some((k) => !same(base[k], serverRef[k])))) {
    setBase(serverRef);
    setDraft((d) => {
      const next = { ...d };
      for (const k of keys) if (base === null || !touched.has(k)) next[k] = serverRef[k];
      return next;
    });
  }
  const dirty = !!server && isDirty(draft as Record<string, unknown>, serverRef as Record<string, unknown>, keys as never);
  useReportDirty(`${navId}:${label}`, label, dirty);

  const m = useOptimisticMutation({
    route: 'patchSettings',
    // health + today carry `dryRun` for the footer chip; budgets feed the header chip
    topics: opts?.topics ?? ['settings', 'health', 'today'],
    writeBack: false,
    rebase: false,
    entityId: () => undefined,
    optimistic: (input, cache) =>
      cache.setQuery<Settings>(queryKey('getSettings') as never, (old) => (old ? ({ ...old, [section]: { ...old[section], ...input.body!.value } } as Settings) : old)),
    toast: opts?.toast ? (res, input) => opts.toast!(res, input.body!.value as Record<string, unknown>) : undefined,
    onSuccess: (res, input) => {
      qc.setQueryData(queryKey('getSettings'), res.entity);
      setSavedAt(Date.now());
      const sent = Object.keys(input.body!.value);
      setTouched((t) => new Set([...t].filter((k) => !sent.includes(k as string))));
      opts?.onSaved?.(res, input.body!.value as Record<string, unknown>);
    },
  });

  const save = useCallback(
    async (extra?: { confirm?: boolean }) => {
      if (!server) return;
      const value = changedKeys(draft as Record<string, unknown>, serverRef as Record<string, unknown>, keys as never);
      if (!Object.keys(value).length) return;
      await m.mutateAsync({ params: { section }, body: { ifVersion: server.version, value, confirm: extra?.confirm } }).catch(() => undefined);
    },
    [draft, keys, m, section, server, serverRef],
  );
  const discard = useCallback(() => {
    setTouched(new Set());
    setDraft((d) => ({ ...d, ...Object.fromEntries(keys.map((k) => [k, serverRef[k]])) }));
  }, [keys, serverRef]);
  const set = useCallback(<P extends keyof Val<K>>(k: P, v: Val<K>[P]) => {
    setTouched((t) => (t.has(k) ? t : new Set([...t, k])));
    setDraft((d) => ({ ...d, [k]: v }));
  }, []);
  const changed = useCallback((k: keyof Val<K>) => !!server && !same(draft[k], serverRef[k]), [draft, server, serverRef]);
  // "Take theirs" on a 409 also drops your edits, so the server values can come in.
  const mutation = m.conflict ? { ...m, conflict: { ...m.conflict, takeTheirs: () => (setTouched(new Set()), m.conflict!.takeTheirs()) } } : m;

  return { server, draft, set, dirty, changed, save, discard, mutation, savedAt, loading: q.isLoading, error: q.error, saved: serverRef };
}

export type SectionForm<K extends SectionKey> = ReturnType<typeof useSectionForm<K>>;
type Mutation = ReturnType<typeof useOptimisticMutation<'patchSettings'>>;

// ── Layout ─────────────────────────────────────────────────────────────────────────────────

/** One section: a sticky header that says how it saves, then its blocks. `guide`: the header's Getting started anchor. */
export function Section({ id, title, meta, actions, jump, children, feedback, guide }: { id: SectionId | `${SectionId}-${string}`; title: string; meta?: ReactNode; actions?: ReactNode; jump?: ReactNode; feedback?: ReactNode; children: ReactNode; guide?: string }) {
  return (
    <section className={s.sec} data-section={id} aria-labelledby={`h-${id}`}>
      <header className={s.secHead} data-guide={guide}>
        <h2 className={s.secTitle} id={`h-${id}`}>
          {title}
        </h2>
        <div className={s.secActions}>{actions}</div>
        {meta ? <p className={s.secMeta}>{meta}</p> : null}
        {jump}
      </header>
      {feedback ? <div className={s.feedback}>{feedback}</div> : null}
      {children}
    </section>
  );
}

/** "All saved · Save" (grey until something changes) or "Unsaved changes · Discard · Save". */
export function SaveActions({
  dirty,
  onSave,
  onDiscard,
  mutation,
  savedAt,
  saveDisabled,
  saveLabel = 'Save',
  variant = 'primary',
  idle = 'All saved',
  testId,
  pending,
}: {
  dirty: boolean;
  onSave: () => void;
  onDiscard: () => void;
  mutation?: Mutation;
  savedAt?: number | null;
  saveDisabled?: boolean;
  saveLabel?: string;
  variant?: 'primary' | 'secondary';
  idle?: string;
  testId?: string;
  /** Saving without a patchSettings mutation (watches). */
  pending?: boolean;
}) {
  const busy = pending ?? mutation?.isPending ?? false;
  const recent = !!savedAt && Date.now() - savedAt < 60_000;
  const state = busy ? 'Saving…' : dirty ? 'Unsaved changes' : recent ? 'Saved just now ✓' : savedAt ? 'Saved ✓' : idle;
  return (
    <>
      {state ? (
        <span className={s.saveState} role="status" aria-live="polite">
          {state}
        </span>
      ) : null}
      {dirty ? (
        <Button variant="ghost" onClick={onDiscard} disabled={busy}>
          Discard
        </Button>
      ) : null}
      <Button variant={variant} disabled={!dirty || saveDisabled} loading={busy} onClick={onSave} data-testid={testId}>
        {saveLabel}
      </Button>
    </>
  );
}

/** Inline result of a save: the 409 "changed elsewhere" choice, or "Couldn't save" with the draft kept. */
export function SaveFeedback({ mutation, what = 'save' }: { mutation?: Mutation; what?: string }) {
  if (!mutation) return null;
  if (mutation.conflict) return <ChangedElsewhere fields={mutation.conflict.fields} onKeepMine={mutation.conflict.keepMine} onTakeTheirs={mutation.conflict.takeTheirs} />;
  if (!mutation.error) return null;
  return (
    <p role="alert" className="text-body text-danger-700">
      Couldn’t {what}: {mutation.error.message}. Your changes are kept.{' '}
      <button type="button" className={s.linkBtn} onClick={mutation.retry}>
        Retry
      </button>
    </p>
  );
}

export function Instant({ children = '✓ Changes apply instantly' }: { children?: ReactNode }) {
  return <span className={s.instant}>{children}</span>;
}

export function Block({ id, title, help, actions, feedback, children }: { id?: string; title?: string; help?: ReactNode; actions?: ReactNode; feedback?: ReactNode; children: ReactNode }) {
  const H = useContext(BlockHeadingLevel) === 2 ? 'h2' : 'h3';
  return (
    <div className={s.block} id={id}>
      {title || actions ? (
        <div className={s.blockHead}>
          {title ? <H>{title}</H> : null}
          {help ? <p>{help}</p> : null}
          {actions ? <div className={s.blockActs}>{actions}</div> : null}
        </div>
      ) : null}
      {feedback ? <div className={s.blockFeedback}>{feedback}</div> : null}
      <div className={s.rows}>{children}</div>
    </div>
  );
}

/** A label-left row: label and helper on the left (~300 px), the control (≤ 640 px) on the right. */
export function Row({
  label,
  help,
  htmlFor,
  labelId,
  top,
  edited,
  error,
  labelExtra,
  children,
  testId,
}: {
  label: ReactNode;
  help?: ReactNode;
  htmlFor?: string;
  labelId?: string;
  top?: boolean;
  edited?: boolean;
  error?: string | null;
  labelExtra?: ReactNode;
  children: ReactNode;
  testId?: string;
}) {
  // the helper (or the error that replaces it) describes the control: aria-describedby on the field the label names,
  // added here so every Row links it without each control passing ids (WCAG 1.3.1, 3.3.1)
  const descId = htmlFor ? `${htmlFor}-desc` : labelId ? `${labelId}-desc` : undefined;
  const described = !!descId && !!(error || help);
  useEffect(() => {
    if (!described || !descId) return;
    const field = htmlFor ? document.getElementById(htmlFor) : document.querySelector<HTMLElement>(`[aria-labelledby~="${labelId}"]`);
    if (!field) return;
    const tokens = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    if (!tokens.includes(descId)) field.setAttribute('aria-describedby', [...tokens, descId].join(' '));
    return () => {
      const left = (field.getAttribute('aria-describedby') ?? '').split(/\s+/).filter((t) => t && t !== descId);
      if (left.length) field.setAttribute('aria-describedby', left.join(' '));
      else field.removeAttribute('aria-describedby');
    };
  }, [described, descId, htmlFor, labelId]);
  return (
    <div className={cn(s.row, top && s.top, edited && s.rowEdited)} data-edited={edited ? 'true' : undefined} data-testid={testId}>
      <div>
        <div className={s.lblLine}>
          {htmlFor ? (
            <label htmlFor={htmlFor} className={s.label}>
              {label}
            </label>
          ) : (
            <span className={s.label} id={labelId}>
              {label}
            </span>
          )}
          {labelExtra}
        </div>
        {error ? (
          <p className={cn(s.help, s.helpErr)} role="alert" id={descId}>
            {error}
          </p>
        ) : help ? (
          <p className={s.help} id={descId}>
            {help}
          </p>
        ) : null}
      </div>
      <div className={s.ctrl}>{children}</div>
    </div>
  );
}

export { s as css };
