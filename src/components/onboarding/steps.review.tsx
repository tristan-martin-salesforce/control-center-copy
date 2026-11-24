'use client';
/**
 * Onboarding steps 5 and 6 (history, review) and their asides (the entry is ./steps.tsx).
 */
import type { OnboardingHistory, OnboardingPersonaDraft, OnboardingPriorities, OnboardingRolePack, OnboardingSourcesPayload, OnboardingState, OnboardingStep, OnboardingYouDraft } from '@/contract';
import { BACKFILL_BUDGET_RANGE, durationText as durationLabel } from '@/contract';
import { FIRST_SCAN_SOURCE_DAY_USD } from '@/llm/spend/defaults';
import { estimateFirstScan, firstScanLine } from '@/llm/spend/first-scan';
import { NumberInput } from '@/components/settings/controls';
import { Block, css as s, Row } from '@/components/settings/form';
import { PERSONAS } from '@/personas';
import { Button, cn } from '@/ui';
import { activatedLabels, daysText, editedCount, groupSources, readSources, roleLabel, sourcesLine, STEP_META, usd, usdRange, type PersonaChoice } from './derive';
import o from './onboarding.module.css';
import type { Errors } from './steps.head';

// ── 5. History ──────────────────────────────────────────────────────────────────────────────

export function HistoryStep({ value, onChange, cost, errors }: { value: OnboardingHistory; onChange: (v: OnboardingHistory) => void; cost: OnboardingState['cost']; errors: Errors }) {
  const sel = cost.options.find((x) => x.days === value.lookbackDays) ?? cost.options[0]!;
  const over = Number.isFinite(value.budgetUsd) && sel.highUsd > value.budgetUsd;
  return (
    <>
      <div className={o.options} role="radiogroup" aria-label="History to read">
        {cost.options.map((opt) => (
          <button
            key={opt.days}
            type="button"
            role="radio"
            aria-checked={opt.days === value.lookbackDays}
            className={o.opt}
            data-testid={`lookback-${opt.days}`}
            onClick={() => onChange({ ...value, lookbackDays: opt.days })}
          >
            <span className={o.optDays}>{opt.days} days</span>
            <span className={o.optCost}>about {usdRange(opt)}</span>
            <span className={o.optSub}>
              {opt.days === cost.defaultDays ? 'Recommended · one-time' : 'One-time'}
              {opt.minutes ? ` · ${durationLabel(opt.minutes)}` : ''}
            </span>
          </button>
        ))}
      </div>
      <Block>
        <Row label="Backfill budget" htmlFor="ob-budget" help={`A ceiling for this first scan only ($${BACKFILL_BUDGET_RANGE.min}–${BACKFILL_BUDGET_RANGE.max}). Daily scanning keeps its own cap.`} error={errors.budgetUsd}>
          <span className={s.unit}>$</span>
          <NumberInput id="ob-budget" value={value.budgetUsd} min={BACKFILL_BUDGET_RANGE.min} max={BACKFILL_BUDGET_RANGE.max} step={5} width={120} aria-invalid={!!errors.budgetUsd} onValue={(n) => onChange({ ...value, budgetUsd: n })} />
          {/* D6: the estimate for the chosen history sits next to the ceiling it has to fit under. */}
          <span className={over ? o.optWarn : o.optSub} data-testid="backfill-estimate">
            {sel.days} days is about {usdRange(sel)}.{over ? ' The high estimate is above this budget; the oldest days may be left for the daily scans.' : ' This budget covers it.'}
          </span>
        </Row>
        {/* COST-9: the governor's per-source estimate, held when you start; a scan past it asks before it goes on */}
        <p className="mt-2 text-caption text-muted" data-testid="first-scan-estimate">
          {firstScanLine(estimateFirstScan(Object.keys(FIRST_SCAN_SOURCE_DAY_USD), { days: value.lookbackDays }), durationLabel)}. Past that it asks before it goes on.
        </p>
      </Block>
    </>
  );
}

export function HistoryAside({ value, cost }: { value: OnboardingHistory; cost: OnboardingState['cost'] }) {
  return (
    <>
      <h2>What it costs</h2>
      <p>
        One day of history costs about <b>{usdRange(cost.perDay)}</b> to read across every source.
      </p>
      <table className={o.costTbl} aria-label="Estimated cost by history length">
        <thead>
          <tr>
            <th>History</th>
            <th>Estimate</th>
            <th>Takes</th>
          </tr>
        </thead>
        <tbody>
          {cost.options.map((opt) => (
            <tr key={opt.days} data-on={opt.days === value.lookbackDays ? 'true' : undefined}>
              <td>{opt.days} days</td>
              <td>{usdRange(opt)}</td>
              <td>{opt.minutes ? durationLabel(opt.minutes) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-caption">{cost.basis}</p>
      <h3>While it runs</h3>
      <p>You can use the app from the start. Until the first scan finishes, some items may be missing or look undone; a banner on every page shows how far it got.</p>
      <h3>Older than that</h3>
      <p>Anything older you know about can be added by hand at any time, with Capture.</p>
      {cost.dailyHardUsd !== null ? (
        <>
          <h3>After the first scan</h3>
          <p>Scanning keeps up as things happen, under your daily cap ({usd(cost.dailyHardUsd)} a day, Settings ▸ Budgets).</p>
        </>
      ) : null}
    </>
  );
}

// ── 6. Review ───────────────────────────────────────────────────────────────────────────────

export function ReviewStep({
  role,
  overrides,
  you,
  priorities,
  pack,
  history,
  cost,
  sources,
  mode,
  onEdit,
}: {
  role: PersonaChoice;
  overrides: Pick<OnboardingPersonaDraft, 'features' | 'connectors'>;
  you: OnboardingYouDraft;
  priorities: OnboardingPriorities;
  pack: OnboardingRolePack;
  history: OnboardingHistory;
  cost: OnboardingState['cost'];
  sources: OnboardingSourcesPayload | undefined;
  mode: OnboardingState['mode'];
  onEdit: (s: OnboardingStep) => void;
}) {
  const est = cost.options.find((x) => x.days === history.lookbackDays);
  const n = editedCount(priorities, pack);
  const edit = (s: OnboardingStep) => (
    <Button size="sm" variant="quiet" onClick={() => onEdit(s)} aria-label={`Edit ${STEP_META[s].label}`}>
      Edit
    </Button>
  );
  const wh = you.workingHours;
  const def = role.id ? PERSONAS[role.id] : null;
  const activated = activatedLabels(sources?.sources, role, overrides);
  const read = sources ? readSources(groupSources(sources.sources, role, overrides)) : undefined;
  return (
    <div className={o.sum} data-testid="onboarding-review">
      <section className={o.card}>
        <div className={o.cardHead}>
          <h2>Role</h2>
          {edit('role')}
        </div>
        <dl className={o.kv}>
          <dt>Role</dt>
          <dd data-testid="review-role">
            {roleLabel(role)}
            {def?.status === 'preview' ? ' (Preview)' : ''}
          </dd>
          <dt>Logs as</dt>
          <dd>{def ? (def.logging.recordType.value === 'SalesEvents' ? 'Sales Events' : def.logging.recordType.value) : ''}</dd>
          <dt>Activated</dt>
          <dd>{activated.length ? activated.join(', ') : 'Nothing beyond your role'}</dd>
        </dl>
      </section>
      <section className={o.card}>
        <div className={o.cardHead}>
          <h2>You</h2>
          {edit('you')}
        </div>
        <dl className={o.kv}>
          <dt>Name</dt>
          <dd>{you.name}</dd>
          <dt>Email</dt>
          <dd>{you.email}</dd>
          <dt>Hours</dt>
          <dd>{wh ? `${wh.start}–${wh.end} · ${daysText(wh.days)} · ${you.timezone}` : ''}</dd>
        </dl>
      </section>
      <section className={o.card}>
        <div className={o.cardHead}>
          <h2>Priorities</h2>
          {edit('priorities')}
        </div>
        <dl className={o.kv}>
          <dt>Starter</dt>
          <dd>{pack.name}</dd>
          <dt>Changes</dt>
          <dd>{n ? `${n} (saved as policy v2, “Set during onboarding”)` : 'None'}</dd>
          <dt>Rules</dt>
          <dd>
            {priorities.rules.filter((r) => r.enabled).length} on, {priorities.rules.filter((r) => !r.enabled).length} off
          </dd>
        </dl>
      </section>
      <section className={o.card}>
        <div className={o.cardHead}>
          <h2>Sources</h2>
          {edit('sources')}
        </div>
        <dl className={o.kv}>
          <dt>Slack</dt>
          <dd>{you.slackUserId}</dd>
          <dt>Org62</dt>
          <dd>{you.org62UserId?.trim() || 'Not set (optional)'}</dd>
        </dl>
        <p className={o.hint}>{sourcesLine(sources, read)}</p>
      </section>
      <section className={o.card}>
        <div className={o.cardHead}>
          <h2>History</h2>
          {edit('history')}
        </div>
        <dl className={o.kv}>
          <dt>Reads</dt>
          <dd>{history.lookbackDays} days back</dd>
          <dt>Estimate</dt>
          <dd>{est ? `about ${usdRange(est)}, one-time${est.minutes ? `, ${durationLabel(est.minutes)}` : ''}` : ''}</dd>
          <dt>Ceiling</dt>
          <dd>{usd(history.budgetUsd)}</dd>
        </dl>
      </section>
      <section className={cn(o.card, o.wide)}>
        <div className={o.cardHead}>
          <h2>When you start</h2>
        </div>
        <ol className={o.next}>
          {mode === 'mock' ? (
            <li>Mock mode: the sample data’s profile and policy take your choices. Nothing is scanned.</li>
          ) : (
            <li>Your user, settings, role and starter policy are created in this database. Sending stays in dry run; replies are drafted, never sent.</li>
          )}
          <li>
            The first scan reads {history.lookbackDays} days of history, up to {usd(history.budgetUsd)}
            {est?.minutes ? `, in ${durationLabel(est.minutes)}` : ''}. It starts when the worker picks it up, within a minute.
          </li>
          <li>Home opens. Until the first scan finishes, items may be missing or look undone; a banner shows how far it got.</li>
        </ol>
      </section>
    </div>
  );
}

export function ReviewAside() {
  return (
    <>
      <h2>Change it later</h2>
      <ul>
        <li>
          <b>Settings ▸ Role &amp; rules</b>: your role, what it preconfigures, and what you activate.
        </li>
        <li>
          <b>Settings ▸ Profile &amp; hours</b>: name, hours, time zone.
        </li>
        <li>
          <b>Settings ▸ Priority policy</b>: weights and rules, with a preview first.
        </li>
        <li>
          <b>Settings ▸ Budgets</b>: the daily scanning cap.
        </li>
      </ul>
      <h3>Nothing leaves without approval</h3>
      <p>Every reply is a draft in the Outbox until you approve it, and every log entry or record update waits on Activity until you Apply it. Dry run is on.</p>
    </>
  );
}
