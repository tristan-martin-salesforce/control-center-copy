/** Plain-English rule text with its thresholds filled in ("{staleNotesDays} days" → "7 days"). */

/** "{staleNotesDays} days" → "7 days", from the resolved thresholds. Unknown keys stay as written. */
export function fillThresholds(text: string, thresholds: Record<string, number | string>): string {
  return text.replace(/\{([A-Za-z0-9_]+)\}/g, (m, k: string) => (k in thresholds ? formatThreshold(k, thresholds[k]!) : m));
}

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
function formatThreshold(key: string, v: number | string): string {
  if (typeof v === 'number' && /Usd$/.test(key)) return `$${v.toLocaleString('en-US')}`;
  if (typeof v === 'number' && /Weekday$/.test(key)) return WEEKDAY[((v % 7) + 7) % 7]!;
  return String(v);
}


/**
 * "SE (Solutions Engineer)", or one name when the level and the role read the same ("Specialist AE", not
 * "Specialist AE (Specialist AE)"): the role's title in Settings and the prompts' Persona block.
 */
export function roleTitle(p: { levelLabel: string; label: string }): string {
  return p.levelLabel === p.label ? p.label : `${p.levelLabel} (${p.label})`;
}
