/**
 * How background scans interpret what they read (review 04 §4.1, H-3):
 *   fti      fetch by code (relay reads for Slack and Org62), batched tool-less classification
 *   agentic  the skill agent traverses and links, as before (the fallback: `CC_SCAN_MODE=agentic`)
 * FTI still runs the agentic skill for what it does not cover (relink, skill-upgrade dry runs, Org62 `book` and
 * `missed_opps`, Calendar, Claude sessions, trainings, watch briefs, VDP). The default follows the A/B gate
 * (docs/reference/SCANNER.md, "Fetch then interpret").
 */
export type ScanMode = 'fti' | 'agentic';

export const DEFAULT_SCAN_MODE: ScanMode = 'fti';

export function scanModeOf(env: Record<string, string | undefined> = process.env): ScanMode {
  const v = (env.CC_SCAN_MODE ?? '').trim().toLowerCase();
  return v === 'agentic' ? 'agentic' : v === 'fti' ? 'fti' : DEFAULT_SCAN_MODE;
}
