'use client';
/** Profile & role · Thresholds · Sending · Budgets (explicit Save in the header) and Display (instant). */
import { useState } from 'react';
import { Button, Dialog, SegmentedToggle, Skeleton, useTimeZone } from '@/ui';
import { fmtUsd } from '@/ui/format';
import { COMMON_TIMEZONES, DEFAULT_THRESHOLDS, hoursPerDay, same, validateBudgets, validateHours, type Thresholds } from './derive';
import { Check, DaysPicker, Glyph, NumberInput, RangeField, Select, Switch, TextInput } from './controls';
import { Block, Instant, Row, SaveActions, SaveFeedback, Section } from './form';
import { ListEditor } from './ClosingSection';
import { useSettingsModel } from './state';
import { PersonaGate, usePersona } from '@/client/persona';
import { roleTitle } from '@/personas';
import { DEFAULT_AUTOPILOT_ASSET_HOSTS, DEFAULT_CHAT_SETTINGS } from '@/contract';
import { normaliseAssetHost } from '@/engines/vdp/asset-hosts';
import { useApi } from '@/client/hooks';
import { RaiseCapButton, RaiseHistory } from '@/components/health/RaiseCap';
import { AppLink } from '@/components/shell/AppLink';
import s from './settings.module.css';

/** Steps per message: a runaway guard the user sets (cost is the per-message budget). Any positive number, no ceiling. */
const STEPS_DEFAULT = DEFAULT_CHAT_SETTINGS.maxSteps;

const Loading = () => <Skeleton variant="block" className="mt-6 h-48 w-full" />;

// ── Profile & role ─────────────────────────────────────────────────────────────────────────

export function ProfileSection() {
  const persona = usePersona();
  const f = useSettingsModel().profile;
  const d = f.draft;
  const hoursErr = d.workingHours ? validateHours(d.workingHours.start, d.workingHours.end) : null;
  const zones = d.timezone && !COMMON_TIMEZONES.includes(d.timezone) ? [d.timezone, ...COMMON_TIMEZONES] : COMMON_TIMEZONES;
  const perDay = d.workingHours ? hoursPerDay(d.workingHours.start, d.workingHours.end) : null;
  return (
    <Section
      id="profile"
      title="Profile & hours"
      meta="Who you are and when you work. The role pack sets your starter policy; hours and time zone shape the day spine."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={!!hoursErr} testId="save-profile" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Loading />
      ) : (
        <Block>
          <Row label="Name" htmlFor="p-name" edited={f.changed('name')}>
            <TextInput id="p-name" value={d.name ?? ''} onChange={(e) => f.set('name', e.target.value)} />
          </Row>
          <Row label="Email" htmlFor="p-email" help="From your Google account. Not editable here.">
            <TextInput id="p-email" value={f.server.email} readOnly />
            <Glyph name="lock" className={s.lock} label="Read-only" />
          </Row>
          <Row label="Role" labelId="l-role" help="Your role and level set the starter priorities, the scanners' rules and what each page shows. Change them in Role & rules.">
            <div className={s.ctrl}>
              <span>{persona ? roleTitle(persona) : '…'}</span>
              <AppLink className="cc-link" href="/settings?section=role">
                Change in Role &amp; rules
              </AppLink>
            </div>
          </Row>
          <Row label="Manager" htmlFor="p-mgr" help="Used by the “manager asks” rule." edited={f.changed('managerName')}>
            <TextInput id="p-mgr" value={d.managerName ?? ''} onChange={(e) => f.set('managerName', e.target.value || null)} />
          </Row>
          <Row label="Timezone" htmlFor="p-tz" help="Every time in the app renders in this zone." edited={f.changed('timezone')}>
            <Select id="p-tz" className={s.wMd} value={d.timezone} onChange={(e) => f.set('timezone', e.target.value)}>
              {zones.map((z) => (
                <option key={z}>{z}</option>
              ))}
            </Select>
          </Row>
          <Row label="Working hours" labelId="l-hours" top help="Focus time and the day spine use these. 24-hour times." error={hoursErr} edited={f.changed('workingHours')}>
            <div className={`${s.ctrl} ${s.stack}`}>
              <div className={s.ctrl}>
                <TextInput width="xs" className={s.alignR} aria-label="Start" aria-invalid={!!hoursErr} value={d.workingHours?.start ?? ''} onChange={(e) => f.set('workingHours', { ...d.workingHours!, start: e.target.value })} />
                <span className={s.unit}>to</span>
                <TextInput width="xs" className={s.alignR} aria-label="End" aria-invalid={!!hoursErr} value={d.workingHours?.end ?? ''} onChange={(e) => f.set('workingHours', { ...d.workingHours!, end: e.target.value })} />
                {perDay ? <span className={s.unit}>· {perDay}</span> : null}
              </div>
              <DaysPicker days={d.workingHours?.days ?? []} onChange={(days) => f.set('workingHours', { ...d.workingHours!, days })} />
            </div>
          </Row>
        </Block>
      )}
    </Section>
  );
}

// ── Display (instant) ──────────────────────────────────────────────────────────────────────

export function DisplaySection() {
  const d = useSettingsModel().display;
  return (
    <Section id="display" title="Display" meta="How Command Center looks on this Mac. No Save button: what you pick is what you get." actions={<Instant />}>
      <Block>
        <Row label="Theme" labelId="l-theme" help="Dark is designed first. Light is checked for contrast too.">
          <SegmentedToggle
            size="md"
            label="Theme"
            value={d.scheme}
            onChange={(v) => d.set({ scheme: v })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <Row label="Text size" labelId="l-size" help="Sets the base size. Everything scales with it, and browser zoom still works.">
          <SegmentedToggle
            size="md"
            label="Text size"
            value={String(d.textSize) as '15' | '16' | '18'}
            onChange={(v) => d.set({ textSize: Number(v) as 15 | 16 | 18 })}
            options={[
              { value: '15', label: '15 px' },
              { value: '16', label: '16 px' },
              { value: '18', label: '18 px' },
            ]}
          />
        </Row>
        <Row label="Density" labelId="l-dens" help="Compact list rows are 36 px. Home always stays comfortable.">
          <SegmentedToggle
            size="md"
            label="Density"
            value={d.density}
            onChange={(v) => d.set({ density: v })}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>
        <Row label="Keyboard shortcuts" help="⌘K and ⌘J always work. The cheat sheet is on the right, or press ? anywhere.">
          <Check checked={d.shortcutsEnabled} disabled={!d.ready} onChange={(v) => d.set({ shortcutsEnabled: v })}>
            Single-key shortcuts on
          </Check>
        </Row>
      </Block>
    </Section>
  );
}

// ── Thresholds (engine settings, saved on this Mac) ────────────────────────────────────────

export function ThresholdsSection() {
  const t = useSettingsModel().thresholds;
  const d = t.draft;
  const set = (patch: Partial<Thresholds>) => t.setDraft({ ...d, ...patch });
  return (
    <Section
      id="thresholds"
      title="Thresholds"
      meta="How eagerly the engines close, reopen, merge and wake things. Applies to the next evaluation, not retroactively."
      actions={<SaveActions dirty={t.dirty} onSave={t.save} onDiscard={t.discard} savedAt={t.savedAt} idle="Saved on this Mac" testId="save-thresholds" />}
    >
      <Block>
        <Row label="Auto-close needs evidence at least" htmlFor="t-close" help="Sure means a signal that can't be mistaken, like a reply you sent or a file you shared. Every auto-close shows its evidence and can be undone." edited={d.autoCloseMin !== t.saved.autoCloseMin}>
          <Select id="t-close" className={s.wMd} value={d.autoCloseMin} onChange={(e) => set({ autoCloseMin: e.target.value as Thresholds['autoCloseMin'] })}>
            <option value="sure">Sure (default)</option>
            <option value="likely">Likely or better</option>
          </Select>
        </Row>
        <Row label="Reopen window" htmlFor="t-reopen" help="A done item that gets a new requirement within this many days of closing reopens and says why; later than that, a new item is created. Any whole number of days from 1. Default 14." edited={d.reopenWindowDays !== t.saved.reopenWindowDays}>
          <NumberInput id="t-reopen" min={1} value={d.reopenWindowDays} onValue={(n) => set({ reopenWindowDays: Math.max(1, Math.round(Number.isFinite(n) ? n : 1)) })} />
          <span className={s.unit}>days</span>
        </Row>
        <Row label="Merge score" htmlFor="t-merge" help="Two items this similar are offered as a merge. Higher is stricter." edited={d.mergeScore !== t.saved.mergeScore}>
          <RangeField id="t-merge" label="Merge score" min={0.5} max={1} step={0.01} value={d.mergeScore} was={t.saved.mergeScore} onValue={(n) => set({ mergeScore: Math.min(1, Math.max(0.5, Math.round(n * 100) / 100)) })} numberWidth={80} />
        </Row>
        <Row label="Snoozed items" help="Always wake on the timer or when someone asks you directly." edited={d.snoozeWakeOnNewInfo !== t.saved.snoozeWakeOnNewInfo}>
          <Check checked={d.snoozeWakeOnNewInfo} onChange={(v) => set({ snoozeWakeOnNewInfo: v })}>
            Also wake on any new information
          </Check>
        </Row>
        <Row label="">
          <button type="button" className={s.linkBtn} disabled={same(d, DEFAULT_THRESHOLDS)} onClick={() => t.setDraft(DEFAULT_THRESHOLDS)}>
            Reset to defaults
          </button>
          <span className={s.help}>{same(d, DEFAULT_THRESHOLDS) ? 'These are the defaults.' : 'Defaults: Sure · 14 days · 0.85 · timer only.'}</span>
        </Row>
      </Block>
    </Section>
  );
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────

export function SendingSection() {
  const f = useSettingsModel().sending;
  const [confirmOff, setConfirmOff] = useState(false);
  const [confirmAutopilot, setConfirmAutopilot] = useState(false);
  const d = f.draft;
  const turningOff = !!f.server?.dryRun && d.dryRun === false;
  // D-60: VDP autopilot (off for every new user); turning it on asks you to confirm, like dry run off
  const vdp = d.channels?.vdp ?? { mode: 'send' as const, autopilot: false, dailyCap: 40 };
  const turningAutopilotOn = !f.server?.channels?.vdp?.autopilot && vdp.autopilot === true;
  const setVdp = (patch: Partial<typeof vdp>) => f.set('channels', { ...(d.channels ?? { slack: { mode: 'draft' as const }, gmail: { mode: 'draft' as const } }), vdp: { ...vdp, ...patch } } as typeof d.channels);
  const saveNow = async (confirm?: boolean) => {
    await f.save({ confirm });
    setConfirmOff(false);
    setConfirmAutopilot(false);
  };
  return (
    <Section
      id="sending"
      title="Sending"
      meta="Nothing leaves without your approval. These settings decide what approval does."
      actions={<SaveActions dirty={f.dirty} onSave={() => (turningOff ? setConfirmOff(true) : turningAutopilotOn ? setConfirmAutopilot(true) : void saveNow())} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} testId="save-sending" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Loading />
      ) : (
        <Block>
          {(['slack', 'gmail'] as const).map((ch) => {
            const name = ch === 'slack' ? 'Slack' : 'Gmail';
            const channels = d.channels ?? { slack: { mode: 'draft' as const }, gmail: { mode: 'draft' as const } };
            const mode = channels[ch]?.mode ?? 'draft';
            return (
              <Row
                key={ch}
                label={`${name} replies`}
                labelId={`l-ch-${ch}`}
                help={`Draft: approving puts it in your ${name} drafts. Send: approving sends it after the ${d.undoWindowSec ?? 10}-second undo.`}
                edited={!!f.server && f.server.channels?.[ch]?.mode !== mode}
                testId={`sending-channel-${ch}`}
              >
                <SegmentedToggle size="md" label={`${name}: what approving does`} value={mode} onChange={(v) => f.set('channels', { ...channels, [ch]: { mode: v } })} options={[{ value: 'draft', label: 'Draft' }, { value: 'send', label: 'Send' }]} />
                <span className={s.help} data-testid={`sending-channel-${ch}-dry`}>
                  {d.dryRun ? (
                    <>
                      <Glyph name="lock" className="inline size-3.5 align-[-2px]" /> Dry run is on: nothing leaves either way.
                    </>
                  ) : mode === 'send' ? (
                    'Dry run is off: approved replies really send.'
                  ) : (
                    'Dry run is off: approved replies land in your drafts.'
                  )}
                </span>
              </Row>
            );
          })}
          <Row label="Default for new messages" labelId="l-mode" help="For anything without its own choice above. Draft pushes a draft; Send posts it, after a preview and a confirm." edited={f.changed('defaultMode')}>
            <SegmentedToggle size="md" label="Default for new messages" value={d.defaultMode ?? 'draft'} onChange={(v) => f.set('defaultMode', v)} options={[{ value: 'draft', label: 'Draft' }, { value: 'send', label: 'Send' }]} />
          </Row>
          <Row label="Dry run" htmlFor="s-dry" help="The switch between rehearsing and sending. On (the default), it overrides both channels. Turning it off asks you to confirm." edited={f.changed('dryRun')}>
            <Switch id="s-dry" label="Dry run" checked={d.dryRun ?? true} onChange={(v) => f.set('dryRun', v)} testId="dry-run-switch" />
            <span>
              {d.dryRun ? (
                <>
                  <b>On.</b> Sending only renders the exact payload. Nothing leaves this Mac.
                </>
              ) : (
                <>
                  <b>Off.</b> Approved messages will really be sent or drafted in Slack and Gmail, after a preview, a confirm and a {d.undoWindowSec ?? 10} s undo window.
                </>
              )}
            </span>
          </Row>
          {/* D-55: VDP autopilot, its trusted sites and its cap only while VDP is active (an AE has no VDP) */}
          <PersonaGate gate={{ feature: 'vdp' }}>
            <Row
              label="VDP autopilot"
              htmlFor="s-vdp-autopilot"
              help="The app applies, by itself, only the VDP items it can fix with known values (create the company or VDP, add an opp, the account id and period from Org62, strong assets, you as TA, Generate once the inputs are in). Judgment fields stay suggestions you approve."
              edited={!!f.server && (f.server.channels?.vdp?.autopilot ?? false) !== vdp.autopilot}
              testId="sending-vdp-autopilot"
            >
              <Switch id="s-vdp-autopilot" label="VDP autopilot" checked={vdp.autopilot === true} onChange={(v) => setVdp({ autopilot: v })} testId="vdp-autopilot-switch" />
              <span className={s.help}>{vdp.autopilot ? `On: each one is an Outbox item, read back and in History; never while dry run is on or VDP needs re-auth.${d.dryRun ? ' Dry run is on, so it waits.' : ''}` : 'Off: every VDP change waits for your Apply.'}</span>
            </Row>
            <Row top label="Trusted sites for asset links" help="Autopilot adds links only from these sites; anything else waits for you." edited={f.changed('autopilotAssetHosts')} testId="sending-vdp-asset-hosts">
              <ListEditor label="Trusted sites" values={d.autopilotAssetHosts ?? [...DEFAULT_AUTOPILOT_ASSET_HOSTS]} saved={f.server.autopilotAssetHosts ?? []} placeholder="A site such as docs.google.com, then Enter" empty="No sites: every asset link waits for you." normalise={(v) => normaliseAssetHost(v)} onChange={(v) => f.set('autopilotAssetHosts', v)} />
            </Row>
            <Row label="Autopilot's daily cap" htmlFor="s-vdp-cap" help="The most VDP writes autopilot makes in one day; the rest waits for tomorrow." edited={!!f.server && (f.server.channels?.vdp?.dailyCap ?? 40) !== vdp.dailyCap}>
              <NumberInput id="s-vdp-cap" min={1} max={500} value={vdp.dailyCap ?? 40} onValue={(n) => setVdp({ dailyCap: Math.min(500, Math.max(1, Math.round(Number.isFinite(n) ? n : 40))) })} />
              <span className={s.unit}>writes a day</span>
            </Row>
          </PersonaGate>
          <Row label="Read-back verification" help="After a send, read the message back and show “Verified” on the Outbox row. Failures stay visible." edited={f.changed('verifyReadback')}>
            <Check checked={d.verifyReadback ?? true} onChange={(v) => f.set('verifyReadback', v)}>
              Verify every send
            </Check>
          </Row>
          <Row label="Undo window" htmlFor="s-undo" help="How long the “Sending… Undo” toast waits before executing." edited={f.changed('undoWindowSec')}>
            <NumberInput id="s-undo" min={0} max={60} value={d.undoWindowSec ?? 10} onValue={(n) => f.set('undoWindowSec', Math.min(60, Math.max(0, Math.round(Number.isFinite(n) ? n : 0))))} />
            <span className={s.unit}>seconds</span>
          </Row>
        </Block>
      )}
      <Dialog
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="Turn dry run off?"
        tone="danger"
        cancelLabel="Keep dry run"
        confirmLabel="Turn dry run off"
        busy={f.mutation.isPending}
        onConfirm={() => saveNow(true)}
        description="This is the switch between rehearsing and sending."
      >
        <ul className="list-disc space-y-1 pl-5 text-body text-fg">
          <li>Approved messages can now leave this Mac: Slack and Gmail sends and drafts.</li>
          {vdp.autopilot ? (
            <PersonaGate gate={{ feature: 'vdp' }}>
              <li>VDP autopilot is on: it starts applying what it can fix with known values.</li>
            </PersonaGate>
          ) : null}
          <li>Each one still needs your preview and confirm, then a {d.undoWindowSec ?? 10} s undo window.</li>
          <li>The dry run line in the sidebar changes to “Live send”.</li>
          <li>Turn it back on here at any time. Messages already sent stay sent.</li>
        </ul>
      </Dialog>
      <Dialog
        open={confirmAutopilot}
        onClose={() => setConfirmAutopilot(false)}
        title="Turn VDP autopilot on?"
        cancelLabel="Keep it off"
        confirmLabel="Turn autopilot on"
        busy={f.mutation.isPending}
        onConfirm={() => saveNow(true)}
        description="The app then writes to VDP by itself, only what it can fix with known values."
      >
        <ul className="list-disc space-y-1 pl-5 text-body text-fg" data-testid="vdp-autopilot-confirm">
          <li>It creates the company or the VDP, adds your opps, fills the account id and period from Org62, adds strong assets, sets you as TA, and runs Generate once a use case&apos;s inputs are in.</li>
          <li>It never deletes, never changes a value someone entered, never writes guessed text, and stops at {vdp.dailyCap ?? 40} writes a day.</li>
          <li>Nothing happens while dry run is on or VDP needs re-auth. Every write is an Outbox item, read back and in History.</li>
        </ul>
      </Dialog>
    </Section>
  );
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────

/** The assistant's own limits (settings.chat). A message that hits one offers "Allow more" for that message only. */
export function AssistantLimitsSection() {
  const f = useSettingsModel().assistantLimits;
  const d = f.draft;
  const per = d.messageUsd ?? { sonnet: 0.25, opus: 0.6 };
  return (
    <Section
      id="budgets-assistant"
      title="Assistant limits"
      meta="What one chat message, and the assistant in a day, may spend. A message that reaches a limit stops and offers Allow more, which applies to that message only."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} testId="save-assistant-limits" />}
      feedback={<SaveFeedback mutation={f.mutation} />}
    >
      {!f.server ? (
        <Loading />
      ) : (
        <Block>
          <Row label="Per day" htmlFor="a-day" help="All assistant messages together, inside the budgets above." edited={f.changed('dailyUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="a-day" min={0} max={100} step={0.5} width={104} value={d.dailyUsd ?? 3} onValue={(n) => f.set('dailyUsd', n)} />
            <span className={s.unit}>per day</span>
          </Row>
          <Row label="Per message, Sonnet" htmlFor="a-sonnet" help="Most answers cost $0.03 to $0.08." edited={f.changed('messageUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="a-sonnet" min={0.01} max={10} step={0.05} width={104} value={per.sonnet} onValue={(n) => f.set('messageUsd', { ...per, sonnet: n })} />
          </Row>
          <Row label="Per message, Opus" htmlFor="a-opus" edited={f.changed('messageUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="a-opus" min={0.01} max={10} step={0.05} width={104} value={per.opus} onValue={(n) => f.set('messageUsd', { ...per, opus: n })} />
          </Row>
          <Row
            label="Steps per message"
            htmlFor="a-steps"
            help={`Tool rounds in one message: a runaway guard, not a cost limit (the per-message budget is). Any positive number; the default is ${STEPS_DEFAULT}. The Assistant stops and asks when it is reached.`}
            edited={f.changed('maxSteps')}
          >
            <NumberInput id="a-steps" min={1} step={1} width={104} value={d.maxSteps ?? STEPS_DEFAULT} onValue={(n) => f.set('maxSteps', Math.round(n))} />
          </Row>
          <Row label="Deep research, per run" htmlFor="a-research" help="Live search of Slack, Gmail, Calendar, Drive and Org62 when the app has nothing. Its own limit per run, not taken from the message's; counts toward the day." edited={f.changed('researchUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="a-research" min={0.05} max={5} step={0.05} width={104} value={d.researchUsd ?? 0.5} onValue={(n) => f.set('researchUsd', n)} />
          </Row>
        </Block>
      )}
    </Section>
  );
}

/** YYYY-MM-DD in `tz` (the day a "Today only" override applies to). */
function localToday(tz: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { ...(tz ? { timeZone: tz } : {}), year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function BudgetsSection() {
  const f = useSettingsModel().budgets;
  const chat = useSettingsModel().assistantLimits;
  const tz = useTimeZone();
  const health = useApi('getHealth');
  const d = f.draft;
  const day = localToday(tz);
  const t = d.today && d.today.day === day ? d.today : null;
  const setToday = (patch: Partial<NonNullable<typeof d.today>> | null) =>
    f.set('today', patch === null ? null : { day, softUsd: t?.softUsd ?? d.softUsd ?? 0, hardUsd: t?.hardUsd ?? d.hardUsd ?? 0, chatUsd: t?.chatUsd ?? null, reason: t?.reason ?? '', ...patch });
  const todayErr = t && t.softUsd > t.hardUsd ? "Today's soft budget can't be above today's hard cap." : null;
  const err = (f.server ? validateBudgets(d.softUsd ?? 0, d.hardUsd ?? 0, d.alertPct ?? 80) : null) ?? todayErr;
  const soft = d.softUsd ?? 0;
  const warnAt = Number.isFinite(soft) && Number.isFinite(d.alertPct) ? (soft * (d.alertPct ?? 80)) / 100 : null;
  return (
    <Section
      id="budgets"
      title="Budgets"
      meta="Daily AI spend. At the soft budget the header shows a chip. At the hard cap, scans run on rules only (no AI) until tomorrow."
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={!!err} testId="save-budgets" />}
      feedback={
        <>
          {err ? (
            <p role="alert" className="text-body text-danger-700">
              {err}
            </p>
          ) : null}
          <SaveFeedback mutation={f.mutation} />
        </>
      }
    >
      {!f.server ? (
        <Loading />
      ) : (
        <Block>
          <Row label="Soft budget" htmlFor="b-soft" help="The header chip shows when you pass it." edited={f.changed('softUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="b-soft" min={0} step={0.5} width={104} value={d.softUsd ?? 0} onValue={(n) => f.set('softUsd', n)} />
            <span className={s.unit}>per day</span>
          </Row>
          <Row label="Hard cap" htmlFor="b-hard" help="Can't be lower than the soft budget." edited={f.changed('hardUsd')}>
            <span className={s.unit}>$</span>
            <NumberInput id="b-hard" min={0} step={1} width={104} value={d.hardUsd ?? 0} onValue={(n) => f.set('hardUsd', n)} aria-invalid={!!err} />
            <span className={s.unit}>per day</span>
          </Row>
          <Row label="Early warning" htmlFor="b-pct" help="Show the header chip at this share of the soft budget." edited={f.changed('alertPct')}>
            <NumberInput id="b-pct" min={1} max={100} value={d.alertPct ?? 80} onValue={(n) => f.set('alertPct', n)} />
            <span className={s.unit}>% of soft{warnAt !== null ? ` · ${fmtUsd(warnAt)}` : ''}</span>
          </Row>
        </Block>
      )}
      {!f.server ? null : (
        <Block title="Today only" help="Raise today's cap without touching the limits above, with a reason that stays with the day's spend. It goes back to normal at midnight.">
          <Row
            label="Today's limits"
            htmlFor="raise-cap"
            help={t ? `Raised to soft ${fmtUsd(t.softUsd)} · cap ${fmtUsd(t.hardUsd)}${t.reason ? `: ${t.reason}` : ''}.` : `Today you have the limits above${chat.draft.dailyUsd != null ? `, and ${fmtUsd(chat.draft.dailyUsd)} for the assistant` : ''}.`}
            edited={f.changed('today')}
          >
            <RaiseCapButton spend={health.data?.spend} label={t ? 'Raise again…' : "Raise today's cap…"} />
            {t ? (
              <Button variant="ghost" size="sm" onClick={() => setToday(null)} data-testid="b-today-clear">
                Back to the usual limits
              </Button>
            ) : null}
          </Row>
          {t ? (
            <Row label="Assistant today" htmlFor="b-t-chat" help="Empty keeps the assistant's usual daily limit." edited={f.changed('today')}>
              <span className={s.unit}>$</span>
              <NumberInput id="b-t-chat" min={0} step={0.5} width={104} value={t.chatUsd ?? chat.draft.dailyUsd ?? 3} onValue={(n) => setToday({ chatUsd: n })} />
            </Row>
          ) : null}
          <RaiseHistory last7d={health.data?.spend.last7d} className="mt-3" />
        </Block>
      )}
    </Section>
  );
}
