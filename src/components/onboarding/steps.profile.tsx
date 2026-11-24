'use client';
/**
 * Onboarding steps 1 to 3 (role, you, priorities) and their asides (the entry is ./steps.tsx).
 */
import type { OnboardingPriorities, OnboardingRolePack, OnboardingYouDraft, PersonaId, PersonaLevel, PolicyWeightKey } from '@/contract';
import { DaysPicker, Select, TextInput } from '@/components/settings/controls';
import { COMMON_TIMEZONES, hoursPerDay, WEIGHT_KEYS, WEIGHT_META } from '@/components/settings/derive';
import { Block, css as s, Row } from '@/components/settings/form';
import { PolicyRulesTable, PolicyWeightRows } from '@/components/settings/PolicySection';
import { PERSONAS, selectablePersonas } from '@/personas';
import { SegmentedToggle } from '@/ui';
import { editedCount, resolvedPersona, roleLabel, type PersonaChoice } from './derive';
import o from './onboarding.module.css';
import type { Errors } from './steps.head';

// ── 1. Role ─────────────────────────────────────────────────────────────────────────────────

/** Persona cards (a radio group) and, when the persona has more than one, its levels. */
export function RoleStep({ value, onChange, errors }: { value: PersonaChoice; onChange: (v: { id: PersonaId; level: PersonaLevel }) => void; errors: Errors }) {
  const personas = selectablePersonas();
  const def = value.id ? PERSONAS[value.id] : null;
  const levels = def ? (Object.entries(def.levels) as Array<[PersonaLevel, { label: string }]>) : [];
  const pick = (id: PersonaId) => {
    const lv = Object.keys(PERSONAS[id].levels) as PersonaLevel[];
    onChange({ id, level: id === value.id ? value.level : (lv[0] ?? 'ic') });
  };
  return (
    <>
      <div className={o.personas} role="radiogroup" aria-label="Your role" aria-invalid={!!errors.id} data-testid="persona-options">
        {personas.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={p.id === value.id} className={o.opt} data-testid={`persona-${p.id}`} onClick={() => pick(p.id)}>
            <span className={o.optDays}>
              {p.label}
              {p.status === 'preview' ? <span className={o.preview}>Preview</span> : null}
            </span>
            <span className={o.optSub}>{p.summary}</span>
          </button>
        ))}
      </div>
      {errors.id ? (
        <p className={o.errLine} role="alert">
          {errors.id}
        </p>
      ) : null}
      {def && levels.length > 1 ? (
        <Block>
          <Row label="Level" labelId="ob-l-level" help="It picks your starter priorities: a manager’s put their leader’s asks first." error={errors.level}>
            <SegmentedToggle size="md" label="Level" value={value.level} onChange={(level) => onChange({ id: def.id, level })} options={levels.map(([k, v]) => ({ value: k, label: v.label }))} />
          </Row>
        </Block>
      ) : errors.level ? (
        <p className={o.errLine} role="alert">
          {errors.level}
        </p>
      ) : null}
    </>
  );
}

export function RoleAside({ value }: { value: PersonaChoice }) {
  const p = resolvedPersona(value);
  if (!p)
    return (
      <>
        <h2>Why it matters</h2>
        <p>Your role decides what counts as yours: which sources are read, how your list is ranked to start with, and which duties the app keeps an eye on.</p>
        <h3>Nothing is taken away</h3>
        <p>A role only preconfigures. Anything outside it stays available, and you can turn it on here (Sources) or later in Settings ▸ Role &amp; rules.</p>
      </>
    );
  const on = p.duties.filter((d) => d.active);
  const off = p.duties.filter((d) => !d.active);
  return (
    <>
      <h2>{roleLabel(value)}</h2>
      {p.status === 'preview' ? <p>In preview: the forecast workflow is new. Report what’s missing with Feedback in the top bar.</p> : null}
      <h3>Preconfigured for you</h3>
      <ul data-testid="role-duties">
        {on.map((d) => (
          <li key={d.id}>{d.text}</li>
        ))}
      </ul>
      {off.length ? (
        <>
          <h3>Available, not preconfigured</h3>
          <ul>
            {off.map((d) => (
              <li key={d.id}>{d.text}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className="mt-3 text-caption">Change any of it later in Settings ▸ Role &amp; rules.</p>
    </>
  );
}

// ── 2. You ──────────────────────────────────────────────────────────────────────────────────

export function YouStep({ value, onChange, errors, locked }: { value: OnboardingYouDraft; onChange: (v: OnboardingYouDraft) => void; errors: Errors; locked: Array<'email'> }) {
  const set = <K extends keyof OnboardingYouDraft>(k: K, v: OnboardingYouDraft[K]) => onChange({ ...value, [k]: v });
  const wh = value.workingHours ?? { start: '09:00', end: '18:00', days: [1, 2, 3, 4, 5] };
  const tz = value.timezone ?? 'America/Denver';
  const zones = COMMON_TIMEZONES.includes(tz) ? COMMON_TIMEZONES : [tz, ...COMMON_TIMEZONES];
  const hoursErr = errors['workingHours.start'] ?? errors['workingHours.end'] ?? errors['workingHours.days'] ?? errors.workingHours ?? null;
  const perDay = hoursPerDay(wh.start, wh.end);
  return (
    <Block>
      <Row label="Name" htmlFor="ob-name" error={errors.name}>
        <TextInput id="ob-name" autoComplete="name" aria-invalid={!!errors.name} value={value.name ?? ''} onChange={(e) => set('name', e.target.value)} />
      </Row>
      <Row label="Work email" htmlFor="ob-email" help={locked.includes('email') ? 'This database already has your user; the email stays.' : 'The Google account the Gmail, Calendar and Drive scans read.'} error={errors.email}>
        <TextInput id="ob-email" type="email" autoComplete="email" aria-invalid={!!errors.email} readOnly={locked.includes('email')} value={value.email ?? ''} onChange={(e) => set('email', e.target.value)} />
      </Row>
      <Row label="Time zone" htmlFor="ob-tz" help="Every time in the app shows in this zone." error={errors.timezone}>
        <Select id="ob-tz" className={s.wMd} value={tz} onChange={(e) => set('timezone', e.target.value)}>
          {zones.map((z) => (
            <option key={z}>{z}</option>
          ))}
        </Select>
      </Row>
      <Row label="Working hours" labelId="ob-l-hours" top help="Your day plan and free time use these. 24-hour times." error={hoursErr}>
        <div className={`${s.ctrl} ${s.stack}`}>
          <div className={s.ctrl}>
            <TextInput width="xs" className={s.alignR} aria-label="Start" aria-invalid={!!hoursErr} value={wh.start} onChange={(e) => set('workingHours', { ...wh, start: e.target.value })} />
            <span className={s.unit}>to</span>
            <TextInput width="xs" className={s.alignR} aria-label="End" aria-invalid={!!hoursErr} value={wh.end} onChange={(e) => set('workingHours', { ...wh, end: e.target.value })} />
            {perDay ? <span className={s.unit}>· {perDay}</span> : null}
          </div>
          <DaysPicker days={wh.days} onChange={(days) => set('workingHours', { ...wh, days })} />
        </div>
      </Row>
    </Block>
  );
}

export function YouAside() {
  return (
    <>
      <h2>Why these</h2>
      <p>
        The scanners look for <b>your</b> messages, meetings and deals. Your work email is how the Google scans and Org62 find you; your Slack and Org62 ids come next, on the Sources step, read from each source once it is signed in.
      </p>
      <h3>Working hours</h3>
      <p>Today plans your day inside these hours, and free time is counted from them. Agent work runs in the background and never counts against them.</p>
      <h3>Stays on this Mac</h3>
      <p>Everything you enter is saved in your local database. Nothing is sent anywhere, and you can change any of it later in Settings ▸ Profile &amp; hours.</p>
    </>
  );
}

// ── 3. Priorities ───────────────────────────────────────────────────────────────────────────

/** One plain sentence per weight, for someone who has never seen the ranking. */
export const WEIGHT_SENTENCE: Record<PolicyWeightKey, string> = {
  customer_facing: 'Work that touches a customer ranks above internal work.',
  meeting_proximity: 'Prep for a meeting that is coming up soon moves up.',
  due_urgency: 'Things due soon, or already overdue, move up.',
  manager_ask: 'Asks from your manager move up.',
  deal_value: 'Work on bigger opportunities ranks higher.',
  lead_time: 'Long agent jobs with a meeting ahead start first, so they finish in time.',
  age: 'Old items rise slowly, so nothing sits forever.',
  effort_fit: 'Small items that fit a gap between meetings move up.',
};

export function PrioritiesStep({ value, pack, onChange, errors }: { value: OnboardingPriorities; pack: OnboardingRolePack; onChange: (v: OnboardingPriorities) => void; errors: Errors }) {
  const ruleErr = Object.entries(errors).find(([k]) => k.startsWith('rules.'))?.[1];
  return (
    <>
      <Block title="Weights" help={`${pack.name} starter. 0 ignores a signal, 10 lets it dominate.`}>
        <div className={o.weightGrid}>
          <PolicyWeightRows weights={value.weights} was={pack.weights} onChange={(weights) => onChange({ ...value, weights })} help={(k) => WEIGHT_SENTENCE[k]} />
        </div>
      </Block>
      <Block title="Rules" help="Applied after the weights. A positive boost lifts what matches; a negative one holds it back." feedback={ruleErr ? <p className={o.errLine}>{ruleErr}</p> : null}>
        <div className={o.rulesCompact}>
          <PolicyRulesTable rules={value.rules} saved={pack.rules} onChange={(rules) => onChange({ ...value, rules })} />
        </div>
      </Block>
    </>
  );
}

export function PrioritiesAside({ value, pack }: { value: OnboardingPriorities; pack: OnboardingRolePack }) {
  const top = [...WEIGHT_KEYS].sort((a, b) => value.weights[b] - value.weights[a]).slice(0, 3);
  const n = editedCount(value, pack);
  return (
    <>
      <h2>How your list is ranked</h2>
      <p>Every open item gets a score: each signal it shows (from 0 to 1) times its weight, plus the boosts of the rules it matches. The highest scores become Do now on Home.</p>
      <h3>What counts most for you</h3>
      <ul>
        {top.map((k) => (
          <li key={k}>
            <b>{WEIGHT_META[k].label}</b> ({value.weights[k]})
          </li>
        ))}
      </ul>
      <h3>{n ? `${n} change${n === 1 ? '' : 's'} from the ${pack.name} starter` : `The ${pack.name} starter, unchanged`}</h3>
      <p>Your list stays empty until the first scan finds work. Nothing re-ranks on its own later: you change this in Settings ▸ Priority policy, with a preview first.</p>
    </>
  );
}
