/**
 * Local wall-clock slot math: the next "HH:MM" in a user's time zone, DST-safe. Pure (Intl only), shared by the worker's
 * schedule table and the brief engine's cadence (moved from `src/worker/schedules.ts`, which re-exports it).
 */

function localParts(d: Date, timeZone: string) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** The UTC instant of a local wall-clock time (two-pass offset correction handles DST). */
function zonedInstant(y: number, mo: number, d: number, h: number, mi: number, timeZone: string): Date {
  let guess = Date.UTC(y, mo - 1, d, h, mi);
  for (let i = 0; i < 2; i++) {
    const p = localParts(new Date(guess), timeZone);
    const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
    guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
  }
  return new Date(guess);
}

/** Next occurrence of local "HH:MM" strictly after `after`. */
export function nextLocalTime(after: Date, hhmm: string, timeZone: string): Date {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  const p = localParts(after, timeZone);
  for (let addDays = 0; addDays < 3; addDays++) {
    const base = new Date(Date.UTC(p.y, p.mo - 1, p.d + addDays));
    const t = zonedInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), h, m, timeZone);
    if (t.getTime() > after.getTime()) return t;
  }
  return new Date(after.getTime() + 86_400_000);
}
