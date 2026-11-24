/**
 * The Persona block (D-55): who the user is at work, in the prompts' dynamic part (the Run block or context pack,
 * after the cached prefix). Deterministic: the same persona and settings give the same bytes (no clock, fixed
 * order), so it never breaks prompt caching between runs.
 */
import { fillThresholds, roleTitle } from './text';
import type { ResolvedPersona } from './types';

export function renderPersonaBlock(p: ResolvedPersona): string {
  const lines: string[] = ['## Persona', `Role: ${roleTitle(p)}, ${p.preamble}.`];
  const active = p.duties.filter((d) => d.active);
  if (active.length) {
    lines.push('Duties:');
    for (const d of active) lines.push(`- ${d.text}${d.cadence && d.cadence !== 'as_needed' ? ` (${d.cadence})` : ''}`);
  }
  const rules = p.rules.filter((r) => r.enabled);
  if (rules.length) {
    lines.push('What counts as work (rules, in order):');
    rules.forEach((r, i) => lines.push(`${i + 1}. ${fillThresholds(r.text, p.thresholds)}`));
  }
  const keys = Object.keys(p.thresholds).sort();
  if (keys.length) lines.push(`Thresholds: ${keys.map((k) => `${k}=${p.thresholds[k]}`).join('; ')}`);
  const on = (Object.keys(p.features) as (keyof typeof p.features)[]).filter((f) => p.features[f]).sort();
  lines.push(`Active features: ${on.length ? on.join(', ') : 'none'}`);
  // A9: what the role leaves off is still there to turn on (D-55: presets preconfigure, never remove)
  const off = (Object.keys(p.features) as (keyof typeof p.features)[]).filter((f) => !p.features[f]).sort();
  if (off.length) lines.push(`Available, not active for this role (Settings ▸ Role & rules turns them on): ${off.join(', ')}`);
  lines.push(`Sources: ${p.connectors.join(', ')}`);
  lines.push(`Org62 scopes: ${p.org62Scopes.join(', ')} (my book: ${p.org62Book === 'team_member' ? 'opportunity teams I am on' : p.org62Book === 'owner' ? 'opportunities I own' : 'opportunities I own or am on the team of'})`);
  lines.push(`Activity logging: Org62 Events with record type ${p.logging.recordType.value}${p.logging.taskTypeRequired ? ', each with an SE task type' : ''}${p.logging.hoursTargetH ? `, ${p.logging.hoursTargetH} h a quarter` : ''}`);
  return lines.join('\n');
}
