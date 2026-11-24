import type { ResolvedPersona } from '../../../personas/types';
import { cutHead } from '../../prompt-cut';
import { nbaVerbAllowed } from './verbs';
import { fitToBudget, hashInputs, type BudgetReport, type Section, type Unit } from './budget';
import { ageDays, clean, localStamp, minutesBetween, person } from './render';
import { redactSecrets } from './redact';
import { nbaOutputSchema } from './schema';
import { loadSkill, type Skill } from './skills';
import { docToPlainText } from './tiptap';
import type { EvidenceEntry, NbaInput } from './types';
import { modelFor, VERB_SPECS, type ModelTier } from './verbs';

export interface BuiltPrompt {
  system: string;
  user: string;
  model: string;
  maxOutputTokens: number;
  skills: Array<{ name: string; version: string }>;
  /** Stored as next_best_actions.prompt_version. */
  promptVersion: string;
  /** Stored as next_best_actions.inputs_hash; same hash = no regeneration. */
  inputsHash: string;
  budget: BudgetReport;
}

export interface BuildOptions {
  skillsDir?: string;
  tier?: ModelTier;
  /** D-55: the user's persona; a verb it has no active feature for is refused (see nbaVerbAllowed). */
  persona?: ResolvedPersona;
  /** Override the verb's context budget (tokens). */
  contextBudgetTokens?: number;
}

const ROLE_PRIORITY: Record<EvidenceEntry['role'], 1 | 2 | 3> = {
  origin: 1,
  contradiction: 1,
  completion: 2,
  progress: 2,
  context: 3,
};

function evidenceUnits(input: NbaInput): Unit[] {
  const tz = input.user.tz;
  const sorted = [...input.evidence].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.map((e, i) => {
    const pr = e.isNew ? 1 : ROLE_PRIORITY[e.role];
    const where = e.where ? ` · ${clean(e.where, 80)}` : '';
    const title = e.title ? ` · "${clean(e.title, 120)}"` : '';
    const link = e.permalink ? `\n  link: ${e.permalink}` : '';
    return {
      label: e.id,
      priority: pr,
      order: i,
      trimTo: pr === 1 ? 900 : 450,
      text: `[${e.id}] ${localStamp(e.at, tz)} · ${e.source}${where} · ${e.role}${e.isNew ? ' · NEW' : ''} · ${person(e.author)}${title}: ${clean(e.excerpt, 1500)}${link}`,
    } satisfies Unit;
  });
}

function workItemUnits(input: NbaInput): Unit[] {
  const w = input.workItem;
  const lines: string[] = [
    `id: ${w.id}`,
    `kind: ${w.kind}${w.isBackground ? ' (background promise)' : ''}`,
    `title: ${clean(w.title, 200)}`,
  ];
  if (w.purpose) lines.push(`purpose: ${clean(w.purpose, 240)}`);
  lines.push(`state: ${w.state}`);
  lines.push(`created: ${localStamp(w.createdAt, input.user.tz)} (${ageDays(w.createdAt, input.now)} days ago)`);
  if (w.due) lines.push(`due: ${localStamp(w.due, input.user.tz)}`);
  if (w.promisedTo) lines.push(`promised to: ${person(w.promisedTo)}`);
  if (w.askedBy) lines.push(`asked by: ${person(w.askedBy)}`);
  if (w.account) lines.push(`account: ${w.account.name} [${w.account.id}]`);
  if (w.opportunity) {
    const o = w.opportunity;
    const bits = [o.stage && `stage ${o.stage}`, o.closeDate && `close ${o.closeDate}`, o.amount != null && `amount ${o.amount}`].filter(Boolean);
    lines.push(`opportunity: ${o.name} [${o.id}]${bits.length ? ` (${bits.join(', ')})` : ''}`);
  }
  if (w.people?.length) lines.push(`people: ${w.people.map(person).join('; ')}`);
  if (w.effort) lines.push(`effort estimate: you ${w.effort.youMin ?? '?'}m · agent ${w.effort.agentMin ?? '?'}m`);
  if (w.expected) {
    const ex = w.expected;
    lines.push(`deliverable: ${ex.fileTitle ?? ex.fileId ?? 'unknown file'}${ex.changes?.length ? `; requested changes: ${ex.changes.map((c) => clean(c, 160)).join(' | ')}` : ''}`);
  }
  if (w.tags?.length) lines.push(`tags: ${w.tags.join(', ')}`);
  return [{ label: 'work_item', priority: 0, text: lines.join('\n') }];
}

function initiativeUnits(input: NbaInput): Unit[] {
  const i = input.initiative;
  if (!i) return [];
  const units: Unit[] = [
    {
      label: 'initiative',
      priority: 2,
      trimTo: 500,
      text: `${i.title} [${i.id}]${i.purpose ? ` — ${clean(i.purpose, 200)}` : ''}${i.summary ? `\nsummary: ${clean(i.summary, 900)}` : ''}`,
    },
  ];
  if (i.assets?.length)
    units.push({
      label: 'assets',
      priority: 2,
      text: `assets:\n${cutHead('nba.assets', i.assets, 12).map((a) => `- ${a.kind}: ${clean(a.label, 100)} → ${a.ref}`).join('\n')}`,
    });
  if (i.siblings?.length)
    units.push({
      label: 'siblings',
      priority: 4,
      text: `sibling tasks: ${cutHead('nba.siblings', i.siblings, 10).map((s) => `${clean(s.title, 80)} (${s.state})`).join('; ')}`,
    });
  return units;
}

function calendarUnits(input: NbaInput): Unit[] {
  const c = input.calendar;
  if (!c) return [];
  const tz = input.user.tz;
  const units: Unit[] = [];
  if (c.workingHours) units.push({ label: 'hours', priority: 2, text: `working hours: ${c.workingHours.start}–${c.workingHours.end} (${c.tz})` });
  (c.upcoming ?? []).forEach((e, idx) => {
    const inH = minutesBetween(input.now, e.start) / 60;
    const pr = e.servesItem ? 1 : inH <= 24 ? 2 : inH <= 72 ? 3 : 4;
    const flags = [e.servesItem && 'SERVES THIS ITEM', e.external && 'external', e.attendees != null && `${e.attendees} attendees`, e.attended === false && 'MISSED', e.attended === true && 'attended']
      .filter(Boolean)
      .join(', ');
    units.push({
      label: e.id,
      priority: pr as Unit['priority'],
      order: -idx,
      text: `[${e.id}] ${localStamp(e.start, tz)} → ${localStamp(e.end, tz).split(' ').slice(2, 3).join('')} · ${clean(e.title, 120)}${flags ? ` (${flags})` : ''}`,
    });
  });
  (c.gaps ?? []).forEach((g, idx) =>
    units.push({ label: `gap${idx}`, priority: idx < 3 ? 3 : 4, order: -idx, text: `free gap: ${localStamp(g.start, tz)} for ${g.minutes}m` }),
  );
  return units;
}

function threadUnits(input: NbaInput): Unit[] {
  const t = input.thread ?? [];
  const tz = input.user.tz;
  const sorted = [...t].sort((a, b) => a.at.localeCompare(b.at));
  return sorted.map((m, i) => {
    const fromEnd = sorted.length - i;
    return {
      label: m.id,
      priority: fromEnd <= 3 ? 1 : fromEnd <= 6 ? 2 : 4,
      order: i,
      trimTo: fromEnd <= 3 ? 1200 : 400,
      text: `[${m.id}] ${localStamp(m.at, tz)} ${person(m.author)}: ${clean(m.text, 2000)}`,
    } satisfies Unit;
  });
}

function verbContextUnits(input: NbaInput): Unit[] {
  const v = input.verbContext;
  if (!v) return [];
  const tz = input.user.tz;
  const units: Unit[] = [];
  if (v.tools?.length)
    units.push({
      label: 'tools',
      priority: 0,
      text:
        'available tools:\n' +
        v.tools
          .map(
            (t) =>
              `- ${t.id} (${t.name}, health ${t.health ?? 'unknown'}): ${clean(t.description, 200)}\n  inputs: ${t.inputs.map((i) => `${i.name}${i.required ? '*' : ''} — ${clean(i.description, 100)}`).join('; ')}`,
          )
          .join('\n'),
    });
  if (v.activity) {
    const a = v.activity;
    units.push({
      label: 'activity_blocks',
      priority: 0,
      text:
        'time blocks to classify (ids are the only valid blockId values; times are facts, never adjust them):\n' +
        a.blocks
          .map(
            (b) =>
              `- [${b.id}] ${localStamp(b.start, tz)} → ${localStamp(b.end, tz).split(' ')[2]} (${minutesBetween(b.start, b.end)}m) · ${b.source} · ${clean(b.title, 120)}${b.externalAttendees ? ' · external attendees' : ''}${b.oppHint ? ` · opp hint ${b.oppHint.name} [${b.oppHint.id}]${b.oppHint.isOpen === false ? ' (closed)' : ''}` : ''}${b.accountHint ? ` · account hint ${b.accountHint.name} [${b.accountHint.id}]` : ''}${b.alreadyLogged ? ' · ALREADY LOGGED' : ''}`,
          )
          .join('\n'),
    });
    if (a.taxonomy?.length)
      units.push({ label: 'taxonomy', priority: 0, text: `SE task types (verbatim): ${a.taxonomy.map((t) => `${t.type} [${t.counts}]`).join('; ')}` });
    if (a.quarter)
      units.push({
        label: 'quarter',
        priority: 2,
        text: `quarter ${a.quarter.label}: ${a.quarter.ccHoursLogged ?? '?'} CC hours logged of ${a.quarter.target ?? '?'}${a.quarter.deadline ? `; logging deadline ${a.quarter.deadline}` : ''}`,
      });
  }
  if (v.vdp) {
    const d = v.vdp;
    units.push({
      label: 'vdp',
      priority: 0,
      text: [
        `VDP for ${d.accountName}${d.vdpId ? ` [${d.vdpId}]` : ' (none exists yet)'}${d.url ? ` ${d.url}` : ''}`,
        d.missingFields?.length ? `missing fields: ${d.missingFields.join(', ')}` : '',
        d.useCases?.length ? `use cases: ${d.useCases.map((u) => `${u.title}${u.priority ? ` (${u.priority})` : ''}${u.hasCurrentDesired === false ? ' [no CURRENT/DESIRED]' : ''}`).join('; ')}` : 'use cases: none',
        `linkage: account ${d.linkage?.accountId ?? 'missing'}, opportunity ${d.linkage?.opportunityId ?? 'missing'}`,
        d.assets?.length ? `assets: ${d.assets.map((a) => `${a.label} ${a.url}`).join('; ')}` : 'assets: none',
        d.dcStatus ? `deal contribution: ${d.dcStatus}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  if (v.deliverable) {
    const d = v.deliverable;
    units.push({
      label: 'deliverable',
      priority: 0,
      text: [
        `file: ${d.file.title} [${d.file.id}]${d.file.url ? ` ${d.file.url}` : ''}`,
        `last modified: ${d.file.lastModifiedAt ? localStamp(d.file.lastModifiedAt, tz) : 'unknown'} by ${d.file.lastModifiedBy ?? 'unknown'}; modified since item created: ${d.file.modifiedSinceItemCreated ?? 'unknown'}`,
        `requested changes:\n${d.requestedChanges.map((c, i) => `  ${i + 1}. ${clean(c, 200)}`).join('\n')}`,
        `observed diff since item created:\n${d.diffSummary.length ? d.diffSummary.map((l) => `  - ${clean(l, 240)}`).join('\n') : '  (no changes observed)'}`,
      ].join('\n'),
    });
  }
  if (v.session) {
    const s = v.session;
    units.push({
      label: 'session',
      priority: 1,
      text: [
        `repo folder: ${s.folder ?? 'unknown'}${s.repoDescription ? ` — ${clean(s.repoDescription, 200)}` : ''}`,
        s.relatedSessions?.length
          ? `related Claude sessions: ${s.relatedSessions.map((r) => `${clean(r.title, 80)} [${r.id}] ${r.state}, last ${localStamp(r.lastAt, tz)}`).join('; ')}`
          : 'related Claude sessions: none found',
        s.constraints?.length ? `constraints: ${s.constraints.join('; ')}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  if (v.schedule) {
    const s = v.schedule;
    units.push({
      label: 'schedule',
      priority: 1,
      text: `meeting: ${s.durationMin ?? '?'} min with ${(s.attendees ?? []).map(person).join('; ') || 'unspecified'}${s.windowEnd ? `, before ${localStamp(s.windowEnd, tz)}` : ''}`,
    });
  }
  return units;
}

function previousUnits(input: NbaInput): Unit[] {
  const p = input.previous;
  if (!p) return [];
  const parsed = nbaOutputSchema.safeParse(p.output);
  let summary: string;
  if (parsed.success) {
    const o = parsed.data;
    const draftText = o.draft ? docToPlainText(o.draft.doc) : null;
    summary = [
      `title: ${o.title}`,
      `why: ${o.why}`,
      `confidence: ${o.confidence}`,
      `sources: ${o.sources.join(', ')}`,
      draftText ? `generated draft (${o.draft?.destination.label}):\n"""\n${draftText}\n"""` : 'generated draft: none',
      o.plan ? `plan: ${JSON.stringify(o.plan).slice(0, 1500)}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  } else {
    summary = `previous output (unparsed): ${JSON.stringify(p.output).slice(0, 1500)}`;
  }
  const ds = p.draftState;
  const touched = ds?.userTouched
    ? `USER-TOUCHED DRAFT: yes. The user's current text is below. Do NOT replace it: set draft to null and put any change in update.proposal.\n"""\n${redactSecrets(ds.currentText ?? '').text}\n"""${ds.lockedFields?.length ? `\nlocked fields: ${ds.lockedFields.join(', ')}` : ''}`
    : 'USER-TOUCHED DRAFT: no (an untouched draft may be replaced; say so in update.draftPolicy).';
  return [{ label: 'previous', priority: 0, text: `version ${p.version}, generated ${localStamp(p.generatedAt, input.user.tz)}\n${summary}\n${touched}` }];
}

export function taskInstruction(input: NbaInput): string {
  const spec = VERB_SPECS[input.verb];
  const lines = [
    `Produce the next best action for verb "${input.verb}" (primary action: ${spec.primary}).`,
    spec.output === 'draft'
      ? 'It must carry a ready-to-send draft as a TipTap doc (or draft=null with a blocking ask if the action truly cannot be drafted).'
      : spec.output === 'plan'
        ? `It must carry a plan of kind "${spec.planKind}".`
        : `It must carry a plan of kind "${spec.planKind}"; a short draft message is optional.`,
    input.previous
      ? 'A previous version exists: apply the update rule and fill `update`.'
      : 'There is no previous version: `update` must be null.',
    input.previous?.draftState?.userTouched ? 'The draft is user-touched: draft MUST be null; offer the change as update.proposal (or draftPolicy "unchanged").' : '',
    `Use only ids that appear above in sources/evidenceIds. Today is ${localStamp(input.now, input.user.tz)}.`,
    'Return ONLY the JSON object, no prose, no code fence.',
  ];
  return lines.filter(Boolean).join('\n');
}

export function buildNbaSections(input: NbaInput): Section[] {
  const u = input.user;
  const sections: Section[] = [
    {
      key: 'now',
      tag: 'now',
      units: [{ priority: 0, text: `${localStamp(input.now, u.tz)} (${input.now}, zone ${u.tz})` }],
    },
    {
      key: 'user',
      tag: 'user',
      units: [{ priority: 0, text: `${u.name}, ${u.role}${u.managerName ? `; manager ${u.managerName}` : ''}${u.slackId ? `; slack ${u.slackId}` : ''}` }],
    },
    // D-55: who the user is at work (role, duties, rules); never trimmed
    { key: 'persona', tag: 'persona', units: input.persona ? [{ priority: 0, text: input.persona }] : [] },
    { key: 'work item', tag: 'work_item', units: workItemUnits(input) },
    { key: 'initiative', tag: 'initiative', units: initiativeUnits(input) },
    {
      key: 'policy',
      tag: 'policy',
      units: input.policy
        ? [
            {
              priority: 2,
              text: `lane ${input.policy.lane}${input.policy.rank != null ? `, rank ${input.policy.rank}` : ''}: ${clean(input.policy.summary, 300)}${input.policy.rulesHit?.length ? `\nrules hit: ${input.policy.rulesHit.map((r) => `${r.key} — ${clean(r.text, 120)}`).join('; ')}` : ''}`,
            },
          ]
        : [],
    },
    { key: 'calendar', tag: 'calendar', units: calendarUnits(input) },
    { key: 'evidence', tag: 'evidence', header: 'Timeline, oldest first. Cite by [id].', units: evidenceUnits(input) },
    {
      key: 'destination',
      tag: 'destination',
      units: input.destination
        ? [
            {
              priority: 0,
              text: `${input.destination.channel} · ${input.destination.label}${input.destination.targetId ? ` [${input.destination.targetId}]` : ''}${input.destination.threadRef ? ` · thread ${input.destination.threadRef}` : ''}${input.destination.subject ? ` · subject "${clean(input.destination.subject, 140)}"` : ''}${input.destination.to?.length ? ` · to ${input.destination.to.join(', ')}` : ''}${input.destination.cc?.length ? ` · cc ${input.destination.cc.join(', ')}` : ''}`,
            },
          ]
        : [],
    },
    { key: 'thread', tag: 'thread', header: 'Conversation being answered, oldest first.', units: threadUnits(input) },
    { key: 'verb context', tag: 'verb_context', units: verbContextUnits(input) },
    {
      key: 'voice',
      tag: 'voice',
      units: input.voice && VERB_SPECS[input.verb].output !== 'plan' ? [{ priority: 2, trimTo: 1600, text: input.voice }] : [],
    },
    {
      key: 'feedback',
      tag: 'feedback',
      header: 'What the user said about earlier suggestions for this item. Respect it.',
      units: (input.feedback ?? []).map((f, i) => ({ priority: 2, order: i, text: `${localStamp(f.at, u.tz)} ${f.kind}${f.reason ? `: ${clean(f.reason, 200)}` : ''}` })),
    },
    { key: 'previous nba', tag: 'previous_nba', units: previousUnits(input) },
    { key: 'task', tag: 'task', units: [{ priority: 0, text: taskInstruction(input) }] },
  ];
  return sections;
}

export function systemPromptFor(input: NbaInput, skillsDir?: string): { system: string; skills: Skill[] } {
  const spec = VERB_SPECS[input.verb];
  const skills: Skill[] = [loadSkill('nba-common', skillsDir), loadSkill(spec.skill, skillsDir)];
  if (spec.draftStyle) {
    const channel = spec.draftStyle === 'by_destination' ? (input.destination?.channel ?? 'slack') : spec.draftStyle;
    skills.push(loadSkill(channel === 'email' ? 'draft-email' : 'draft-slack', skillsDir));
  }
  const system = skills.map((s) => `<!-- skill ${s.name}@${s.version} -->\n${s.body}`).join('\n\n---\n\n');
  return { system, skills };
}

export function buildNbaPrompt(input: NbaInput, opts: BuildOptions = {}): BuiltPrompt {
  const spec = VERB_SPECS[input.verb];
  // D-55: a verb whose feature is inactive for this persona (update_vdp without VDP) has no daily surface: never drafted.
  if (opts.persona && !nbaVerbAllowed(input.verb, opts.persona)) throw new Error(`nba: verb ${input.verb} is not active for the ${opts.persona.id} persona`);
  const { system, skills } = systemPromptFor(input, opts.skillsDir);
  const budget = opts.contextBudgetTokens ?? spec.contextBudgetTokens;
  const { text, report } = fitToBudget(buildNbaSections(input), budget);
  const model = modelFor(input.verb, opts.tier);
  const promptVersion = skills.map((s) => `${s.name}@${s.version}`).join('+');
  // `now` is reduced to the date so a re-eval later the same day with identical inputs is a no-op.
  const { now, calendar, ...rest } = input;
  const inputsHash = hashInputs(rest, calendar ? { ...calendar, now: calendar.now.slice(0, 10) } : null, now.slice(0, 10), model, promptVersion);
  return { system, user: text, model, maxOutputTokens: spec.maxOutputTokens, skills: skills.map((s) => ({ name: s.name, version: s.version })), promptVersion, inputsHash, budget: report };
}
