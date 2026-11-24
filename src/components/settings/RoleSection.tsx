'use client';
/**
 * Settings ▸ Role & rules (D-55). A persona PRECONFIGURES what is active for your role and never takes anything away:
 * whatever is outside the preset is "available, not in your role's preconfiguration" and can be activated for you.
 *
 *   Role           Solutions Engineer | Specialist AE (Preview), and the level when the persona has more than one
 *   Duties         the role's active duties, cadence as a quiet chip
 *   Rules          the preset's rules (toggle, reword, Reset to preset), then your own (add, edit, toggle, delete)
 *   Thresholds     the numbers the rules use, by unit, with the preset default and Reset
 *   Features & sources, then "Available · Not in your role's preconfiguration"
 *
 * One explicit Save (the section stores only changes to the preset, role.ts) with an Undo toast. Everything shown is
 * `personaOf` of the draft, so what you see is what the server will resolve. Agent behavior's old task list is carried
 * in as your own rules the first time this opens (state.tsx `carry`).
 */
import { useEffect, useRef, useState } from 'react';
import type { PersonaFeature, PersonaLevel } from '@/contract';
import { useApi } from '@/client/hooks';
import { loggingProfile } from '@/engines/activity/persona';
import { fillThresholds, personaOf, roleTitle, selectablePersonas, type PersonaThreshold, type ResolvedPersona } from '@/personas';
import type { ConnectorId } from '@/scanner/types';
import { Button, cn, SegmentedToggle, Skeleton } from '@/ui';
import { Check, Glyph, MiniButton, NumberInput, Select, TextInput } from './controls';
import { same } from './derive';
import { Block, Row, SaveActions, SaveFeedback, Section } from './form';
import {
  addCustomRule,
  CADENCE_LABEL,
  CONNECTOR_LABEL,
  CUSTOM_RULES_MAX,
  definitionOf,
  editCustomRule,
  FEATURE_HELP,
  FEATURE_LABEL,
  featureInPreset,
  featuresAndSources,
  PERSONA_KEYS,
  personaErrors,
  removeCustomRule,
  resetRule,
  resetThreshold,
  RULE_TEXT_MAX,
  setFeature,
  setLevel,
  setRule,
  setSource,
  setThreshold,
  sourceInPreset,
  switchPersona,
  thresholdText,
  visibleThresholds,
  WEEKDAYS,
  type PersonaDraft,
} from './role';
import { useSettingsModel } from './state';
import s from './settings.module.css';

const Loading = () => <Skeleton variant="block" className="mt-6 h-64 w-full" />;

const AVAILABLE_LABEL = "Available · Not in your role's preconfiguration";

const ORG62_SCOPE_LABEL: Record<string, string> = { opps: 'opportunities', events: 'events', dcs: 'deal contributions', book: 'my book', missed_opps: 'missed opps' };

/**
 * A rule's words: thresholds filled in while you read it, the raw text (with its {placeholders}) while you edit.
 * The edit keeps its own text, so a trailing space or a wording that briefly matches the preset never jumps back.
 */
function RuleText({ text, filled, label, disabled, invalid, onText, testId }: { text: string; filled: string; label: string; disabled?: boolean; invalid?: boolean; onText: (t: string) => void; testId?: string }) {
  const [editing, setEditing] = useState<{ start: string; value: string } | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) ref.current?.focus();
  }, [editing]);
  if (editing) {
    return (
      <input
        ref={ref}
        className={s.ruleText}
        aria-label={label}
        aria-invalid={invalid}
        maxLength={RULE_TEXT_MAX}
        value={editing.value}
        onChange={(e) => {
          setEditing({ ...editing, value: e.target.value });
          onText(e.target.value);
        }}
        onBlur={() => setEditing(null)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onText(editing.start);
            setEditing(null);
          }
        }}
        data-testid={testId}
      />
    );
  }
  return (
    <button type="button" className={cn(s.ruleText, 'text-left')} disabled={disabled} aria-label={`${label}: ${filled}. Edit`} title={disabled ? undefined : 'Click to edit'} onClick={() => setEditing({ start: text, value: text })} data-testid={testId}>
      {filled}
    </button>
  );
}

/** A text threshold: its own text while focused (same reason as RuleText). */
function TextThreshold({ id, value, invalid, onValue }: { id: string; value: string; invalid: boolean; onValue: (v: string) => void }) {
  const [local, setLocal] = useState<string | null>(null);
  return (
    <textarea
      id={id}
      rows={3}
      className={s.in}
      aria-invalid={invalid}
      value={local ?? value}
      onFocus={() => setLocal(value)}
      onBlur={() => setLocal(null)}
      onChange={(e) => {
        setLocal(e.target.value);
        onValue(e.target.value);
      }}
    />
  );
}

function ThresholdControl({ t, id, value, invalid, onValue }: { t: PersonaThreshold; id: string; value: number | string; invalid: boolean; onValue: (v: number | string) => void }) {
  const n = typeof value === 'number' ? value : Number(value);
  switch (t.unit) {
    case 'usd':
      return (
        <>
          <span className={s.unit}>$</span>
          <NumberInput id={id} width={128} min={t.min} max={t.max} step={Number(t.default) >= 1000 ? 1000 : 1} value={n} onValue={onValue} aria-invalid={invalid} />
        </>
      );
    case 'days':
    case 'hours':
      return (
        <>
          <NumberInput id={id} width={88} min={t.min} max={t.max} step={1} value={n} onValue={onValue} aria-invalid={invalid} />
          <span className={s.unit}>{t.unit === 'days' ? (n === 1 ? 'day' : 'days') : n === 1 ? 'hour' : 'hours'}</span>
        </>
      );
    case 'weekday':
      return (
        <Select id={id} value={String(n)} onChange={(e) => onValue(Number(e.target.value))} aria-invalid={invalid}>
          {WEEKDAYS.map((w, i) => (
            <option key={w} value={i}>
              {w}
            </option>
          ))}
        </Select>
      );
    case 'hhmm':
      return <TextInput id={id} type="time" width="sm" value={String(value)} onChange={(e) => onValue(e.target.value)} aria-invalid={invalid} />;
    case 'text':
      return <TextThreshold id={id} value={String(value)} invalid={invalid} onValue={onValue} />;
  }
}

function featureHelp(f: PersonaFeature, on: boolean, inPreset: boolean): string {
  const own = FEATURE_HELP[f];
  if (on && !inPreset) return `${own} Activated by you.`;
  if (!on && inPreset) return `${own} In your role’s preconfiguration; you deactivated it.`;
  return own;
}

function sourceHelp(on: boolean, inPreset: boolean): string {
  if (on) return inPreset ? 'Read by the scanners.' : 'Read by the scanners. Activated by you.';
  return inPreset ? 'In your role’s preconfiguration; you deactivated it.' : 'Not read for you now.';
}

export function RoleSection() {
  const f = useSettingsModel().role;
  const settings = useApi('getSettings');
  const profile = settings.data?.profile;
  const [adding, setAdding] = useState('');
  const [addNote, setAddNote] = useState<string | null>(null);
  const { carry } = f;
  // Agent behavior's own task entries come in as your rules (once; guarded in the model).
  useEffect(() => {
    carry();
  }, [carry]);

  const header = { id: 'role' as const, title: 'Role & rules', meta: 'Your role preconfigures what is active: duties, rules, thresholds, features and sources. It never takes anything away; anything outside it stays available to activate for you.' };
  if (!f.server) {
    return (
      <Section {...header} guide="role-header">
        <Loading />
      </Section>
    );
  }

  const d = f.draft as PersonaDraft;
  const saved = f.saved as PersonaDraft;
  const def = definitionOf(d.id);
  const p = personaOf({ persona: d, profile });
  const was = personaOf({ persona: saved, profile });
  const errors = personaErrors(d);
  const hasErr = Object.keys(errors).length > 0;
  const update = (next: PersonaDraft) => {
    for (const k of PERSONA_KEYS) if (!same(next[k], d[k])) f.set(k, next[k] as never);
  };

  const switching = d.id !== saved.id;
  const levels = Object.entries(def.levels) as Array<[PersonaLevel, { label: string }]>;
  const duties = p.duties.filter((x) => x.active);
  const preset = p.rules.filter((r) => !r.custom);
  const custom = d.customRules ?? [];
  const thresholds = visibleThresholds(def, p);
  const fs = featuresAndSources(p);
  const carriedIds = new Set(f.carried?.ids ?? []);
  const carriedHere = custom.filter((r) => carriedIds.has(r.id)).length;
  const full = custom.length >= CUSTOM_RULES_MAX;

  const featureRow = (ft: PersonaFeature) => {
    const on = p.features[ft];
    return (
      <Row key={`f-${ft}`} label={FEATURE_LABEL[ft]} labelId={`l-r-f-${ft}`} help={featureHelp(ft, on, featureInPreset(def, ft))} edited={on !== was.features[ft]} labelExtra={<span className={s.cond}>Feature</span>} testId={`role-feature-${ft}`}>
        <Button size="sm" variant="secondary" aria-label={`${on ? 'Deactivate' : 'Activate'} ${FEATURE_LABEL[ft]}`} onClick={() => update(setFeature(d, ft, !on))} data-testid={`role-feature-${ft}-toggle`}>
          {on ? 'Deactivate' : 'Activate'}
        </Button>
      </Row>
    );
  };
  const sourceRow = (c: ConnectorId) => {
    const on = p.connectors.includes(c);
    return (
      <Row key={`c-${c}`} label={CONNECTOR_LABEL[c]} labelId={`l-r-c-${c}`} help={sourceHelp(on, sourceInPreset(def, c))} edited={on !== was.connectors.includes(c)} labelExtra={<span className={s.cond}>Source</span>} testId={`role-source-${c}`}>
        <Button size="sm" variant="secondary" aria-label={`${on ? 'Deactivate' : 'Activate'} ${CONNECTOR_LABEL[c]}`} onClick={() => update(setSource(d, c, !on))} data-testid={`role-source-${c}-toggle`}>
          {on ? 'Deactivate' : 'Activate'}
        </Button>
      </Row>
    );
  };

  return (
    <Section
      {...header}
      guide="role-header"
      actions={<SaveActions dirty={f.dirty} onSave={() => void f.save()} onDiscard={f.discard} mutation={f.mutation} savedAt={f.savedAt} saveDisabled={hasErr} testId="save-role" />}
      feedback={
        <>
          {carriedHere ? (
            <p role="status" className="text-body text-fg" data-testid="role-carried">
              Carried over {carriedHere === 1 ? '1 rule' : `${carriedHere} rules`} from Autonomy. Save to keep {carriedHere === 1 ? 'it' : 'them'}.
            </p>
          ) : null}
          <SaveFeedback mutation={f.mutation} />
        </>
      }
    >
      <Block id="b-r-role" title="Role">
        <Row label="Role" labelId="l-r-persona" top help="What you do at work. It preconfigures everything below." edited={switching}>
          <div className={`${s.ctrl} ${s.stack}`}>
            <div className={s.themes} role="group" aria-labelledby="l-r-persona">
              {selectablePersonas().map((x) => (
                <button key={x.id} type="button" className={s.themeCard} aria-pressed={d.id === x.id} onClick={() => update(switchPersona(d, x.id))} data-testid={`role-persona-${x.id}`}>
                  <span className={s.themeName}>
                    <span>{x.id === saved.id ? 'Your role now' : ''}</span>
                    {x.status === 'preview' ? <span className={s.badge}>Preview</span> : null}
                  </span>
                  <span className={s.themeRow}>{x.label}</span>
                  <span className={cn(s.help, 'block')}>{x.summary}</span>
                </button>
              ))}
            </div>
            {switching ? (
              <p role="status" className="text-body text-fg" data-testid="role-switch-note">
                When you save, your priority policy starts a new version from the {def.label} starter (Undo puts the current one back), and the next scans follow the new role. Nothing is deleted: anything outside the new role stays available to activate.
              </p>
            ) : null}
          </div>
        </Row>
        {levels.length > 1 ? (
          <Row label="Level" labelId="l-r-level" help={d.level === null ? 'From your setup. Pick the other level here to change it.' : 'Set here.'} edited={p.level !== was.level || d.level !== saved.level}>
            <SegmentedToggle size="md" label="Level" value={p.level} onChange={(v) => update(setLevel(d, v, profile))} options={levels.map(([lv, x]) => ({ value: lv, label: x.label }))} />
          </Row>
        ) : null}
      </Block>

      <Block id="b-r-duties" title="Duties" help="What your role has to do. A duty whose feature is not active is left out.">
        <Row label="Active duties" top help={`${duties.length} for ${p.levelLabel}.`}>
          <div className={s.listEdit} aria-label="Active duties" data-testid="role-duties">
            {duties.map((x) => (
              <div key={x.id} className={s.li}>
                <span className="min-w-0 flex-1">{x.text}</span>
                {x.cadence ? <span className={s.cond}>{CADENCE_LABEL[x.cadence]}</span> : null}
              </div>
            ))}
            {duties.length === 0 ? <p className={s.help}>No active duties.</p> : null}
          </div>
        </Row>
      </Block>

      <Block id="b-r-rules" title="Rules" help="What counts as work, in order. The scanners, Home and the Assistant follow them. Click a rule to reword it.">
        <table className={s.tbl} aria-label="Your role’s rules" data-testid="role-rules">
          <thead>
            <tr>
              <th style={{ width: 48 }}>On</th>
              <th>Rule</th>
              <th style={{ width: 140 }}>
                <span className={s.srOnly}>Reset</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {preset.map((r, i) => {
              const base = def.rules.find((x) => x.id === r.id);
              const o = d.rules?.[r.id];
              const on = o?.enabled ?? base?.enabled ?? true;
              const inactive = !!r.feature && !p.features[r.feature];
              const changed = !same(o, saved.rules?.[r.id]);
              const err = errors[`rule:${r.id}`];
              const filled = fillThresholds(r.text, p.thresholds);
              return (
                <tr key={r.id} data-rule={r.id} className={cn((!on || inactive) && s.off, changed && s.changed)}>
                  <td>
                    <Check checked={on && !inactive} disabled={inactive} onChange={(v) => update(setRule(d, r.id, { enabled: v }))} label={`Rule on: ${filled}`} />
                  </td>
                  <td>
                    <RuleText text={o?.text ?? base?.text ?? r.text} filled={filled} label={`Rule ${i + 1}`} disabled={inactive} invalid={!!err} onText={(t) => update(setRule(d, r.id, { text: t }))} testId={`role-rule-${r.id}`} />
                    {inactive && r.feature ? <p className={s.help}>Its feature, {FEATURE_LABEL[r.feature]}, is not active. Activate it under Available below.</p> : null}
                    {err ? (
                      <p className={cn(s.help, s.helpErr)} role="alert">
                        {err}
                      </p>
                    ) : null}
                  </td>
                  <td className={s.r}>
                    {o ? (
                      <button type="button" className={s.linkBtn} onClick={() => update(resetRule(d, r.id))} data-testid={`role-rule-reset-${r.id}`}>
                        Reset to preset
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Block>

      <Block id="b-r-own" title="Your rules" help={`Rules of your own, after the role’s.${def.thresholds[0] ? ` You can name a threshold, like {${def.thresholds[0].key}}.` : ''}`}>
        <table className={s.tbl} aria-label="Your rules" data-testid="role-custom-rules">
          <thead>
            <tr>
              <th style={{ width: 48 }}>On</th>
              <th>Rule</th>
              <th style={{ width: 44 }}>
                <span className={s.srOnly}>Delete</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {custom.length === 0 ? (
              <tr>
                <td colSpan={3} className={s.muted}>
                  None yet. Add one below, like “Asks from my RVP about a forecast are tasks due the same day”.
                </td>
              </tr>
            ) : null}
            {custom.map((r, i) => {
              const before = saved.customRules?.find((x) => x.id === r.id);
              const changed = !before || !same(before, r);
              const err = errors[`custom:${r.id}`];
              return (
                <tr key={r.id} data-rule={`custom:${r.id}`} className={cn(!r.enabled && s.off, changed && s.changed)}>
                  <td>
                    <Check checked={r.enabled} onChange={(v) => update(editCustomRule(d, r.id, { enabled: v }))} label={`Rule on: ${r.text}`} />
                  </td>
                  <td>
                    <RuleText text={r.text} filled={fillThresholds(r.text, p.thresholds)} label={`Your rule ${i + 1}`} invalid={!!err} onText={(t) => update(editCustomRule(d, r.id, { text: t }))} testId={`role-custom-${r.id}`} />
                    {carriedIds.has(r.id) ? <p className={s.help}>From Autonomy ▸ What counts as a task.</p> : null}
                    {err ? (
                      <p className={cn(s.help, s.helpErr)} role="alert">
                        {err}
                      </p>
                    ) : null}
                  </td>
                  <td>
                    <MiniButton label={`Delete rule: ${r.text || 'empty'}`} className={s.rowX} onClick={() => update(removeCustomRule(d, r.id))}>
                      <Glyph name="close" />
                    </MiniButton>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={3}>
                <form
                  className={s.addRow}
                  onSubmit={(e) => {
                    e.preventDefault();
                    const next = addCustomRule(d, adding);
                    if (next === d) {
                      setAddNote(adding.trim() ? 'You already have that rule.' : null);
                      return;
                    }
                    update(next);
                    setAdding('');
                    setAddNote(null);
                  }}
                >
                  <TextInput width="full" style={{ flex: '1 1 280px', width: 'auto' }} aria-label="New rule" placeholder="A rule of your own, in plain words" maxLength={RULE_TEXT_MAX} value={adding} disabled={full} onChange={(e) => (setAdding(e.target.value), setAddNote(null))} data-testid="role-custom-new" />
                  <Button type="submit" variant="secondary" disabled={!adding.trim() || full}>
                    Add rule
                  </Button>
                </form>
                {addNote ? <p className={s.help}>{addNote}</p> : null}
                {full ? <p className={s.help}>{CUSTOM_RULES_MAX} is the most this list holds.</p> : null}
              </td>
            </tr>
          </tfoot>
        </table>
      </Block>

      {thresholds.length ? (
        <Block id="b-r-thresholds" title="Thresholds" help="The numbers your rules use. Only what differs from the preset is saved.">
          {thresholds.map((t) => {
            const v = d.thresholds?.[t.key] ?? t.default;
            const own = t.key in (d.thresholds ?? {});
            const err = errors[`threshold:${t.key}`];
            return (
              <Row
                key={t.key}
                label={t.label}
                htmlFor={`r-th-${t.key}`}
                top={t.unit === 'text'}
                help={`Preset: ${thresholdText(t, t.default)}`}
                error={err}
                edited={!same(d.thresholds?.[t.key], saved.thresholds?.[t.key])}
                testId={`role-threshold-${t.key}`}
                labelExtra={
                  own ? (
                    <button type="button" className={s.linkBtn} onClick={() => update(resetThreshold(d, t.key))} aria-label={`Reset ${t.label} to the preset`}>
                      Reset
                    </button>
                  ) : null
                }
              >
                <ThresholdControl t={t} id={`r-th-${t.key}`} value={v} invalid={!!err} onValue={(nv) => update(setThreshold(d, t.key, nv))} />
              </Row>
            );
          })}
        </Block>
      ) : null}

      <Block id="b-r-features" title="Features & sources" help="Active for you. Deactivating one takes its pages, Home rows and scans away until you activate it again; nothing is deleted.">
        {fs.activeFeatures.map(featureRow)}
        {fs.activeSources.map(sourceRow)}
        {fs.activeFeatures.length + fs.activeSources.length === 0 ? <p className={cn(s.help, 'py-3')}>Nothing is active.</p> : null}
      </Block>

      <Block id="b-r-available" title={AVAILABLE_LABEL} help="Activate any of these for yourself.">
        {fs.availableFeatures.map(featureRow)}
        {fs.availableSources.map(sourceRow)}
        {fs.availableFeatures.length + fs.availableSources.length === 0 ? <p className={cn(s.help, 'py-3')}>Everything is active.</p> : null}
      </Block>
    </Section>
  );
}

function Fact({ k, v }: { k: string; v: string }) {
  return (
    <div className={s.fact}>
      <span className={s.factDot} aria-hidden />
      <span className={s.factK}>{k}</span>
      <span className={s.factV}>{v}</span>
    </div>
  );
}

function list(xs: string[]): string {
  return xs.length <= 1 ? (xs[0] ?? 'none') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function loggingLine(p: ResolvedPersona): string {
  if (!p.features.activityLogging) return 'Activity logging is not active: nothing is proposed for Org62.';
  const l = loggingProfile(p);
  // the record type's name is singular for an SE ("Solutions Event"), plural for an AE ("Sales Events")
  const events = /s$/i.test(l.recordTypeName) ? l.recordTypeName : `${l.recordTypeName}s`;
  return `Customer meetings are logged in Org62 as ${events}${l.taskTypeRequired ? ', each with an SE task type' : ''}${l.hoursTargetH ? `, toward ${l.hoursTargetH} h a quarter` : ''}.`;
}

/** The effect pane: what follows the role, from the draft (the same `personaOf` the server runs). */
export function RoleEffect() {
  const f = useSettingsModel().role;
  const settings = useApi('getSettings');
  if (!f.server) return null;
  const profile = settings.data?.profile;
  const p = personaOf({ persona: f.draft, profile });
  const was = personaOf({ persona: f.saved, profile });
  const on = p.rules.filter((r) => r.enabled).length;
  const book = p.org62Book === 'team_member' ? 'opportunity teams I am on' : p.org62Book === 'owner' ? 'opportunities I own' : 'opportunities I own or am on the team of';
  return (
    <div className={s.ep} data-effect="role" data-testid="role-effect">
      <div>
        <div className={s.kicker}>
          <h2>What follows your role</h2>
          {f.dirty ? <span className={s.badge}>Not saved</span> : null}
        </div>
        <p className={s.sub}>
          {roleTitle(p)}{p.status === 'preview' ? ' · Preview' : ''}
        </p>
      </div>
      <div className={s.card}>
        <div className={s.facts}>
          <Fact k="Scanners" v={`Read ${list(p.connectors.map((c) => CONNECTOR_LABEL[c]))}. In Org62: ${list(p.org62Scopes.map((x) => ORG62_SCOPE_LABEL[x] ?? x))} (my book: ${book}).`} />
          <Fact k="Home ▸ Log & fix" v="Shows the rows your role’s duties need; an inactive feature’s rows stay away." />
          <Fact k="Time" v={loggingLine(p)} />
          <Fact k="The Assistant and the prompts" v={`Know you as ${p.preamble}, with ${on} rule${on === 1 ? '' : 's'} on.`} />
          {p.id !== was.id ? <Fact k="Priority policy" v="On Save it starts a new version from this role’s starter. Undo puts the current one back." /> : null}
        </div>
      </div>
      <p className={s.help}>A role preconfigures; it never takes anything away. What it leaves out stays available to activate in this section.</p>
    </div>
  );
}
