'use client';
/**
 * /onboarding (B-079): six steps in the Settings three-pane pattern (step list · the step · what it changes), with
 * Back / Next in the footer. The first, the role (D-55), picks the persona and level the rest follows. Every edit
 * autosaves to the server draft (0.7 s debounce; saves run one at a time), so a reload resumes on the same step with
 * the same values. Moving forward runs the step's checks here and on the server. "Start first scan" bootstraps the
 * user (db) and lands on Home.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ONBOARDING_STEPS, type IdentityKind, type OnboardingHistory, type OnboardingIssue, type OnboardingPersonaDraft, type OnboardingPriorities, type OnboardingSourceId, type OnboardingState, type OnboardingStep, type OnboardingYouDraft, type PersonaId, type PersonaLevel, type SaveOnboardingStepRequest } from '@/contract';
import { api, ApiError, queryKey } from '@/client/api';
import { toast } from '@/client/toast/store';
import { Button } from '@/ui';
import { BlockHeadingLevel } from '@/components/settings/heading-level';
import { activatedLabels, fieldErrors, localIssues, nextStep, personaChoice, prevStep, prioritiesFor, profileRole, starterOf, STEP_META, stepIndex, stepSummary, templateOf, toggleSource } from './derive';
import { writeOnboarded } from './flag';
import { useOnboardingState } from './OnboardingGate';
import { OnboardingSkeleton, OnboardingTopBar } from './OnboardingSkeleton';
import { HistoryAside, HistoryStep, PrioritiesAside, PrioritiesStep, ReviewAside, ReviewStep, RoleAside, RoleStep, SourcesAside, SourcesStep, StepHead, useOnboardingSources, YouAside, YouStep, type ActivationProps, type IdentityProps } from './steps';
import o from './onboarding.module.css';

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

function issuesFromError(e: unknown): { step: OnboardingStep; issues: OnboardingIssue[] } | null {
  if (!(e instanceof ApiError) || e.code !== 'validation') return null;
  const d = e.details as { step?: OnboardingStep; issues?: OnboardingIssue[] } | undefined;
  return d?.step ? { step: d.step, issues: d.issues ?? [] } : null;
}

function Wizard({ initial }: { initial: OnboardingState }) {
  const qc = useQueryClient();
  const router = useRouter();
  const live = useOnboardingState().data ?? initial;
  const state = live.status === 'complete' ? initial : live;
  const packs = state.rolePacks;

  const [step, setStep] = useState<OnboardingStep>(initial.step);
  const [reached, setReached] = useState<OnboardingStep>(initial.reached);
  const [you, setYou] = useState<OnboardingYouDraft>(initial.draft.you);
  const [persona, setPersona] = useState<OnboardingPersonaDraft>(initial.draft.persona);
  const [priorities, setPriorities] = useState<OnboardingPriorities>(() => prioritiesFor(initial.draft, packs));
  // a cleared budget is NaN here (null on the wire), so the check asks for an amount instead of using the default
  const savedBudget = initial.draft.history.budgetUsd;
  const [history, setHistory] = useState<OnboardingHistory>({ lookbackDays: initial.draft.history.lookbackDays ?? initial.cost.defaultDays, budgetUsd: savedBudget === undefined ? initial.cost.defaultBudgetUsd : (savedBudget ?? Number.NaN) });
  const [shown, setShown] = useState<OnboardingIssue[]>([]);
  const [save, setSave] = useState<SaveState>(initial.updatedAt ? 'saved' : 'idle');
  const [busy, setBusy] = useState<'move' | 'finish' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const savedKey = useRef<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sources = useOnboardingSources();

  // priorities follow the role: the new template's starter unless your edits were made for it
  const choice = useMemo(() => personaChoice(persona, you), [persona, you]);
  const tpl = templateOf(choice);
  const pri = priorities.basedOn === tpl ? priorities : starterOf(packs[tpl]);
  const overrides = useMemo(() => ({ features: persona.features, connectors: persona.connectors }), [persona.features, persona.connectors]);
  const activated = useMemo(() => activatedLabels(sources.data?.sources, choice, overrides), [sources.data, choice, overrides]);
  const local = useMemo(() => ({ role: choice, you, priorities: pri, history, activated }), [choice, you, pri, history, activated]);
  const ids = useMemo(() => ({ slackUserId: you.slackUserId ?? '', org62UserId: you.org62UserId ?? '' }), [you.slackUserId, you.org62UserId]);
  const roleValue = useMemo(() => (persona.id ? { id: persona.id, level: choice.level } : {}), [persona.id, choice.level]);
  const valueOf = useCallback(
    (s: OnboardingStep): SaveOnboardingStepRequest['value'] =>
      s === 'role' ? roleValue : s === 'you' ? you : s === 'priorities' ? pri : s === 'history' ? history : s === 'sources' ? { ...ids, ...overrides } : {},
    [roleValue, you, pri, history, ids, overrides],
  );
  const pickRole = (v: { id: PersonaId; level: PersonaLevel }) => {
    // another persona: your activations were relative to the old preset (the server drops them too)
    setPersona((p) => (p.id === v.id ? { ...p, level: v.level } : { id: v.id, level: v.level, features: {}, connectors: {} }));
    setYou((y) => ({ ...y, role: profileRole(v) }));
    setShown((s) => s.filter((i) => i.step !== 'role'));
  };
  const activation: ActivationProps = {
    role: choice,
    overrides,
    onToggle: (id: OnboardingSourceId, on: boolean) => setPersona((p) => ({ ...p, ...toggleSource(choice, { features: p.features, connectors: p.connectors }, id, on) })),
  };

  /** Saves run one at a time, in order (an autosave never lands after the Next that followed it). */
  const send = useCallback(
    (body: SaveOnboardingStepRequest): Promise<OnboardingState> => {
      savedKey.current = JSON.stringify(body.value);
      const p = chain.current.then(() => api('saveOnboardingStep', { body }));
      chain.current = p.catch(() => undefined);
      setSave('saving');
      return p.then(
        (st) => {
          qc.setQueryData(queryKey('getOnboarding'), st);
          setSave('saved');
          return st;
        },
        (e: unknown) => {
          setSave(issuesFromError(e) ? 'saved' : 'error');
          throw e;
        },
      );
    },
    [qc],
  );

  // autosave the current step while you type (only what changed since the last save)
  const valueKey = JSON.stringify(valueOf(step));
  savedKey.current ??= valueKey;
  useEffect(() => {
    if (valueKey === savedKey.current) return;
    if (step === 'review') return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void send({ step, value: valueOf(step), goTo: step } as SaveOnboardingStepRequest).catch(() => undefined);
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // valueKey stands for the value; step changes are saved by go()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueKey]);

  const show = (target: OnboardingStep) => {
    savedKey.current = JSON.stringify(valueOf(target));
    setStep(target);
    setReached((r) => (stepIndex(target) > stepIndex(r) ? target : r));
    scrollRef.current?.scrollTo({ top: 0 });
    requestAnimationFrame(() => headingRef.current?.focus({ preventScroll: true }));
  };

  const go = async (target: OnboardingStep) => {
    if (target === step || busy) return;
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    if (stepIndex(target) > stepIndex(step)) {
      const li = localIssues(step, local);
      if (li.length) {
        setShown(li);
        return;
      }
    }
    setBusy('move');
    try {
      const st = await send({ step, value: valueOf(step), goTo: target } as SaveOnboardingStepRequest);
      setShown([]);
      show(st.step);
    } catch (e) {
      const blocked = issuesFromError(e);
      if (blocked) {
        setShown(blocked.issues);
        // keep this step's edits, then show the step that needs attention
        await send({ step, value: valueOf(step), goTo: step } as SaveOnboardingStepRequest).catch(() => undefined);
        if (blocked.step !== step) show(blocked.step);
      } else setError(`Couldn’t save: ${(e as Error).message}. Your answers are kept here; try again.`);
    } finally {
      setBusy(null);
    }
  };

  const finish = async () => {
    if (busy) return;
    if (timer.current) clearTimeout(timer.current);
    setError(null);
    setBusy('finish');
    try {
      await send({ step: 'review', value: {}, goTo: 'review' });
      const r = await api('completeOnboarding', { body: {} });
      qc.setQueryData(queryKey('getOnboarding'), r.state);
      writeOnboarded(r.state.mode);
      void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'onboarding' });
      toast({ key: 'onboarding:done', title: 'You’re set up', body: r.firstScan.message, tone: 'success', durationMs: 10_000 });
      router.replace(r.redirect);
    } catch (e) {
      const blocked = issuesFromError(e);
      if (blocked) {
        setShown(blocked.issues);
        show(blocked.step);
      } else setError(`Couldn’t finish: ${(e as Error).message}. Nothing is lost; try again.`);
      setBusy(null);
    }
  };

  const refreshSources = async () => {
    setRefreshing(true);
    try {
      const d = await api('getOnboardingSources', { query: { refresh: '1' } });
      qc.setQueryData(queryKey('getOnboardingSources', { query: { refresh: '0' } }), d);
    } catch {
      void sources.refetch();
    } finally {
      setRefreshing(false);
    }
  };

  // ---- Slack / Org62 ids: read from a connected source (read-only, ~a cent each), always editable, never blocking
  const [detecting, setDetecting] = useState<ReadonlySet<IdentityKind>>(new Set());
  const detect = useCallback(
    async (kinds: IdentityKind[]) => {
      const want = kinds.filter((k) => !detecting.has(k));
      if (!want.length) return;
      setDetecting((d) => new Set([...d, ...want]));
      try {
        // outside the save queue: a lookup takes seconds and must never hold up Back / Next
        const st = await api('saveOnboardingStep', { body: { step: 'sources', value: { detect: want } } });
        qc.setQueryData(queryKey('getOnboarding'), st);
        setYou((y) => {
          let next = y;
          for (const k of want) {
            const det = st.draft.identities[k];
            const field = k === 'slack' ? 'slackUserId' : 'org62UserId';
            if (det?.status === 'found' && det.id && !next[field]?.trim()) next = { ...next, [field]: det.id };
          }
          return next;
        });
      } catch {
        /* the row keeps its hint; "Detect again" retries */
      } finally {
        setDetecting((d) => new Set([...d].filter((k) => !want.includes(k))));
      }
    },
    [detecting, qc],
  );
  // once per connected source with an empty field and no earlier lookup
  const autoTried = useRef(new Set<IdentityKind>());
  useEffect(() => {
    if (step !== 'sources' || state.detection === 'off' || !sources.data) return;
    const kinds = (['slack', 'org62'] as const).filter((k) => {
      const connected = sources.data!.sources.find((x) => x.id === k)?.state === 'ok';
      const field = k === 'slack' ? 'slackUserId' : 'org62UserId';
      return connected && !autoTried.current.has(k) && !state.draft.identities[k] && !you[field]?.trim();
    });
    if (!kinds.length) return;
    for (const k of kinds) autoTried.current.add(k);
    void detect(kinds);
  }, [step, sources.data, state.detection, state.draft.identities, you, detect]);
  const identity: IdentityProps = {
    ids,
    onIds: (v) => setYou((y) => ({ ...y, slackUserId: v.slackUserId, org62UserId: v.org62UserId })),
    identities: state.draft.identities,
    detecting,
    onDetect: (k) => void detect(k),
    detection: state.detection,
    errors: fieldErrors(shown, 'sources'),
    persona: choice.id,
  };

  // Enter in a field moves on (the rules table's "add a rule" field has its own form and keeps its Enter)
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const t = e.target as HTMLInputElement;
    if (e.key !== 'Enter' || e.defaultPrevented || t.tagName !== 'INPUT' || t.form || e.nativeEvent.isComposing) return;
    e.preventDefault();
    const n = nextStep(step);
    if (n) void go(n);
  };

  const errors = fieldErrors(shown, step);
  const prev = prevStep(step);
  const next = nextStep(step);
  const pack = packs[tpl];
  const saveText = save === 'saving' ? 'Saving…' : save === 'saved' ? 'Saved · a reload picks up here' : save === 'error' ? 'Not saved yet' : 'Your answers save as you go';

  return (
    <div className={o.root} data-testid="onboarding-page" data-step={step}>
      <OnboardingTopBar
        step={`Step ${stepIndex(step) + 1} of ${ONBOARDING_STEPS.length}`}
        right={
          <span role="status" aria-live="polite" data-testid="onboarding-save-state">
            {state.mode === 'mock' ? 'Mock mode · ' : ''}
            {saveText}
          </span>
        }
      />
      <div className={o.grid}>
        <nav className={o.nav} aria-label="Setup steps">
          {ONBOARDING_STEPS.map((s, i) => {
            const open = stepIndex(s) <= stepIndex(reached);
            const done = stepIndex(s) < stepIndex(reached) && s !== step && !localIssues(s, local).length;
            return (
              <button key={s} type="button" className={o.stepItem} aria-current={s === step ? 'step' : undefined} data-done={done ? 'true' : undefined} disabled={!open} onClick={() => void go(s)} data-testid={`step-${s}`}>
                <span className={o.stepNum} aria-hidden>
                  {done ? '✓' : i + 1}
                </span>
                <span className={o.stepText}>
                  <span className={o.stepLabel}>
                    {STEP_META[s].label}
                    {done ? <span className="sr-only"> (done)</span> : null}
                  </span>
                  <span className={o.stepSum}>{open ? stepSummary(s, state, local) : ' '}</span>
                </span>
              </button>
            );
          })}
          <div className={o.navFoot}>
            <span>Back always works.</span>
            <span>Everything here can change later in Settings.</span>
          </div>
        </nav>

        <main className={o.main} onKeyDown={onKeyDown} data-testid="onboarding-main">
          <div className={o.scroll} ref={scrollRef}>
            <section className={o.sec} aria-labelledby="onboarding-step-title">
              <StepHead
                step={step}
                headingRef={headingRef}
                actions={
                  step === 'priorities' && JSON.stringify(pri) !== JSON.stringify(starterOf(pack)) ? (
                    <Button type="button" variant="ghost" onClick={() => setPriorities(starterOf(pack))}>
                      Reset to the {pack.name} starter
                    </Button>
                  ) : null
                }
              />
              {/* the step's h1 is right above: settings Blocks inside a step title with h2 */}
              <BlockHeadingLevel.Provider value={2}>
                {step === 'role' ? <RoleStep value={choice} onChange={pickRole} errors={errors} /> : null}
                {step === 'you' ? <YouStep value={you} onChange={setYou} errors={errors} locked={state.locked} /> : null}
                {step === 'priorities' ? <PrioritiesStep value={pri} pack={pack} onChange={setPriorities} errors={errors} /> : null}
                {step === 'sources' ? <SourcesStep query={sources} onRefresh={() => void refreshSources()} refreshing={refreshing} mode={state.mode} identity={identity} activation={activation} /> : null}
                {step === 'history' ? <HistoryStep value={history} onChange={setHistory} cost={state.cost} errors={errors} /> : null}
                {step === 'review' ? <ReviewStep role={choice} overrides={overrides} you={you} priorities={pri} pack={pack} history={history} cost={state.cost} sources={sources.data} mode={state.mode} onEdit={(s) => void go(s)} /> : null}
              </BlockHeadingLevel.Provider>
            </section>
          </div>
          <footer className={o.foot}>
            {prev ? (
              <Button type="button" variant="secondary" onClick={() => void go(prev)} disabled={!!busy} data-testid="onboarding-back">
                Back
              </Button>
            ) : null}
            <span className={error ? o.errLine : o.footState} role={error ? 'alert' : undefined}>
              {error ?? (shown.some((i) => i.step === step) ? 'Fix the highlighted fields to continue.' : '')}
            </span>
            <div className={o.footRight}>
              {next ? (
                <Button type="button" variant="primary" loading={busy === 'move'} disabled={!!busy} onClick={() => void go(next)} data-testid="onboarding-next">
                  Next: {STEP_META[next].label}
                </Button>
              ) : (
                <Button type="button" variant="primary" loading={busy === 'finish'} disabled={!!busy} onClick={() => void finish()} data-testid="onboarding-start">
                  Start first scan
                </Button>
              )}
            </div>
          </footer>
        </main>

        <aside className={o.aside} aria-label="What this changes" data-testid="onboarding-aside">
          {step === 'role' ? <RoleAside value={choice} /> : null}
          {step === 'you' ? <YouAside /> : null}
          {step === 'priorities' ? <PrioritiesAside value={pri} pack={pack} /> : null}
          {step === 'sources' ? <SourcesAside /> : null}
          {step === 'history' ? <HistoryAside value={history} cost={state.cost} /> : null}
          {step === 'review' ? <ReviewAside /> : null}
        </aside>
      </div>
    </div>
  );
}

function SetUp({ state }: { state: OnboardingState }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const cli = state.reason === 'cli';
  const restart = async () => {
    setBusy(true);
    try {
      const st = await api('saveOnboardingStep', { body: { step: 'you', value: {}, goTo: 'you', restart: true } });
      qc.setQueryData(queryKey('getOnboarding'), st);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={o.root} data-testid="onboarding-done">
      <OnboardingTopBar />
      <main className={o.done}>
        <div className={o.doneCard}>
          <h1>{cli ? 'This database is already set up' : 'You’re set up'}</h1>
          <p>{cli ? 'It was set up with npm run setup. Your choices live in Settings.' : (state.firstScan?.message ?? 'Your choices are saved. Change them any time in Settings.')}</p>
          <div className={o.doneActs}>
            <Button variant="primary" onClick={() => (window.location.href = '/')}>
              Go to Home
            </Button>
            <Button variant="secondary" onClick={() => (window.location.href = '/settings')}>
              Open Settings
            </Button>
            {state.mode === 'mock' ? (
              <Button variant="ghost" loading={busy} onClick={() => void restart()}>
                Run setup again (mock)
              </Button>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

export function OnboardingPage() {
  const q = useOnboardingState();
  if (!q.data) {
    if (q.isError)
      return (
        <div className={o.root}>
          <OnboardingTopBar />
          <main className={o.done}>
            <div className={o.doneCard}>
              <h1>Couldn’t load setup</h1>
              <p>{q.error.message}</p>
              <div className={o.doneActs}>
                <Button variant="primary" onClick={() => void q.refetch()}>
                  Try again
                </Button>
              </div>
            </div>
          </main>
        </div>
      );
    return <OnboardingSkeleton />;
  }
  if (q.data.status === 'complete') return <SetUp state={q.data} />;
  return <Wizard key={q.data.mode} initial={q.data} />;
}
