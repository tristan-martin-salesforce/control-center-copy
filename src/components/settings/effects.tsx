'use client';
/**
 * Effect panes for every section except the policy (PolicyEffect): what the setting changes, from live data,
 * following the draft you are editing. Color is an indicator only: blue = now / your edit, red = broken.
 */
import type { ReactNode } from 'react';
import { ClosingReason, type AutonomyLevel, type CalendarEvent, type ClosingAction, type Connector } from '@/contract';
import { CLOSING_REASON_LABEL } from '@/engines/home/closed';
import { AppLink } from '@/components/shell/AppLink';
import { useApi } from '@/client/hooks';
import { usePersona } from '@/client/persona';
import { cheatSheetGroups } from '@/components/shell/CheatSheet';
import { copyText } from '@/components/time/shared';
import { toast } from '@/client/toast';
import { Button, cn, KbdHint, Skeleton, useNow } from '@/ui';
import { fmtClock, fmtDay, fmtMinutes, fmtUsd } from '@/ui/format';
import { actionLabel, AUTONOMY_LEVELS, daysLabel, hhmmToMin, zoneAbbrev, type SectionId } from './derive';
import { Glyph, type GlyphName } from './controls';
import { BROKEN, ConnectorStatus, cadenceText, dataThrough, sortConnectors, useConnectorActions } from './SourcesSections';
import { useSettingsModel } from './state';
import s from './settings.module.css';

function Head({ title, sub, badge }: { title: string; sub?: ReactNode; badge?: ReactNode }) {
  return (
    <div>
      <div className={s.kicker}>
        <h2>{title}</h2>
        {badge}
      </div>
      {sub ? <p className={s.sub}>{sub}</p> : null}
    </div>
  );
}

function Fact({ icon, dot, k, v }: { icon?: GlyphName; dot?: 'danger' | 'neutral'; k: ReactNode; v?: ReactNode }) {
  return (
    <div className={s.fact}>
      {icon ? <Glyph name={icon} className={s.factIc} /> : <span className={cn(s.factDot, dot === 'danger' && s.factDotDanger)} aria-hidden />}
      <span className={s.factK}>{k}</span>
      {v ? <span className={s.factV}>{v}</span> : null}
    </div>
  );
}

function Card({ title, right, children, className }: { title?: ReactNode; right?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn(s.card, className)}>
      {title || right ? (
        <div className={s.cardHead}>
          {/* h3 under the pane's h2 (heading levels go up one at a time) */}
          {title ? <h3>{title}</h3> : null}
          {right ? <span className={s.muted}>{right}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/** Minutes after local midnight in `tz`. */
function minutesIn(at: Date | string, tz?: string): number {
  const d = typeof at === 'string' ? new Date(at) : at;
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(d);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

// ── Profile ────────────────────────────────────────────────────────────────────────────────

function ProfileEffect() {
  const { profile, policy } = useSettingsModel();
  const persona = usePersona();
  const cal = useApi('getCalendar');
  const now = useNow();
  const d = profile.draft;
  const tz = d.timezone;
  const start = hhmmToMin(d.workingHours?.start ?? '');
  const end = hhmmToMin(d.workingHours?.end ?? '');
  const valid = Number.isFinite(start) && Number.isFinite(end) && end > start;
  const span = valid ? end - start : 1;
  const pct = (m: number) => ((Math.min(end, Math.max(start, m)) - start) / span) * 100;
  const today = fmtDay(now, tz);
  const events: CalendarEvent[] = (cal.data?.events ?? []).filter((e) => fmtDay(e.start, tz) === today && e.attendance !== 'cancelled');
  const nowMin = minutesIn(now, tz);
  const busy = events.filter((e) => e.attendance !== 'declined').map((e) => [minutesIn(e.start, tz), minutesIn(e.end, tz)] as const);
  // Free minutes left today inside working hours (meetings you didn't decline are busy).
  let free = 0;
  let longest: [number, number] | null = null;
  if (valid) {
    let t = Math.max(start, nowMin);
    const sorted = [...busy].sort((a, b) => a[0] - b[0]);
    for (const [a, b] of [...sorted, [end, end] as const]) {
      const gapEnd = Math.min(a, end);
      if (gapEnd > t) {
        free += gapEnd - t;
        if (!longest || gapEnd - t > longest[1] - longest[0]) longest = [t, gapEnd];
      }
      t = Math.max(t, b);
      if (t >= end) break;
    }
  }
  const next = (cal.data?.events ?? []).filter((e) => Date.parse(e.start) > now.getTime() && e.attendance !== 'declined' && e.attendance !== 'cancelled').sort((a, b) => a.start.localeCompare(b.start))[0];
  const mgrRule = policy.policy?.rules.find((r) => r.enabled && r.when.fromManager);
  // D-55: the persona and its level name the role pack (an AE's is "Specialist AE"); nothing role-specific while it loads
  const roleLabel = persona?.levelLabel ?? null;
  const ticks = valid ? Array.from({ length: Math.floor((end - start) / 120) + 1 }, (_, i) => Math.ceil(start / 120) * 120 + i * 120).filter((m) => m >= start && m <= end) : [];
  const abbr = zoneAbbrev(tz, now);

  return (
    <div className={s.ep} data-effect="profile">
      <Head title="Where these are used" sub={`Live from today, ${today}`} />
      <div className={s.epGrid}>
        <Card className={s.span2} title={valid ? `Your day spine · ${d.workingHours!.start}–${d.workingHours!.end} ${abbr}` : 'Your day spine'} right={!valid ? 'Fix the hours to see it' : nowMin >= end ? 'Workday over' : `${fmtMinutes(free)} free left`}>
          {cal.isLoading ? (
            <Skeleton variant="block" className="h-16 w-full" />
          ) : valid ? (
            <>
              <div className={s.spine} role="img" aria-label={`${events.length} meetings today between ${d.workingHours!.start} and ${d.workingHours!.end}`}>
                {events.map((e) => {
                  const a = minutesIn(e.start, tz);
                  const b = minutesIn(e.end, tz);
                  if (b <= start || a >= end) return null;
                  return <span key={e.id} className={cn(s.ev, e.attendance === 'declined' && s.declined)} style={{ left: `${pct(a)}%`, width: `calc(${pct(b) - pct(a)}% - 2px)` }} title={`${fmtClock(e.start, tz)} ${e.title}${e.attendance === 'declined' ? ' (declined)' : ''}`} />;
                })}
                {nowMin >= start && nowMin <= end ? <span className={s.nowLine} style={{ left: `${pct(nowMin)}%` }} title={`Now ${hhmm(nowMin)}`} /> : null}
              </div>
              <div className={s.ticks} aria-hidden>
                {ticks.map((m) => (
                  <span key={m} style={{ left: `${pct(m)}%` }}>
                    {hhmm(m)}
                  </span>
                ))}
              </div>
              <div className={s.legend}>
                <span>
                  <span className={s.legEv} />
                  Meeting
                </span>
                <span>
                  <span className={cn(s.legEv, s.declined)} />
                  Declined
                </span>
                <span>
                  <span className={s.legNow} />
                  Now {hhmm(nowMin)}
                  {nowMin > end ? ' · after hours' : nowMin < start ? ' · before hours' : ''}
                </span>
                {longest ? <span className={s.faint}>Free {hhmm(longest[0])}–{hhmm(longest[1])}</span> : null}
              </div>
            </>
          ) : (
            <p className={s.help}>Start must be before end, in 24-hour times.</p>
          )}
        </Card>
        <Card title="Role and manager">
          <div className={s.facts}>
            <Fact icon="person" k={roleLabel ? `${roleLabel} role pack` : 'Role pack'} v={policy.policy ? `Your policy is “${policy.policy.name}” v${policy.policy.version}. The role also decides what the agent treats as yours.` : 'Decides what the agent treats as yours.'} />
            <Fact icon="lines" k={d.managerName || 'No manager set'} v={d.managerName ? (mgrRule ? `Matches rule “${mgrRule.text}” (boost ${mgrRule.boost > 0 ? '+' : ''}${mgrRule.boost}).` : 'Feeds the “Manager ask” weight.') : 'The manager-asks rule and weight match nobody until you add one.'} />
            {profile.changed('role') && roleLabel ? <Fact icon="warn" k={`Switching to ${roleLabel}`} v="Saves your role. Your current policy and its edits stay as they are." /> : null}
          </div>
        </Card>
        <Card title="Time zone and days">
          <div className={s.facts}>
            <Fact icon="clock" k={`Every time shows in ${abbr}`} v={next ? `Next: ${fmtClock(next.start, tz)} ${next.title}, in ${fmtMinutes(Math.max(1, Math.round((Date.parse(next.start) - now.getTime()) / 60000)))}.` : 'No more meetings today.'} />
            <Fact icon="cal" k={daysLabel(d.workingHours?.days ?? [])} v="Focus time and the day spine use these days. Work due on other days still shows; it isn't planned into them." />
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Display ────────────────────────────────────────────────────────────────────────────────

function DisplayEffect() {
  const { display } = useSettingsModel();
  const live = useApi('previewPolicy', { body: {} });
  const rows = (live.data?.before ?? []).slice(0, 2);
  const label = { dark: 'Dark', light: 'Light', system: 'System' }[display.scheme];
  return (
    <div className={s.ep} data-effect="display">
      <Head title="Preview" sub={`Your top two rows at ${display.textSize} px, ${display.density}, ${label.toLowerCase()}`} badge={<span className={s.badge}>Applied</span>} />
      <div className={cn(s.sampleRows, display.density === 'compact' && s.compact)}>
        {rows.length
          ? rows.map((r) => (
              <div key={r.workItemId} className={s.srow}>
                <span className={s.st}>{r.title}</span>
                <span className={s.sa}>Open</span>
                <span className={s.sw}>{r.topReason ?? 'Ranked by your policy'}</span>
              </div>
            ))
          : [0, 1].map((i) => (
              <div key={i} className={s.srow}>
                <span className={s.st}>{live.isLoading ? <Skeleton variant="line" className="w-64" /> : 'Nothing ranked yet'}</span>
              </div>
            ))}
      </div>
      <Card title="Both themes" right={display.scheme === 'system' ? 'System picks one from macOS' : 'click one to switch'}>
        <div className={s.themes}>
          {(['dark', 'light'] as const).map((t) => {
            const top = rows[0];
            return (
              <button key={t} type="button" data-theme={t} className={s.themeCard} aria-pressed={display.scheme === t} onClick={() => display.set({ scheme: t })} data-testid={`theme-card-${t}`}>
                <span className={s.themeName}>
                  <span>{t === 'dark' ? 'Dark' : 'Light'}</span>
                  {display.scheme === t ? <span>✓ In use</span> : null}
                </span>
                <span className={s.themeRow}>{top?.title ?? 'Your #1 row'}</span>
                <span className={s.themeWhy}>
                  <span>{top?.topReason ?? 'Ranked by your policy'}</span>
                  <b>Open</b>
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      <Card title="Shortcuts cheat sheet" right="press ? anywhere">
        <div className={s.epGrid}>
          {/* The same table as the ? sheet (Anywhere, Go to, then the page groups); lists get the second column. */}
          {[cheatSheetGroups().filter((g) => g.id !== 'lists'), cheatSheetGroups().filter((g) => g.id === 'lists')].map((col, ci) => (
            <div key={ci} className={s.keys}>
              {col.map((g) => (
                <div key={g.id} style={{ display: 'contents' }}>
                  <h4>{g.title}</h4>
                  {g.items.map((it) => (
                    <div key={it.keys + it.label} style={{ display: 'contents' }}>
                      <span>{it.label}</span>
                      <span className={s.kk}>
                        <KbdHint combo={it.keys} />
                      </span>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ))}
        </div>
        {!display.shortcutsEnabled ? <p className={s.help}>Single-key shortcuts are off: only the ⌘ ones work.</p> : null}
      </Card>
    </div>
  );
}

// ── Thresholds ─────────────────────────────────────────────────────────────────────────────

function ThresholdsEffect() {
  const { thresholds } = useSettingsModel();
  const since = useApi('getSince');
  const d = thresholds.draft;
  const c = since.data?.counts;
  return (
    <div className={s.ep} data-effect="thresholds">
      <Head title="What these do" sub={since.data ? `Since you left at ${fmtClock(since.data.since)}, ${fmtDay(since.data.since)}` : 'Since you left'} />
      <div className={s.epGrid}>
        <Card title={c ? `${c.closed} item${c.closed === 1 ? '' : 's'} closed for you` : 'Closed for you'}>
          <p className={s.help}>{d.autoCloseMin === 'sure' ? 'Each needs “Sure” evidence: a reply you sent or a file you shared.' : 'Likely evidence is enough, so more items close on their own.'} Each shows its evidence and has Undo, in the rail’s “Closed for you” lane.</p>
        </Card>
        <Card title={`Reopen within ${d.reopenWindowDays} day${d.reopenWindowDays === 1 ? '' : 's'}`} right={c ? `${c.reopened} reopened` : undefined}>
          <p className={s.help}>A done item that gets a new requirement within {d.reopenWindowDays} days reopens and tells you why. Later than that, a new sibling item is created.</p>
        </Card>
        <Card title={`Merge at ${d.mergeScore.toFixed(2)}`}>
          <p className={s.help}>Two items at least this similar are offered as a merge, never merged silently. {d.mergeScore >= 0.9 ? 'This strict, you’ll see few offers.' : d.mergeScore < 0.75 ? 'This loose, expect more offers to dismiss.' : ''}</p>
        </Card>
        <Card title={d.snoozeWakeOnNewInfo ? 'Snoozes wake on anything new' : 'Snoozes wake on the timer'}>
          <p className={s.help}>{d.snoozeWakeOnNewInfo ? 'Any new message or file on a snoozed item brings it back.' : 'Or when someone asks you directly. New information alone doesn’t wake them.'}</p>
        </Card>
      </div>
      <p className={s.help}>These are kept on this Mac and apply to the next evaluation.</p>
    </div>
  );
}

// ── Closing work (SETTLE-1) ─────────────────────────────────────────────────────────────────

const CLOSING_WORD: Record<ClosingAction, [one: string, many: string]> = { close: ['closes for you', 'close for you'], ask: ['asks you in Triage', 'ask you in Triage'], leave: ['stays open', 'stay open'] };

function ClosingEffect() {
  const { closing } = useSettingsModel();
  const triage = useApi('getTriage');
  const d = closing.draft;
  const reasons = d.reasons ?? closing.saved.reasons;
  const closed = triage.data?.groups.find((g) => g.group === 'closed_for_you')?.items.length;
  const by = (a: ClosingAction) => ClosingReason.options.filter((r) => reasons?.[r] === a).map((r) => CLOSING_REASON_LABEL[r]);
  return (
    <div className={s.ep} data-effect="closing">
      <Head title="What closes for you" sub={d.enabled ? `Strictness: ${d.strictness ?? 'balanced'}` : 'Off: every finding asks you'} badge={closing.dirty ? <span className={s.badge}>Not saved</span> : null} />
      <div className={s.epGrid}>
        {(['close', 'ask', 'leave'] as const).map((a) => {
          const list = d.enabled || a !== 'close' ? by(a) : [];
          return (
            <Card key={a} title={list.length === 1 ? `1 reason ${CLOSING_WORD[a][0]}` : `${list.length} reasons ${CLOSING_WORD[a][1]}`}>
              <p className={s.help}>{list.length ? list.join(' · ') : 'None.'}</p>
            </Card>
          );
        })}
        <Card title={closed === undefined ? 'Closed for you' : `${closed} closed for you in the last 14 days`}>
          <p className={s.help}>
            Each shows its reason, the message that settled it and Undo, in Triage ▸ Closed for you.{' '}
            <AppLink className={s.linkBtn} href="/triage#closed_for_you">
              Review them
            </AppLink>
          </p>
        </Card>
      </div>
      <p className={s.help}>{d.askFirstExternalCommitments ? 'Commitments outside the company always ask first. ' : ''}Anything you reopen or keep is never closed for you again.</p>
    </div>
  );
}

// ── Agent behavior ─────────────────────────────────────────────────────────────────────────

function AgentEffect() {
  const { agent, sending } = useSettingsModel();
  const outbox = useApi('getOutbox');
  const a = (agent.autonomy.draft.autonomy ?? {}) as Record<string, AutonomyLevel>;
  const replies = a.slack_reply ?? a.email_reply ?? 'L1';
  const pending = outbox.data?.counts.pending_approval ?? 0;
  const dry = sending.draft.dryRun ?? true;
  return (
    <div className={s.ep} data-effect="agent">
      <Head title="What each level means" sub="Autonomy ladder, L0 to L4. The highlighted step is where replies stop." />
      <Card>
        <ol className={s.steps}>
          {AUTONOMY_LEVELS.map((l) => {
            const at = Object.entries(a)
              .filter(([, v]) => v === l.level)
              .map(([k]) => actionLabel(k));
            return (
              <li key={l.level} className={cn(l.level === replies && s.stop, l.level === 'L4' && !at.length && s.skip)}>
                <span className={s.stepN}>{l.level}</span>
                <span className={s.stepK}>
                  {l.label.replace(/^L\d /, '')}
                  {at.length ? ` · ${at.join(', ')}` : ''}
                </span>
                <span className={s.stepV}>{l.hint}</span>
              </li>
            );
          })}
        </ol>
      </Card>
      <Card title="Right now">
        <div className={s.facts}>
          <Fact k={outbox.isLoading ? 'Counting drafts…' : `${pending} draft${pending === 1 ? '' : 's'} wait in Outbox`} v={`Slack and email replies are at ${replies}, so each waits for you.`} />
          <Fact k={dry ? 'Dry run is on' : 'Dry run is off'} v={dry ? 'Even one-click approvals only render the payload.' : 'Approved messages really leave, after a preview and a confirm.'} />
          <Fact k="Every action is audited" v="Each send, write and auto action has an Undo in its receipt." />
        </div>
      </Card>
    </div>
  );
}

// ── Sending ────────────────────────────────────────────────────────────────────────────────

function SendingEffect() {
  const { sending } = useSettingsModel();
  const outbox = useApi('getOutbox');
  const d = sending.draft;
  const dry = d.dryRun ?? true;
  const undo = d.undoWindowSec ?? 10;
  const counts = outbox.data?.counts;
  const pending = counts?.pending_approval ?? 0;
  const slack = d.channels?.slack?.mode ?? 'draft';
  const gmail = d.channels?.gmail?.mode ?? 'draft';
  const verb = (m: string) => (m === 'send' ? 'sends' : 'goes to your drafts');
  const where = slack === gmail ? `Slack and Gmail: ${slack === 'send' ? 'it sends' : 'it goes to your drafts'}` : `Slack ${verb(slack)}; Gmail ${verb(gmail)}`;
  const anySend = slack === 'send' || gmail === 'send';
  const steps: Array<{ k: string; v: string; cls?: 'stop' | 'skip' }> = [
    { k: 'Preview the exact message', v: 'Slack or Gmail rendering, recipients and thread.' },
    { k: 'Confirm', v: `One click, with the verb on the button: ${slack === gmail ? `“${slack === 'send' ? 'Send reply' : 'Save as draft'}”` : '“Send reply” or “Save as draft”, per channel'}.` },
    dry ? { k: 'Dry run: render the payload, then stop', v: 'Nothing leaves this Mac, whatever each channel is set to. The Outbox row shows “Dry run ✓”.', cls: 'stop' } : { k: where, v: anySend ? 'Sent messages leave this Mac.' : 'Drafts wait in Slack or Gmail for you to send.' },
    { k: undo ? `${undo} s undo window first` : 'No undo window', v: dry ? 'Skipped while dry run is on.' : undo ? 'The toast waits; Undo cancels it.' : 'It executes right after the confirm.', cls: dry ? 'skip' : undefined },
    { k: d.verifyReadback ? 'Read back and mark “Verified”' : 'No read-back', v: dry ? 'Skipped while dry run is on.' : d.verifyReadback ? 'Read the message back and show “Verified” on the Outbox row.' : 'The Outbox row shows “Sent” without checking.', cls: dry || !d.verifyReadback ? 'skip' : undefined },
  ];
  return (
    <div className={s.ep} data-effect="sending">
      <Head title="When you approve a draft" sub={outbox.data ? `With these settings, for your ${pending} draft${pending === 1 ? '' : 's'} in Outbox` : 'With these settings'} badge={sending.dirty ? <span className={s.badge}>Not saved</span> : null} />
      <Card>
        <ol className={s.steps} data-testid="send-steps">
          {steps.map((st, i) => (
            <li key={st.k} className={cn(st.cls === 'stop' && s.stop, st.cls === 'skip' && s.skip)}>
              <span className={s.stepN}>{i + 1}</span>
              <span className={s.stepK}>{st.k}</span>
              <span className={s.stepV}>{st.v}</span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title="Outbox under this setting" right={outbox.data ? (outbox.data.dryRun ? 'dry run' : 'live send') : undefined}>
        {outbox.isLoading ? (
          <Skeleton variant="row" count={2} />
        ) : counts ? (
          <div className={s.split} style={{ gridTemplateColumns: 'minmax(0, 1fr) auto' }}>
            {(
              [
                ['Waiting for you', counts.pending_approval],
                ['Scheduled', counts.scheduled],
                ['Sent', counts.sent],
                ['Failed', counts.failed],
              ] as const
            ).map(([l, n]) => (
              <div key={l} style={{ display: 'contents' }}>
                <span className={l === 'Failed' && n ? s.danger : undefined}>{l}</span>
                <span className={s.v}>{n}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className={s.help}>Couldn’t load the Outbox.</p>
        )}
      </Card>
    </div>
  );
}

// ── Budgets ────────────────────────────────────────────────────────────────────────────────

const SCANNER: Record<string, string> = { nba: 'Next best actions', slack: 'Slack', briefs: 'Briefs', org62: 'Org62', chat: 'Chat', gmail: 'Gmail', drive: 'Drive', calendar: 'Calendar', gemini: 'Gemini notes', vdp: 'VDP', claude: 'Claude sessions' };
const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

function BudgetsEffect() {
  const { budgets } = useSettingsModel();
  const health = useApi('getHealth');
  const sp = health.data?.spend;
  const d = budgets.draft;
  const soft = Number.isFinite(d.softUsd) && (d.softUsd ?? 0) > 0 ? d.softUsd! : (budgets.saved.softUsd ?? 5);
  const hard = Number.isFinite(d.hardUsd) ? (d.hardUsd ?? soft) : soft;
  const chipAt = (soft * (Number.isFinite(d.alertPct) ? (d.alertPct ?? 80) : 80)) / 100;
  if (!sp) return <div className={s.ep}>{health.error ? <p className={s.help}>Couldn’t load spend.</p> : <Skeleton variant="block" className="h-40 w-full" />}</div>;
  const pct = Math.round((sp.today.usd / soft) * 100);
  const top = Math.max(soft, ...sp.last7d.map((x) => x.usd)) * 1.05;
  const overChip = sp.last7d.filter((x) => x.usd >= chipAt).length;
  const scanners = [...sp.byScanner].sort((a, b) => b.usd - a.usd);
  const maxScan = Math.max(0.01, ...scanners.map((x) => x.usd));
  return (
    <div className={s.ep} data-effect="budgets">
      <Head title="Spend against these limits" sub={`Updated ${fmtClock(new Date(health.dataUpdatedAt))}`} badge={budgets.dirty ? <span className={s.badge}>Not saved</span> : null} />
      <Card title={`Today: ${fmtUsd(sp.today.usd)} of ${fmtUsd(soft)}`} right={`${pct}% · chip at ${fmtUsd(chipAt)}`}>
        <div className={s.meter} role="meter" aria-valuemin={0} aria-valuemax={soft} aria-valuenow={sp.today.usd} aria-label="Today's spend against the soft budget">
          <i className={cn(sp.today.usd >= hard ? s.capped : sp.today.usd >= chipAt && s.over)} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
        {sp.today.usd >= hard ? <p className={cn(s.help, s.danger)}>At the hard cap: scans run on rules only (no AI) until tomorrow.</p> : null}
      </Card>
      <div className={s.epGrid}>
        <Card title="Last 7 days" right={overChip ? `${overChip} day${overChip === 1 ? '' : 's'} past the chip` : 'never near the soft budget'}>
          <div style={{ paddingTop: 20 }}>
            <div className={s.bars}>
              <div className={s.limit} style={{ bottom: `${(soft / top) * 100}%` }}>
                <span>{fmtUsd(soft)} soft</span>
              </div>
              {sp.last7d.map((x, i) => (
                <div key={x.day} className={cn(s.bar, i === sp.last7d.length - 1 && s.today)} style={{ height: `${(x.usd / top) * 100}%` }} title={`${x.day}: ${fmtUsd(x.usd)}`}>
                  <em>{x.usd.toFixed(2)}</em>
                </div>
              ))}
            </div>
            <div className={s.barX}>
              {sp.last7d.map((x, i) => (
                <span key={x.day}>{i === sp.last7d.length - 1 ? 'Today' : new Intl.DateTimeFormat('en-GB', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`${x.day}T12:00:00Z`))}</span>
              ))}
            </div>
          </div>
        </Card>
        <Card title="Today by scanner and model">
          <div className={s.split} style={{ marginTop: 12 }}>
            {scanners.map((x) => (
              <div key={x.name} style={{ display: 'contents' }}>
                <span>{SCANNER[x.name] ?? cap(x.name)}</span>
                <div className={cn(s.meter, s.thin)}>
                  <i style={{ width: `${(x.usd / maxScan) * 100}%` }} />
                </div>
                <span className={s.v}>{fmtUsd(x.usd)}</span>
              </div>
            ))}
            {sp.byModel.length ? (
              <>
                <span className={s.muted}>{sp.byModel.map((x) => cap(x.model)).join(' · ')}</span>
                <span className={cn(s.v, s.wide, s.muted)}>{sp.byModel.map((x) => fmtUsd(x.usd)).join(' · ')}</span>
              </>
            ) : null}
          </div>
        </Card>
      </div>
    </div>
  );
}

// ── Connectors ─────────────────────────────────────────────────────────────────────────────

function ConnectorsEffect({ selected }: { selected: string | null }) {
  const health = useApi('getHealth');
  const now = useNow();
  const a = useConnectorActions();
  const cs = sortConnectors(health.data?.connectors ?? []);
  const c: Connector | undefined = cs.find((x) => x.id === selected) ?? cs[0];
  if (!c) return <div className={s.ep}>{health.error ? <p className={s.help}>Couldn’t load connector health.</p> : <Skeleton variant="block" className="h-40 w-full" />}</div>;
  const broken = BROKEN.has(c.state);
  const others = cs.filter((x) => x.id !== c.id && BROKEN.has(x.state));
  const command = c.reauth?.command ?? null;
  return (
    <div className={s.ep} data-effect="connectors">
      <Head
        title={broken ? `${c.label} ${c.state === 'auth_needed' ? 'needs re-auth' : 'is broken'}` : `${c.label} is ${c.state === 'ok' ? 'live' : c.state.replace('_', ' ')}`}
        badge={
          broken ? (
            <span className={cn(s.badge, s.badgeDanger)}>
              <Glyph name="warn" className={s.attnIcon} />
              Since {fmtDay(c.since)}
            </span>
          ) : (
            <ConnectorStatus c={c} />
          )
        }
        sub={broken ? `${(c.lastError?.message ?? 'It stopped answering').replace(/\.?$/, '.')}${c.lastSuccessAt ? ` Last good data ${fmtDay(c.lastSuccessAt)}.` : ''}` : `Data through ${dataThrough(c, now)} · ${c.itemsToday} items today`}
      />
      {broken ? (
        <>
          <Card title="What it affects">
            <p className={s.help}>{c.impact ?? (c.affects.length ? `${c.affects.join(', ')} show a stale mark until it's fixed.` : 'Items from this source show a stale mark until it is fixed.')}</p>
          </Card>
          <Card title="Fix it" right={c.reauth?.instructions ?? undefined}>
            {command ? <code className={s.cmd}>{command}</code> : null}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="primary" loading={a.reauth.isPending} onClick={() => a.reauth.mutate(c)}>
                {c.reauth?.label ?? `Re-auth ${c.label}`}
              </Button>
              {command ? (
                <Button
                  variant="secondary"
                  onClick={async () => {
                    const ok = await copyText(command);
                    toast({ key: `copy-${c.id}`, tone: ok ? 'success' : 'error', title: ok ? 'Command copied' : "Couldn't copy", body: ok ? `Paste it into Terminal to re-auth ${c.label}.` : undefined });
                  }}
                >
                  Copy command
                </Button>
              ) : null}
            </div>
          </Card>
        </>
      ) : (
        <Card title="Scan">
          <p className={s.help}>Scans run on their own schedule. Scan now reads the newest {c.label} data with read tools only.</p>
          <div className="mt-3">
            <Button variant="secondary" loading={a.scan.isPending} onClick={() => a.scan.mutate(c)}>
              Scan {c.label} now
            </Button>
          </div>
        </Card>
      )}
      {others.length ? (
        <Card title="Also needs you">
          <div className={s.facts}>
            {others.map((o) => (
              <Fact key={o.id} dot="danger" k={o.label} v={o.lastError?.message ?? o.state.replace('_', ' ')} />
            ))}
          </div>
        </Card>
      ) : null}
      <Card title="Read tools only">
        <p className={s.help}>Every connector goes through an allowlist of read tools. Nothing here can post, send or write.</p>
      </Card>
    </div>
  );
}

// ── Watches ────────────────────────────────────────────────────────────────────────────────

function WatchesEffect() {
  const { watches, budgets } = useSettingsModel();
  const briefs = useApi('getBriefs');
  const health = useApi('getHealth');
  const on = watches.rows.filter((w) => w.enabled);
  const briefUsd = health.data?.spend.byScanner.find((x) => x.name === 'briefs')?.usd ?? null;
  const per = briefUsd !== null && on.length ? briefUsd / on.length : null;
  const added = watches.adds.length;
  const paused = Object.values(watches.edits).filter((e) => e.enabled === false).length;
  return (
    <div className={s.ep} data-effect="watches">
      <Head title="What these watches produced" sub={on.length ? `${on.length} on · ${[...new Set(on.map((w) => cadenceText(w.cadence)))].join(', ')}` : 'No watches on'} />
      <Card>
        {briefs.isLoading ? (
          <Skeleton variant="row" count={2} />
        ) : (briefs.data?.watched ?? []).length ? (
          <div className={s.facts}>
            {(briefs.data?.watched ?? []).map((b) => (
              <Fact key={b.id} k={`${b.title} · ${b.worthALook} worth a look`} v={b.status === 'ready' ? `Through ${fmtClock(b.through)}, ${fmtDay(b.through)}${b.unread ? ' · unread' : ''}` : b.status === 'generating' ? 'Generating…' : 'The last run failed. It retries on the next cadence.'} />
            ))}
          </div>
        ) : (
          <p className={s.help}>No briefs yet. The first one arrives on the next run.</p>
        )}
      </Card>
      <Card title="Cost">
        <p className={s.help}>
          {briefUsd !== null ? `Briefs used ${fmtUsd(briefUsd)} today${per ? `, about ${fmtUsd(per)} per watch` : ''}. ` : ''}
          {added || paused ? `Your unsaved changes add ${added} and pause ${paused}, against a ${fmtUsd(budgets.saved.softUsd ?? 5)} daily soft budget.` : 'Each new daily watch adds roughly the same.'}
        </p>
      </Card>
    </div>
  );
}

export function EffectPane({ section, connector }: { section: SectionId; connector: string | null }) {
  switch (section) {
    case 'profile':
      return <ProfileEffect />;
    case 'display':
      return <DisplayEffect />;
    case 'thresholds':
      return <ThresholdsEffect />;
    case 'closing':
      return <ClosingEffect />;
    case 'agent':
      return <AgentEffect />;
    case 'sending':
      return <SendingEffect />;
    case 'budgets':
      return <BudgetsEffect />;
    case 'connectors':
      return <ConnectorsEffect selected={connector} />;
    case 'watches':
      return <WatchesEffect />;
    default:
      return null;
  }
}
