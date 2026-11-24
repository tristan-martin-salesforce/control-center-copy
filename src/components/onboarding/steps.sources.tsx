'use client';
/**
 * Onboarding step 4 (sources: identities, activation, sign-in state) and its aside (the entry is ./steps.tsx).
 */
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { IdentityKind, OnboardingPersonaDraft, OnboardingSource, OnboardingSourceId, OnboardingSourcesPayload, OnboardingState, PersonaId } from '@/contract';
import { api, queryKey } from '@/client/api';
import { toast } from '@/client/toast/store';
import { Switch, TextInput } from '@/components/settings/controls';
import { Block, css as s } from '@/components/settings/form';
import { Button, fmtAgo, Skeleton, Spinner, StatePill, useWallClock, type Tone } from '@/ui';
import { groupSources, org62IdHint, readsFor, readSources, type PersonaChoice } from './derive';
import o from './onboarding.module.css';
import type { Errors } from './steps.head';

// ── 4. Sources ──────────────────────────────────────────────────────────────────────────────

const SOURCE_TONE: Record<OnboardingSource['state'], { tone: Tone; label: string }> = {
  ok: { tone: 'ok', label: 'Connected' },
  auth_needed: { tone: 'warn', label: 'Needs sign-in' },
  offline: { tone: 'risk', label: 'Not reachable' },
  unknown: { tone: 'neutral', label: 'Not checked' },
};

export function useOnboardingSources() {
  return useQuery<OnboardingSourcesPayload>({
    queryKey: queryKey('getOnboardingSources', { query: { refresh: '0' } }),
    queryFn: ({ signal }) => api('getOnboardingSources', { query: { refresh: '0' } }, { signal }),
    networkMode: 'always',
    staleTime: 2 * 60_000,
    retry: 0,
  });
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ key: 'onboarding:copy', title: 'Command copied', body: 'Paste it in your Terminal.', tone: 'success', durationMs: 2500 });
  } catch {
    toast({ key: 'onboarding:copy', title: 'Couldn’t copy', body: 'Select the command and copy it yourself.', tone: 'warning' });
  }
}

/** What the Sources step needs to show and edit the two ids. */
export interface IdentityProps {
  ids: { slackUserId: string; org62UserId: string };
  onIds: (ids: { slackUserId: string; org62UserId: string }) => void;
  identities: OnboardingState['draft']['identities'];
  detecting: ReadonlySet<IdentityKind>;
  onDetect: (kinds: IdentityKind[]) => void;
  detection: OnboardingState['detection'];
  errors: Errors;
  /** The persona: the Org62 hint follows it. */
  persona: PersonaId | null;
}

/** The persona and your activations, for the Sources step's two groups. */
export interface ActivationProps {
  role: PersonaChoice;
  overrides: Pick<OnboardingPersonaDraft, 'features' | 'connectors'>;
  onToggle: (id: OnboardingSourceId, on: boolean) => void;
}

const ID_META: Record<IdentityKind, { field: 'slackUserId' | 'org62UserId'; label: string; source: string; placeholder: string; hint: ReactNode }> = {
  slack: {
    field: 'slackUserId',
    label: 'Your Slack member ID',
    source: 'Slack',
    placeholder: 'U0123ABCD',
    hint: (
      <>
        In Slack, open your profile, click <b>⋯</b> (More), then <b>Copy member ID</b>. It starts with U or W.
      </>
    ),
  },
  org62: { field: 'org62UserId', label: 'Your Org62 user ID', source: 'Org62', placeholder: '005… (optional)', hint: org62IdHint('se') },
};

/** "just now" under a minute, then "3m ago". */
function sinceText(at: string, now: number): string {
  const t = Date.parse(at);
  return Number.isFinite(t) && now - t < 60_000 ? 'just now' : fmtAgo(at, now);
}

/** The id of one source: prefilled from a lookup when the source is connected, always editable, never blocking. */
export function IdentityRow({ kind, connected, p }: { kind: IdentityKind; connected: boolean; p: IdentityProps }) {
  const m = ID_META[kind];
  const value = p.ids[m.field];
  const det = p.identities[kind];
  const busy = p.detecting.has(kind);
  const found = det?.status === 'found' && det.id ? det : null;
  const err = p.errors[m.field];
  const canDetect = p.detection !== 'off' && connected && !busy;
  const wall = useWallClock(30_000);
  const when = found ? sinceText(found.at, wall) : '';
  // where the value came from (the app's derived-value treatment: muted text, the AI mark as the only colour)
  const note = busy ? (
    <span className={o.idBusy}>
      <Spinner size="xs" /> Looking up your {m.source} id…
    </span>
  ) : found && found.id === value.trim() ? (
    <span data-testid={`id-${kind}-found`} title={found.name ? `${m.source} account: ${found.name}` : undefined}>
      <span className={s.spark} aria-hidden>
        ✦
      </span>{' '}
      {found.simulated ? `Mock placeholder for your ${m.source} connection` : kind === 'slack' ? `Found from your Slack connection${found.name ? ` (${found.name})` : ''}` : `From Org62, matched on your email${found.name ? ` (${found.name})` : ''}`} · {when}
    </span>
  ) : found ? (
    <span data-testid={`id-${kind}-edited`}>
      Edited by you ·{' '}
      <button type="button" className={s.linkBtn} onClick={() => p.onIds({ ...p.ids, [m.field]: found.id! })}>
        Use the detected {found.id}
      </button>
    </span>
  ) : det && connected && det.status !== 'not_connected' ? (
    <span data-testid={`id-${kind}-miss`} title={det.message}>
      Couldn’t find it automatically
    </span>
  ) : det?.status === 'not_connected' ? (
    <span>{det.message}</span>
  ) : null;
  return (
    <div className={o.idRow} data-identity={kind}>
      <label htmlFor={`ob-${kind}`} className={o.idLabel}>
        {m.label}
      </label>
      <TextInput id={`ob-${kind}`} width={kind === 'slack' ? 'sm' : 'md'} spellCheck={false} autoComplete="off" placeholder={m.placeholder} aria-invalid={!!err} value={value} onChange={(e) => p.onIds({ ...p.ids, [m.field]: e.target.value })} />
      <span className={o.idNote}>
        {note}
        {canDetect ? (
          <button type="button" className={s.linkBtn} onClick={() => p.onDetect([kind])} data-testid={`detect-${kind}`}>
            {det ? 'Detect again' : 'Detect'}
          </button>
        ) : null}
      </span>
      {err ? (
        <p className={o.idErr} role="alert">
          {err}
        </p>
      ) : found && found.id === value.trim() ? null : (
        <p className={o.idHint}>{kind === 'org62' ? org62IdHint(p.persona) : m.hint}</p>
      )}
    </div>
  );
}

function SourceRow({ src, persona, children }: { src: OnboardingSource; persona: PersonaId | null; children?: ReactNode }) {
  const t = SOURCE_TONE[src.state];
  return (
    <div className={o.src} data-source={src.id} data-state={src.state}>
      <div className={o.srcName}>
        {src.label}
        {src.via ? <span className={o.srcVia}> · rides on Google</span> : null}
      </div>
      <div className={o.srcState}>
        <StatePill tone={t.tone} label={t.label} size="md" />
        <span className={o.srcMsg}>{src.message}</span>
      </div>
      <div className={o.srcReads}>{readsFor(src, persona)}</div>
      {src.command ? (
        <div className={o.cmd}>
          <code title={src.instructions ?? undefined}>{src.command}</code>
          <Button size="sm" variant="secondary" onClick={() => void copy(src.command!)} aria-label={`Copy the ${src.label} command`}>
            Copy
          </Button>
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** A source outside your role's preconfiguration: off, a quiet row with its toggle; on, the full row (state, command). */
function AvailableRow({ src, on, persona, onToggle }: { src: OnboardingSource; on: boolean; persona: PersonaId | null; onToggle: (on: boolean) => void }) {
  const toggle = (
    <label className={o.activate}>
      <Switch checked={on} onChange={onToggle} label={`Activate ${src.label}`} testId={`activate-${src.id}`} />
      <span>{on ? 'Activated' : 'Activate'}</span>
    </label>
  );
  if (on)
    return (
      <SourceRow src={src} persona={persona}>
        <div className={o.srcToggle}>{toggle}</div>
      </SourceRow>
    );
  return (
    <div className={o.src} data-source={src.id} data-available="true">
      <div className={o.srcName}>{src.label}</div>
      <div className={o.srcState}>{toggle}</div>
      <div className={o.srcReads}>{readsFor(src, persona)}</div>
    </div>
  );
}

export function SourcesStep({
  query,
  onRefresh,
  refreshing,
  mode,
  identity,
  activation,
}: {
  query: ReturnType<typeof useOnboardingSources>;
  onRefresh: () => void;
  refreshing: boolean;
  mode: OnboardingState['mode'];
  identity: IdentityProps;
  activation: ActivationProps;
}) {
  const d = query.data;
  if (!d)
    return (
      <Block title={query.isError ? 'Couldn’t check your sources' : 'Checking your sources…'} help={query.isError ? 'You can carry on; Health shows them once they scan.' : 'Slack and Org62 take up to 40 seconds.'} actions={query.isError ? <Button onClick={onRefresh}>Try again</Button> : null}>
        <div className="flex flex-col gap-4 py-2" aria-hidden>
          <Skeleton variant="row" count={5} />
        </div>
        <div className={o.srcList}>
          <IdentityRow kind="slack" connected={false} p={identity} />
          <IdentityRow kind="org62" connected={false} p={identity} />
        </div>
      </Block>
    );
  const groups = groupSources(d.sources, activation.role, activation.overrides);
  const read = readSources(groups);
  const need = read.filter((x) => x.state !== 'ok').length;
  const unchecked = read.every((x) => x.state === 'unknown');
  const at = new Date(d.checkedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const persona = activation.role.id;
  return (
    <>
      <Block
        title={unchecked ? `${read.length} sources` : need ? `${read.length - need} of ${read.length} ready` : `All ${read.length} ready`}
        help={mode === 'mock' ? 'Mock mode: states come from the sample data; nothing on this Mac was checked.' : d.simulated ? 'Not checked on this server. Each source shows the command it needs.' : `Checked at ${at}.`}
        actions={
          <Button variant="secondary" loading={refreshing} onClick={onRefresh} data-testid="sources-refresh">
            Check again
          </Button>
        }
      >
        <div className={o.srcList} data-testid="sources-list">
          {groups.active.map((src) => (
            <SourceRow key={src.id} src={src} persona={persona}>
              {src.id === 'slack' || src.id === 'org62' ? <IdentityRow kind={src.id} connected={src.state === 'ok'} p={identity} /> : null}
            </SourceRow>
          ))}
        </div>
      </Block>
      {groups.available.length ? (
        <Block title="Available · Not in your role's preconfiguration" help="Not read unless you activate it. You can change this later in Settings ▸ Role & rules.">
          <div className={o.srcList} data-testid="sources-available">
            {groups.available.map(({ src, on }) => (
              <AvailableRow key={src.id} src={src} on={on} persona={persona} onToggle={(v) => activation.onToggle(src.id, v)} />
            ))}
          </div>
        </Block>
      ) : null}
    </>
  );
}

export function SourcesAside() {
  return (
    <>
      <h2>Read-only, always</h2>
      <p>Command Center only reads your sources. Replies it drafts wait in the Outbox until you approve them; activity logs and record updates wait on Activity until you Apply them.</p>
      <h3>It never signs in for you</h3>
      <p>Where a source needs a sign-in, copy its command and run it in your own Terminal (a browser window opens for the sign-in), then click Check again. No password or token passes through this app.</p>
      <h3>You can finish now</h3>
      <p>A source that isn’t signed in yet is skipped until it is. Health shows each one and its re-auth button.</p>
      <h3>Not in your role’s preconfiguration</h3>
      <p>Sources your role doesn’t use are listed under Available. Activate one and it is read too, with its pages and drafts.</p>
    </>
  );
}
