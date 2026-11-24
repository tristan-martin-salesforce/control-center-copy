'use client';
/**
 * One model for the whole Settings page. Drafts live here, not in the section components, so:
 * - switching sections keeps your edits ("Edits wait here while you look elsewhere");
 * - the effect pane reads the same draft the section is editing (Sending's steps follow the dry-run switch,
 *   Budgets' meter follows the soft budget, Priority policy's preview follows the weights).
 * Save models (UI-SPEC §8): explicit Save for Profile, Role & rules, Thresholds, Closing work, Sending, Budgets and Watches; one Save per block
 * for Agent behavior; Preview → Apply (versioned, with Undo) for the policy; instant for Display.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DISPLAY_TEXT_ATTR, type DisplayScheme, type DisplayTextSize, type PolicyPreview, type PolicyRule, type PolicyWeights, type PriorityPolicy, type Settings, type WatchSubscription } from '@/contract';
import { api, ApiError, queryKey } from '@/client/api';
import { useApi } from '@/client/hooks';
import { useOptimisticMutation } from '@/client/optimistic/useOptimisticMutation';
import { toast } from '@/client/toast';
import { usePrefs } from '@/components/shell/prefs';
import { canPreview, DEFAULT_THRESHOLDS, parseThresholds, policyChanges, same, THRESHOLDS_KEY, type Thresholds } from './derive';
import { useReportDirty, useSectionForm } from './form';
import { personaOf } from '@/personas';
import { carriedTaskRules, carryTaskRules, PERSONA_KEYS, withoutCarried } from './role';

const PROFILE_KEYS = ['name', 'role', 'timezone', 'workingHours', 'managerName'] as const;
const SENDING_KEYS = ['defaultMode', 'channels', 'dryRun', 'verifyReadback', 'undoWindowSec', 'autopilotAssetHosts'] as const;
const BUDGET_KEYS = ['softUsd', 'hardUsd', 'alertPct', 'today'] as const;
/** Settings ▸ Budgets ▸ Assistant: the chat's own limits (settings.chat), one explicit Save. */
const ASSISTANT_LIMIT_KEYS = ['dailyUsd', 'messageUsd', 'maxSteps', 'researchUsd'] as const;
const VOICE_KEYS = ['voice'] as const;
const AUTONOMY_KEYS = ['autonomy'] as const;
const WATCHED_KEYS = ['watchedSources'] as const;
const DRAFTING_KEYS = ['drafting'] as const;
/** SETTLE-1: Settings ▸ Closing work, one explicit Save (like Budgets). */
const CLOSING_KEYS = ['enabled', 'reasons', 'strictness', 'askFirstExternalCommitments', 'askFirstPeople', 'askFirstChannels', 'rules', 'reopenOnFollowUp', 'oldAskDays', 'strongerModelForUnclear', 'strongerModelUsdPerDay', 'tellMeWhatClosed'] as const;

// ── Priority policy ────────────────────────────────────────────────────────────────────────

export interface PolicyDraft {
  weights: PolicyWeights;
  rules: PolicyRule[];
}

function usePolicyModel() {
  const settings = useApi('getSettings');
  const policy = settings.data?.policy as PriorityPolicy | undefined;
  const [draft, setDraft] = useState<PolicyDraft | null>(null);
  const [seen, setSeen] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ key: string; draft: PolicyDraft; data: PolicyPreview; at: number } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [lastApply, setLastApply] = useState<{ auditId: string; version: number } | null>(null);

  // Adopt the saved policy when it first loads or its version changes (apply, revert, undo, or a chat change).
  if (policy && seen !== policy.version) {
    setSeen(policy.version);
    setDraft({ weights: policy.weights, rules: policy.rules });
    setPreview(null);
  }
  const saved = useMemo<PolicyDraft | null>(() => (policy ? { weights: policy.weights, rules: policy.rules } : null), [policy]);
  const dirty = !!saved && !!draft && canPreview(draft.weights, draft.rules, saved.weights, saved.rules);
  useReportDirty('policy:Priority policy', 'Priority policy', dirty);
  const key = useMemo(() => JSON.stringify(draft), [draft]);
  /** The preview of exactly this draft (Apply needs it). */
  const fresh = preview && preview.key === key ? preview : null;
  const changes = useMemo(() => (saved && draft ? policyChanges(saved, draft) : []), [saved, draft]);

  const previewM = useMutation<PolicyPreview, ApiError, PolicyDraft>({
    mutationFn: (d) => api('previewPolicy', { body: { weights: d.weights, rules: d.rules } }),
    onSuccess: (data, d) => setPreview({ key: JSON.stringify(d), draft: d, data, at: Date.now() }),
  });
  const topics = ['settings', 'policy', 'today', 'items', 'item'];
  const apply = useOptimisticMutation({
    route: 'applyPolicy',
    topics,
    rebase: false,
    writeBack: false,
    entityId: () => policy?.id,
    toast: (res) => ({ key: 'policy-apply', title: `Policy v${res.entity.version} applied`, body: res.receipt?.summary ?? 'Today and Home re-ranked.' }),
    onSuccess: (res) => {
      if (res.auditId) setLastApply({ auditId: res.auditId, version: res.entity.version });
    },
  });
  const revert = useOptimisticMutation({
    route: 'revertPolicy',
    topics,
    rebase: false,
    writeBack: false,
    entityId: () => policy?.id,
    toast: (res) => ({ key: 'policy-apply', title: `Reverted: now v${res.entity.version}`, body: res.receipt?.summary }),
    onSuccess: (res) => {
      if (res.auditId) setLastApply({ auditId: res.auditId, version: res.entity.version });
    },
  });
  const undo = useOptimisticMutation({
    route: 'undoAudit',
    topics,
    rebase: false,
    writeBack: false,
    entityId: () => undefined,
    toast: () => ({ key: 'policy-apply', title: 'Undone: the policy is back to the previous version' }),
    onSuccess: () => setLastApply(null),
  });

  const runPreview = useCallback(() => {
    if (draft && dirty) previewM.mutate(draft);
  }, [draft, dirty, previewM]);
  const runApply = useCallback(() => {
    if (!policy || !draft || !fresh) return;
    const note = changes.length ? `Edited in Settings: ${changes.join(', ')}` : 'Edited in Settings';
    apply.mutate({ body: { ifVersion: policy.version, weights: draft.weights, rules: draft.rules, note: note.slice(0, 280) } });
  }, [apply, changes, draft, fresh, policy]);
  const discard = useCallback(() => {
    if (saved) setDraft(saved);
    setPreview(null);
    previewM.reset();
  }, [previewM, saved]);

  return {
    policy,
    saved,
    draft,
    setDraft,
    dirty,
    changes,
    preview,
    fresh,
    stale: dirty && !!preview && !fresh,
    previewM,
    runPreview,
    apply,
    runApply,
    revert,
    undo,
    lastApply: lastApply && policy && lastApply.version === policy.version ? lastApply : null,
    discard,
    selected,
    setSelected,
  };
}

// ── Thresholds (engine settings; kept on this machine until the contract has a section) ───

function useThresholds() {
  const [saved, setSaved] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [draft, setDraft] = useState<Thresholds>(DEFAULT_THRESHOLDS);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  useEffect(() => {
    const t = parseThresholds(localStorage.getItem(THRESHOLDS_KEY));
    setSaved(t);
    setDraft(t);
  }, []);
  const dirty = !same(saved, draft);
  useReportDirty('thresholds:Thresholds', 'Thresholds', dirty);
  const save = useCallback(() => {
    try {
      localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(draft));
    } catch {
      /* private mode: still applies for this session */
    }
    const before = saved;
    setSaved(draft);
    setSavedAt(Date.now());
    toast({ key: 'thresholds', title: 'Thresholds saved', body: 'They apply to the next evaluation.', undo: { run: () => (localStorage.setItem(THRESHOLDS_KEY, JSON.stringify(before)), setSaved(before), setDraft(before)) } });
  }, [draft, saved]);
  return { saved, draft, setDraft, dirty, save, discard: () => setDraft(saved), savedAt };
}

// ── Watches (explicit Save: a watch changes scanning scope and cost) ──────────────────────

export type WatchEdit = Partial<Pick<WatchSubscription, 'enabled' | 'cadence' | 'style'>>;
export interface WatchAdd {
  tmpId: string;
  targetKind: WatchSubscription['targetKind'];
  target: string;
  label: string;
  cadence: WatchSubscription['cadence'];
  style: WatchSubscription['style'];
}

function useWatchesModel() {
  const qc = useQueryClient();
  const q = useApi('listWatches');
  const server = useMemo(() => q.data?.watches ?? [], [q.data]);
  const [edits, setEdits] = useState<Record<string, WatchEdit>>({});
  const [adds, setAdds] = useState<WatchAdd[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<{ message: string; conflict: boolean } | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // An edit equal to the server value is no edit.
  const effective = useMemo(() => {
    const out: Record<string, WatchEdit> = {};
    for (const w of server) {
      const e = edits[w.id];
      if (!e) continue;
      const diff: WatchEdit = {};
      for (const k of Object.keys(e) as (keyof WatchEdit)[]) if (e[k] !== undefined && e[k] !== w[k]) (diff as Record<string, unknown>)[k] = e[k];
      if (Object.keys(diff).length) out[w.id] = diff;
    }
    return out;
  }, [edits, server]);
  const dirty = Object.keys(effective).length > 0 || adds.length > 0;
  useReportDirty('watches:Watches', 'Watches', dirty);
  const rows = useMemo(() => server.map((w) => ({ ...w, ...edits[w.id] })), [server, edits]);

  const edit = useCallback((id: string, patch: WatchEdit) => setEdits((e) => ({ ...e, [id]: { ...e[id], ...patch } })), []);
  const add = useCallback((a: Omit<WatchAdd, 'tmpId'>) => setAdds((x) => [...x, { ...a, tmpId: `new_${Date.now().toString(36)}_${x.length}` }]), []);
  const removeAdd = useCallback((tmpId: string) => setAdds((x) => x.filter((a) => a.tmpId !== tmpId)), []);
  const discard = useCallback(() => {
    setEdits({});
    setAdds([]);
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (!dirty || saving) return;
    setSaving(true);
    setError(null);
    const key = queryKey('listWatches');
    const snapshot = qc.getQueryData(key);
    // Optimistic: the list shows the saved state at once; any failure rolls back and keeps the draft.
    qc.setQueryData(key, (old: { watches: WatchSubscription[] } | undefined) => (old ? { watches: old.watches.map((w) => ({ ...w, ...effective[w.id] })) } : old));
    const audits: string[] = [];
    const doneEdits: string[] = [];
    const doneAdds: string[] = [];
    try {
      for (const [id, patch] of Object.entries(effective)) {
        const w = server.find((x) => x.id === id)!;
        const r = await api('patchWatch', { params: { id }, body: { ifVersion: w.version, patch } });
        if (r.auditId) audits.push(r.auditId);
        doneEdits.push(id);
      }
      for (const a of adds) {
        const r = await api('createWatch', { body: { targetKind: a.targetKind, target: a.target, label: a.label, cadence: a.cadence, style: a.style } });
        if (r.auditId) audits.push(r.auditId);
        doneAdds.push(a.tmpId);
      }
      setEdits({});
      setAdds([]);
      setSavedAt(Date.now());
      const n = doneEdits.length + doneAdds.length;
      toast({ key: 'watches', title: n === 1 ? 'Watch saved' : `${n} watch changes saved`, body: 'Briefs follow the new scope from the next run.', undo: audits.length === 1 ? { auditId: audits[0]! } : undefined });
    } catch (e) {
      qc.setQueryData(key, snapshot);
      const err = e instanceof ApiError ? e : null;
      setEdits((x) => Object.fromEntries(Object.entries(x).filter(([id]) => !doneEdits.includes(id))));
      setAdds((x) => x.filter((a) => !doneAdds.includes(a.tmpId)));
      setError({ message: err?.code === 'conflict' ? 'A watch changed elsewhere. Reload to see the latest, then save again.' : (err?.message ?? String(e)), conflict: err?.code === 'conflict' });
    } finally {
      setSaving(false);
      for (const t of ['watches', 'briefs']) void qc.invalidateQueries({ queryKey: [t] });
    }
  }, [adds, dirty, effective, qc, saving, server]);

  return { query: q, server, rows, edits: effective, adds, edit, add, removeAdd, dirty, save, discard, saving, error, savedAt, reload: () => void q.refetch() };
}

// ── Role & rules (D-55: explicit Save, with Undo; a persona switch reseeds the starter policy server-side) ─────

/** Agent behavior entries carried into this draft as custom rules (`ids`), with the texts they came from. */
export interface CarriedRules {
  ids: string[];
  texts: string[];
}

function usePersonaModel() {
  const qc = useQueryClient();
  const settings = useApi('getSettings');
  const [carried, setCarried] = useState<CarriedRules | null>(null);
  /** The carry-over runs once per visit to Settings (the first time Role & rules opens). */
  const carryChecked = useRef(false);

  const form = useSectionForm('persona', PERSONA_KEYS, 'Role & rules', 'role', {
    // a switch changes the policy (new version), Home's Log & fix rows, Time and what the scanners read
    topics: ['settings', 'health', 'today', 'home', 'policy', 'items', 'time'],
    toast: (res, sent) => {
      const p = personaOf(res.entity);
      return 'id' in sent
        ? { key: 'persona-save', title: `Role saved: ${p.levelLabel}`, body: 'Your priority policy starts a new version from this role’s starter, and the next scans follow the new role.' }
        : { key: 'persona-save', title: 'Role & rules saved', body: 'The next scans, Home and the Assistant follow them.' };
    },
    onSaved: (res) => {
      const c = carried;
      if (!c) return;
      setCarried(null);
      // Take the carried entries out of Agent behavior so they never carry twice (even if this fails they don't:
      // they are custom rules now, and carriedTaskRules skips texts already there).
      const ab = res.entity.agentBehavior;
      const next = withoutCarried(ab.taskCapture, c.texts);
      if (next.length === ab.taskCapture.length) return;
      const personaAudit = res.auditId;
      void api('patchSettings', { params: { section: 'agentBehavior' }, body: { ifVersion: ab.version, value: { taskCapture: next } } })
        .then((r) => {
          qc.setQueryData(queryKey('getSettings'), r.entity);
          const n = c.ids.length;
          const abAudit = r.auditId;
          // One Undo for both writes: the task list comes back to Agent behavior, the rules leave Role & rules.
          const both = async () => {
            await api('undoAudit', { params: { id: abAudit! }, body: {} });
            await api('undoAudit', { params: { id: personaAudit! }, body: {} });
          };
          const undo = personaAudit && abAudit ? { run: both } : personaAudit ? { auditId: personaAudit } : undefined;
          toast({ key: 'persona-save', title: 'Role & rules saved', body: `${n === 1 ? '1 rule' : `${n} rules`} from Autonomy now live${n === 1 ? 's' : ''} here.`, undo });
        })
        .catch(() => undefined);
    },
  });

  /** Carry Agent behavior's own task entries into the draft as custom rules (once; Role & rules calls it on open). */
  const carry = useCallback(() => {
    const st = settings.data;
    if (carryChecked.current || !form.server || !st) return;
    carryChecked.current = true;
    const texts = carriedTaskRules(st.agentBehavior.taskCapture, form.draft, personaOf({ persona: form.draft, profile: st.profile }));
    if (!texts.length) return;
    const r = carryTaskRules(form.draft, texts);
    if (!r.ids.length) return;
    form.set('customRules', r.draft.customRules);
    setCarried({ ids: r.ids, texts: r.texts });
  }, [form, settings.data]);

  const discard = useCallback(() => {
    form.discard();
    setCarried(null);
  }, [form]);

  return { ...form, discard, carry, carried };
}

// ── Display (instant) ──────────────────────────────────────────────────────────────────────

type PrefsLike = ReturnType<typeof usePrefs> & { scheme?: unknown; textSize?: unknown };

const asScheme = (v: unknown): DisplayScheme | null => (v === 'dark' || v === 'light' || v === 'system' ? v : null);
function asTextSize(v: unknown): DisplayTextSize | null {
  if (v === 15 || v === 16 || v === 18) return v;
  const fromAttr = Object.entries(DISPLAY_TEXT_ATTR).find(([, a]) => a === v)?.[0];
  return fromAttr ? (Number(fromAttr) as DisplayTextSize) : null;
}

/**
 * Display prefs through the shell's usePrefs(): it owns <html data-theme / data-text / data-density>, the boot script
 * and the server copy of scheme, density and text size. This route only saves what the shell doesn't (shortcutsEnabled).
 */
function useDisplayModel() {
  const prefs = usePrefs() as PrefsLike;
  const settings = useApi('getSettings');
  const server = settings.data?.display;
  const scheme: DisplayScheme = asScheme(prefs.scheme) ?? server?.scheme ?? 'dark';
  const textSize: DisplayTextSize = asTextSize(prefs.textSize) ?? server?.textSize ?? 16;
  const density = prefs.density ?? server?.density ?? 'comfortable';
  const persist = useOptimisticMutation({
    route: 'patchSettings',
    topics: ['settings'],
    writeBack: false,
    // Display prefs are last-write-wins: re-send on the server's version. A 409 on PATCH /settings/:section carries the
    // whole Settings as `current`, so the version to rebase on is current.display.version.
    rebase: ({ input, current }) => {
      const v = Number((current as unknown as Partial<Settings>).display?.version ?? current.version);
      return Number.isFinite(v) ? { ...input, body: { ...input.body!, ifVersion: v } } : null;
    },
    entityId: () => undefined,
    optimistic: (input, cache) => cache.setQuery<Settings>(queryKey('getSettings') as never, (old) => (old ? ({ ...old, display: { ...old.display, ...input.body!.value } } as Settings) : old)),
    onError: () => toast({ key: 'display-save', tone: 'warning', title: "Couldn't save display settings", body: 'They apply on this Mac; the server copy is unchanged.', action: { label: 'Retry', onClick: () => persist.retry() } }),
  });

  const queue = useRef<Record<string, unknown> | null>(null);
  const inflight = useRef(false);
  const lastVersion = useRef(0);
  const latest = useRef({ persist, version: server?.version ?? 0 });
  latest.current = { persist, version: server?.version ?? 0 };
  const flush = useCallback(() => {
    if (inflight.current || !queue.current || !latest.current.version) return;
    const value = queue.current;
    queue.current = null;
    inflight.current = true;
    const ifVersion = Math.max(lastVersion.current, latest.current.version);
    latest.current.persist
      .mutateAsync({ params: { section: 'display' }, body: { ifVersion, value } })
      .then((res) => {
        lastVersion.current = res.entity.display.version;
      })
      .catch(() => undefined)
      .finally(() => {
        inflight.current = false;
        flush();
      });
  }, []);
  useEffect(() => flush(), [flush, server?.version]);

  const set = useCallback(
    (patch: { scheme?: DisplayScheme; textSize?: DisplayTextSize; density?: 'compact' | 'comfortable'; shortcutsEnabled?: boolean }) => {
      const local: Record<string, unknown> = {};
      if (patch.scheme) local.scheme = patch.scheme;
      if (patch.density) local.density = patch.density;
      // Send the text size in the shape the shell keeps (px today; 'sm' | 'md' | 'lg' if it stores the attribute).
      if (patch.textSize) local.textSize = typeof prefs.textSize === 'string' ? DISPLAY_TEXT_ATTR[patch.textSize] : patch.textSize;
      if (Object.keys(local).length) prefs.set(local as Parameters<typeof prefs.set>[0]);
      // scheme / density / text size reach settings.display through the shell's own queue; sending them here too
      // made two writers race on the same version.
      const value: Record<string, unknown> = {};
      if (patch.shortcutsEnabled !== undefined) value.shortcutsEnabled = patch.shortcutsEnabled;
      if (!Object.keys(value).length) return;
      // One request at a time: rapid clicks coalesce into the next PATCH, sent on the version the last one returned.
      queue.current = { ...queue.current, ...value };
      flush();
    },
    [flush, prefs],
  );

  return { scheme, textSize, density, shortcutsEnabled: server?.shortcutsEnabled ?? true, ready: !!server, set, persist };
}

// ── The model ──────────────────────────────────────────────────────────────────────────────

function useModel() {
  const profile = useSectionForm('profile', PROFILE_KEYS, 'Profile & hours', 'profile');
  const role = usePersonaModel();
  const sending = useSectionForm('sending', SENDING_KEYS, 'Sending', 'sending');
  const budgets = useSectionForm('budgets', BUDGET_KEYS, 'Budgets', 'budgets');
  const assistantLimits = useSectionForm('chat', ASSISTANT_LIMIT_KEYS, 'Assistant limits', 'budgets');
  const closing = useSectionForm('closing', CLOSING_KEYS, 'Closing work', 'closing');
  const voice = useSectionForm('agentBehavior', VOICE_KEYS, 'Voice', 'agent');
  const autonomy = useSectionForm('agentBehavior', AUTONOMY_KEYS, 'Autonomy', 'agent');
  const watched = useSectionForm('agentBehavior', WATCHED_KEYS, 'Watched sources', 'agent');
  const drafting = useSectionForm('agentBehavior', DRAFTING_KEYS, 'Drafting style', 'agent');
  const thresholds = useThresholds();
  const policy = usePolicyModel();
  const watches = useWatchesModel();
  const display = useDisplayModel();
  return { profile, role, sending, budgets, assistantLimits, closing, agent: { voice, autonomy, watched, drafting }, thresholds, policy, watches, display };
}

export type SettingsModel = ReturnType<typeof useModel>;
const ModelCtx = createContext<SettingsModel | null>(null);

export function SettingsModelProvider({ children }: { children: ReactNode }) {
  const model = useModel();
  return <ModelCtx.Provider value={model}>{children}</ModelCtx.Provider>;
}

export function useSettingsModel(): SettingsModel {
  const m = useContext(ModelCtx);
  if (!m) throw new Error('useSettingsModel outside SettingsModelProvider');
  return m;
}
