/**
 * Load the resolution skill (skills/resolve-item.md) for the resolution check. The engine (src/engines/resolution) is a
 * pure layer, so it receives the skill through `LadderOptions.skill`; the job handler and the eval harness load it here.
 */
import { ESCALATION_MODEL, SCANNER_MODEL } from '@/llm/models';
import { loadSkill } from '@/llm/skill-loader';
import { RESOLUTION_SKILL_PATH, type ResolutionSkill } from '@/engines/resolution/types';

export function loadResolutionSkill(repoRoot?: string): ResolutionSkill & { versionTag: string } {
  const s = loadSkill(RESOLUTION_SKILL_PATH, repoRoot);
  return { body: s.body, frontmatter: s.frontmatter as Record<string, unknown>, defaultModels: { cheap: SCANNER_MODEL, strong: ESCALATION_MODEL }, versionTag: s.versionTag };
}
