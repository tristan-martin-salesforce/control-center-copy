'use client';
/**
 * Settings ▸ Closing work (SETTLE-1): what the app may close for you after it reads everything around an item.
 * Configured by reason (why it closed says more about the risk than ask vs task): Close for me · Ask me · Leave open.
 * Every close shows its reason, a link to the message that settled it and Undo in Triage ▸ Closed for you, and an item
 * you reopened or kept is never closed for you again (tenet: Suggest, then learn). One explicit Save, like Budgets;
 * it writes PATCH /settings/closing.
 */
import { useEffect, useId, useRef, useState } from 'react';
import { ClosingReason, type ClosingAction, type ClosingStrictness } from '@/contract';
import { Button, cn, SegmentedToggle, Skeleton } from '@/ui';
import { fmtUsd } from '@/ui/format';
import { CLOSING_REASON_LABEL } from '@/engines/home/closed';
import { Check, Glyph, MiniButton, NumberInput, Switch, TextInput } from './controls';
import { normaliseChannel } from './derive';
import { Block, Row, SaveActions, SaveFeedback, Section } from './form';
import { useSettingsModel } from './state';
import s from './settings.module.css';

/** What each reason means, in the words the check uses. */
const REASON_HELP: Record<ClosingReason, string> = {
  done_by_you: 'You replied, sent or shared what was asked.',
  resolved_by_other: 'Someone else answered it or did it.',
  moment_passed: 'The meeting or date it was for has gone by.',
  not_yours: 'It was handed to, or meant for, someone else.',
  not_an_ask: 'Read in full, it was never a request of you.',
  duplicate: 'Another item already tracks the same thing.',
  superseded: 'A newer ask replaced it.',
  gone_quiet: 'Nobody has brought it up in a long time.',
};

const ACTIONS: Array<{ value: ClosingAction; label: string }> = [
  { value: 'close', label: 'Close for me' },
  { value: 'ask', label: 'Ask me' },
  { value: 'leave', label: 'Leave open' },
];

const STRICTNESS: Array<{ value: ClosingStrictness; label: string }> = [
  { value: 'cautious', label: 'Cautious' },
  { value: 'balanced', label: 'Balanced' },
  { value: 'eager', label: 'Eager' },
];

const STRICTNESS_HELP: Record<ClosingStrictness, string> = {
  cautious: 'Only the clearest cases close; more of them ask you first.',
  balanced: 'Closes what the evidence clearly settles; asks when it is unsure.',
  eager: 'Closes on good evidence, not only certain evidence. Fewer questions, more to check in Closed for you.',
};

const RULES_MAX = 1000;

const Loading = () => <Skeleton variant="block" className="mt-6 h-48 w-full" />;

/** Chips with remove buttons, plus an add line (Enter or Add). New entries are marked until saved. */
export function ListEditor({ label, values, saved, placeholder, empty, normalise, onChange }: { label: string; values: string[]; saved: string[]; placeholder: string; empty: string; normalise: (v: string) => string | null; onChange: (v: string[]) => void }) {
  const [v, setV] = useState('');
  const id = useId();
  const box = useRef<HTMLDivElement | null>(null);
  // A removed chip takes its button with it: focus moves to the chip that took its place (else the one before, else
  // the add field) instead of falling to the page.
  const [refocus, setRefocus] = useState<number | null>(null);
  useEffect(() => {
    if (refocus === null) return;
    const buttons = box.current?.querySelectorAll<HTMLElement>('[data-chips] button') ?? [];
    const target = buttons[Math.min(refocus, buttons.length - 1)] ?? box.current?.querySelector<HTMLElement>('input');
    target?.focus();
    setRefocus(null);
  }, [refocus, values]);
  const was = new Set(saved);
  const next = normalise(v);
  const commit = () => {
    if (!next) return;
    if (!values.some((x) => x.toLowerCase() === next.toLowerCase())) onChange([...values, next]);
    setV('');
  };
  return (
    <div className={`${s.ctrl} ${s.stack}`} ref={box}>
      <div className={s.chips} aria-label={label} id={id} data-chips>
        {values.map((x, i) => (
          <span key={x} className={cn(s.chip, !was.has(x) && s.chipNew)}>
            {x}
            <MiniButton
              label={`Remove ${x}`}
              onClick={() => {
                onChange(values.filter((y) => y !== x));
                setRefocus(i);
              }}
            >
              <Glyph name="close" />
            </MiniButton>
          </span>
        ))}
        {values.length === 0 ? <span className={s.help}>{empty}</span> : null}
      </div>
      <div className={s.ctrl}>
        <TextInput
          width="full"
          style={{ flex: 1, width: 'auto' }}
          aria-label={`Add to ${label}`}
          aria-describedby={id}
          placeholder={placeholder}
          maxLength={120}
          value={v}
          onChange={(e) => setV(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), commit())}
        />
        <Button variant="secondary" onClick={commit} disabled={!next}>
          Add
        </Button>
      </div>
    </div>
  );
}

export function ClosingSection() {
  const f = useSettingsModel().closing;
  const d = f.draft;
  const reasons = d.reasons ?? f.saved.reasons;
  const usd = d.strongerModelUsdPerDay ?? 0;
  const usdErr = !Number.isFinite(usd) || usd < 0 || usd > 20 ? 'Between $0 and $20 a day.' : null;
  const days = d.oldAskDays ?? 30;
  const daysErr = !Number.isFinite(days) || days < 3 || !Number.isInteger(days) ? 'Whole days, 3 or more.' : null;
  const rules = d.rules ?? '';
  const err = usdErr ?? daysErr;
  return (
    <Section
      id="closing"
      title="Closing work"
      meta="What the app may close for you once it has read everything around an item. Every close shows its reason, a link to the message that settled it and Undo, in Triage ▸ Closed for you. Anything you reopen or keep is never closed for you again."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={!!err} testId="save-closing" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Loading />
      ) : (
        <>
          <Block>
            <Row label="Close finished work for me" htmlFor="c-enabled" help="Off: nothing closes on its own. Every finding only asks you, as Looks done or Still needed? in Triage." edited={f.changed('enabled')}>
              <Switch id="c-enabled" label="Close finished work for me" checked={d.enabled ?? true} onChange={(v) => f.set('enabled', v)} testId="closing-enabled" />
              <span className={s.unit}>{d.enabled ? 'On' : 'Off: asks only'}</span>
            </Row>
            <Row label="Strictness" labelId="l-c-strict" help={STRICTNESS_HELP[d.strictness ?? 'balanced']} edited={f.changed('strictness')}>
              <SegmentedToggle size="md" label="Strictness" value={d.strictness ?? 'balanced'} onChange={(v) => f.set('strictness', v)} options={STRICTNESS} />
            </Row>
          </Block>

          <Block id="b-c-reasons" title="By reason" help={d.enabled ? 'What happens when the check finds each reason.' : 'Saved for when closing is on. While it is off, every reason asks you.'}>
            {ClosingReason.options.map((r) => (
              <Row key={r} label={CLOSING_REASON_LABEL[r]} labelId={`l-c-${r}`} help={REASON_HELP[r]} edited={reasons[r] !== f.saved.reasons?.[r]} testId={`closing-reason-${r}`}>
                <SegmentedToggle size="md" label={`${CLOSING_REASON_LABEL[r]}: what happens`} value={reasons[r]} onChange={(v) => f.set('reasons', { ...reasons, [r]: v })} options={ACTIONS} />
              </Row>
            ))}
          </Block>

          <Block id="b-c-ask" title="Always ask first" help="These never close on their own; they ask you in Triage instead.">
            <Row label="Commitments outside the company" help="A promise to a customer or partner." edited={f.changed('askFirstExternalCommitments')}>
              <Check checked={d.askFirstExternalCommitments ?? true} onChange={(v) => f.set('askFirstExternalCommitments', v)} testId="closing-external">
                Ask before closing a commitment to someone outside the company
              </Check>
            </Row>
            <Row label="People" top help="Anything involving these people asks first." edited={f.changed('askFirstPeople')}>
              <ListEditor label="Ask-first people" values={d.askFirstPeople ?? []} saved={f.saved.askFirstPeople ?? []} placeholder="A name, then Enter" empty="Nobody yet." normalise={(v) => v.trim() || null} onChange={(v) => f.set('askFirstPeople', v)} />
            </Row>
            <Row label="Channels" top help="Anything from these channels asks first." edited={f.changed('askFirstChannels')}>
              <ListEditor label="Ask-first channels" values={d.askFirstChannels ?? []} saved={f.saved.askFirstChannels ?? []} placeholder="#channel, then Enter" empty="No channels yet." normalise={normaliseChannel} onChange={(v) => f.set('askFirstChannels', v)} />
            </Row>
          </Block>

          <Block id="b-c-rules" title="Your rules">
            <Row
              label="Your rules"
              htmlFor="c-rules"
              top
              help="Added to the check's instructions, in your words (“Never close anything from my manager”). The built-in instructions stay fixed."
              edited={f.changed('rules')}
              labelExtra={
                <span className={cn(s.help, rules.length > RULES_MAX * 0.9 && s.danger)} aria-live="polite" data-testid="closing-rules-count">
                  {rules.length.toLocaleString('en-US')} / {RULES_MAX.toLocaleString('en-US')}
                </span>
              }
            >
              <textarea id="c-rules" rows={4} className={s.in} maxLength={RULES_MAX} value={rules} placeholder="One rule per line" onChange={(e) => f.set('rules', e.target.value.slice(0, RULES_MAX))} data-testid="closing-rules" />
            </Row>
          </Block>

          <Block id="b-c-more" title="More">
            <Row label="Reopen on follow-up" help="When someone writes to you again in the conversation of an item closed for you." edited={f.changed('reopenOnFollowUp')}>
              <Check checked={d.reopenOnFollowUp ?? true} onChange={(v) => f.set('reopenOnFollowUp', v)}>
                Reopen it
              </Check>
            </Row>
            <Row label="Old asks" htmlFor="c-days" help="An ask older than this when first found waits in Triage ▸ Still needed?, unless the check settles it." error={daysErr} edited={f.changed('oldAskDays')}>
              <NumberInput id="c-days" min={3} value={days} onValue={(n) => f.set('oldAskDays', n)} aria-invalid={!!daysErr} />
              <span className={s.unit}>days</span>
            </Row>
            <Row label="Stronger model for unclear cases" help="A second, stronger read when the first is unsure, up to this much a day." error={usdErr} edited={f.changed('strongerModelForUnclear') || f.changed('strongerModelUsdPerDay')}>
              <Check checked={d.strongerModelForUnclear ?? true} onChange={(v) => f.set('strongerModelForUnclear', v)} label="Use the stronger model for unclear cases" />
              <span className={s.unit}>up to $</span>
              <NumberInput id="c-usd" min={0} max={20} step={0.5} width={88} value={usd} onValue={(n) => f.set('strongerModelUsdPerDay', n)} aria-label="Stronger model: dollars per day" aria-invalid={!!usdErr} disabled={!d.strongerModelForUnclear} />
              <span className={s.unit}>per day{Number.isFinite(usd) && d.strongerModelForUnclear ? ` · ${fmtUsd(usd * 30)} a month at most` : ''}</span>
            </Row>
            <Row label="Tell me what closed" help="One quiet line on Home beside Do now: “Closed 12 for you · Review”." edited={f.changed('tellMeWhatClosed')}>
              <Check checked={d.tellMeWhatClosed ?? true} onChange={(v) => f.set('tellMeWhatClosed', v)} testId="closing-tell-me">
                Show it on Home
              </Check>
            </Row>
          </Block>
        </>
      )}
    </Section>
  );
}
