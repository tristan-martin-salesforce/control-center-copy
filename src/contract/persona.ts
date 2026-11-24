/**
 * Personas (D-55): who the user is at work decides which duties, sources, scanner rules and pages are preconfigured.
 * A persona PRECONFIGURES; it never takes anything away. What is outside the preset is "available, not in your
 * role's preconfiguration" and can be activated per person.
 *
 * The settings section stores CHANGES to the preset only (rule edits, custom rules, thresholds, activated or
 * deactivated features and sources), so improvements to a preset keep reaching everyone who uses it. The preset
 * definitions themselves live in src/personas (pure data). A user with no section reads as the SE persona, with the
 * level from `profile.role` (rows from before personas), so nothing migrates.
 */
import { z } from 'zod';
import { Version } from './common';

export const PersonaId = z.enum(['se', 'ae']);
export type PersonaId = z.infer<typeof PersonaId>;

export const PersonaLevel = z.enum(['ic', 'manager']);
export type PersonaLevel = z.infer<typeof PersonaLevel>;

/** The duty-sized features a persona turns on or leaves available. */
export const PersonaFeature = z.enum(['vdp', 'activityLogging', 'dealContributions', 'missedOpps', 'specialistForecast', 'solutionsJudgement']);
export type PersonaFeature = z.infer<typeof PersonaFeature>;

/** A preset rule's edit: switched off, or reworded. Absent = the preset's own. */
export const PersonaRuleOverride = z.object({
  enabled: z.boolean().optional(),
  text: z.string().trim().min(1).max(400).optional(),
});
export type PersonaRuleOverride = z.infer<typeof PersonaRuleOverride>;

/** A rule of the user's own ("Asks from my RVP about a forecast are tasks due the same day"). */
export const PersonaCustomRule = z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,60}$/),
  text: z.string().trim().min(1).max(400),
  enabled: z.boolean().default(true),
});
export type PersonaCustomRule = z.infer<typeof PersonaCustomRule>;

/** A number, or text up to 400 characters (the AE's forecast note template is a threshold). */
const ThresholdValue = z.union([z.number(), z.string().max(400)]);

export const PersonaSettings = z.object({
  version: Version,
  id: PersonaId.default('se'),
  /** null = from `profile.role` (se_manager → manager, else ic). */
  level: PersonaLevel.nullable().default(null),
  /** Edits to the preset's rules, by rule id. */
  rules: z.record(z.string(), PersonaRuleOverride).default({}),
  /** Kept at 50 (a prompt budget): every enabled rule rides in each scan prompt (src/personas/prompt.ts). */
  customRules: z.array(PersonaCustomRule).max(50).default([]),
  /** Threshold values that differ from the preset ("staleNotesMinAmountUsd": 250000). */
  thresholds: z.record(z.string(), ThresholdValue).default({}),
  /** Features switched on (an available one activated) or off (a preset one deactivated). */
  features: z.record(z.string(), z.boolean()).default({}),
  /** Sources switched on or off against the preset, by connector id ("vdp": true). */
  connectors: z.record(z.string(), z.boolean()).default({}),
});
export type PersonaSettings = z.infer<typeof PersonaSettings>;

export const DEFAULT_PERSONA_SETTINGS: PersonaSettings = PersonaSettings.parse({ version: 1 });

export const PersonaSettingsPatch = z
  .object({
    id: PersonaId,
    level: PersonaLevel.nullable(),
    rules: z.record(z.string(), PersonaRuleOverride),
    customRules: z.array(PersonaCustomRule).max(50),
    thresholds: z.record(z.string(), ThresholdValue),
    features: z.record(z.string(), z.boolean()),
    connectors: z.record(z.string(), z.boolean()),
  })
  .partial();
export type PersonaSettingsPatch = z.infer<typeof PersonaSettingsPatch>;
