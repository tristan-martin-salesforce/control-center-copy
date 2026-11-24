'use client';
/**
 * The day ribbon: meetings on real time, declined ones as ghosts, the now line, and one open block that
 * suggests pull-forward work. Blue = now, amber = the meeting with prep missing; everything else neutral.
 * Overlapping meetings share the track in lanes (ribbonLayout) with a one-line label; a declined ghost that
 * shares time with a meeting is a thin band beneath it, never drawn over it.
 *
 * Hovering (or focusing) a meeting shows its hover card (who's coming, join link, prep, read-in, agenda) after a short
 * delay. A click opens the meeting itself; its prep task is one click away inside the meeting panel.
 */
import { useMemo, type CSSProperties } from 'react';
import type { HomeRibbon, HomeRibbonBlock } from '@/contract';
import { MeetingHover } from '@/components/panels/meeting';
import { useRightPanel } from '@/components/shell';
import { hmIn, ribbonLayout, ribbonMaxLanes } from './model';

const HOUR = 3_600_000;

/** `time` + `marks` is the two-line label's top line; a stacked (one-line) block shows `time`, `glyph`, then the title. */
/** What a click opens: a meeting opens the meeting (never its prep item); the open block opens its pull-forward item. */
export function ribbonTarget(b: Pick<HomeRibbonBlock, 'kind' | 'itemId' | 'eventId' | 'fullTitle'>): { kind: 'calendar_event' | 'work_item'; id: string; label: string } | null {
  if (b.kind === 'meeting' && b.eventId) return { kind: 'calendar_event', id: b.eventId, label: b.fullTitle };
  if (b.itemId) return { kind: 'work_item', id: b.itemId, label: b.fullTitle };
  if (b.eventId) return { kind: 'calendar_event', id: b.eventId, label: b.fullTitle };
  return null;
}

function blockLabel(b: HomeRibbonBlock, tz: string | undefined): { time: string; marks: string; glyph: string; n: string } {
  const start = hmIn(b.start, tz);
  if (b.kind === 'declined') return { time: start, marks: '', glyph: '', n: 'declined' };
  if (b.kind === 'open') return { time: b.title, marks: '', glyph: '', n: b.note ?? '' };
  const marks = [b.state === 'now' ? 'now' : null, b.state === 'risk' ? `▲ ${b.note ?? 'prep'}` : null, b.star && b.state !== 'risk' ? '★' : null].filter(Boolean).join(' ');
  // The glyph keeps the state readable without the color (never color alone) when there is no room for words.
  const glyph = b.state === 'risk' ? '▲' : b.state === 'now' ? '●' : b.star ? '★' : '';
  return { time: start, marks, glyph, n: b.title };
}

/** `plan`: the next working day planned ahead (no now line, no past shade; the axis starts at the day's start). */
export function DayRibbon({ r, tz, nowMs, plan = null }: { r: HomeRibbon; tz: string | undefined; nowMs: number; plan?: string | null }) {
  const panel = useRightPanel();
  const s = Date.parse(r.start);
  const e = Date.parse(r.end);
  const span = Math.max(HOUR, e - s);
  const pct = (t: number) => `${(((Math.min(e, Math.max(s, t)) - s) / span) * 100).toFixed(3)}%`;
  const now = plan ? s : Math.min(e, Math.max(s, nowMs));
  const hours: number[] = [];
  for (let t = s + HOUR; t < e - 20 * 60_000; t += HOUR) if (plan || Math.abs(t - now) > 25 * 60_000) hours.push(t);
  const showStart = plan || now - s > 60 * 60_000;
  const places = useMemo(() => ribbonLayout(r.blocks, e), [r.blocks, e]);
  const maxLanes = ribbonMaxLanes(places);
  return (
    <section className="hm-day" aria-label={`${plan ? `${plan}'s` : "Today's"} calendar, ${hmIn(r.start, tz)} to ${hmIn(r.end, tz)}`} data-home-panel="ribbon" data-plan={plan ? '1' : undefined}>
      <div className="hm-track" data-lanes={maxLanes} style={{ ['--hour-w' as string]: `${(HOUR / span) * 100}%`, ['--hour-x' as string]: '0', ['--max-lanes' as string]: String(maxLanes) }}>
        {r.blocks.map((b, i) => {
          const bs = Date.parse(b.start);
          const be = Date.parse(b.end);
          const p = places[i]!;
          const { time, marks, glyph, n } = blockLabel(b, tz);
          const stacked = p.lanes > 1 && !p.band;
          const cls = [
            'hm-ev',
            b.kind === 'declined' ? 'is-declined' : '',
            b.kind === 'open' ? 'is-open' : '',
            b.kind === 'agent' ? 'is-agent' : '',
            p.short && !p.spill && !stacked ? 'is-short' : '',
            p.spill ? 'is-spill' : '',
            stacked ? 'is-stacked' : '',
            p.band ? 'is-band' : '',
            p.overBand ? 'is-over-band' : '',
          ]
            .filter(Boolean)
            .join(' ');
          const style: CSSProperties = {
            left: pct(bs),
            width: `calc(${pct(be)} - ${pct(bs)})`,
            ...(stacked || p.overBand ? { ['--lane' as string]: String(p.lane), ['--lanes' as string]: String(p.lanes) } : {}),
            ...(p.spill && p.spillTo !== null ? { ['--spill' as string]: `${((p.spillTo - bs) / Math.max(1, be - bs)) * 100}%` } : {}),
          };
          const clickable = b.kind === 'meeting' || (b.kind === 'open' && !!b.itemId);
          const open = () => {
            const t = ribbonTarget(b);
            if (t) panel.openDetails(t);
          };
          // WCAG 2.5.3: the name starts with what the block shows; the full line follows when the block shows less
          // (or more: the ▲ prep mark) than its title
          const shown = p.band ? '' : stacked ? [time, glyph, n].filter(Boolean).join(' ') : [marks ? `${time} ${marks}` : time, n].filter(Boolean).join(' ');
          const name = !shown || b.fullTitle.startsWith(shown) ? b.fullTitle : `${shown}: ${b.fullTitle}`;
          const inner = p.band ? null : stacked ? (
            <>
              <span className="t">
                <span className="tm">{time}</span>
                {glyph ? ' ' : null}
                {glyph ? <span className="mk">{glyph}</span> : null}
              </span>
              {n ? ' ' : null}
              {n ? <span className="n">{n}</span> : null}
            </>
          ) : (
            <>
              <span className="t">{marks ? `${time} ${marks}` : time}</span>
              {/* a space between the time and the name, so the visible label is a part of the name (WCAG 2.5.3) */}
              {n ? ' ' : null}
              {n ? <span className="n">{n}</span> : null}
            </>
          );
          if (b.kind === 'meeting' && b.eventId) {
            // the hover card replaces the native title tooltip; the accessible name keeps the full line
            return (
              <MeetingHover key={b.id} eventId={b.eventId} title={b.fullTitle}>
                <button type="button" className={cls} style={style} data-tone={b.state ?? undefined} data-lane={stacked ? `${p.lane + 1}/${p.lanes}` : undefined} data-event-id={b.eventId} aria-label={name} onClick={open}>
                  {inner}
                </button>
              </MeetingHover>
            );
          }
          return clickable ? (
            <button key={b.id} type="button" className={cls} style={style} data-tone={b.state ?? undefined} data-lane={stacked ? `${p.lane + 1}/${p.lanes}` : undefined} title={b.fullTitle} aria-label={name} onClick={open}>
              {inner}
            </button>
          ) : (
            <div key={b.id} className={cls} style={style} data-tone={b.state ?? undefined} data-lane={stacked ? `${p.lane + 1}/${p.lanes}` : undefined} title={b.fullTitle}>
              {inner}
            </div>
          );
        })}
        {plan ? null : (
          <>
            <div className="hm-past" style={{ width: pct(now) }} aria-hidden />
            <div className="hm-nowline" style={{ left: pct(now) }} aria-hidden />
          </>
        )}
      </div>
      <div className="hm-axis" aria-hidden>
        {showStart ? (
          <span className="is-start" style={{ left: 0 }}>
            {hmIn(s, tz)}
          </span>
        ) : null}
        {plan ? null : (
          <span className="is-now" style={{ left: pct(now) }}>
            {hmIn(now, tz)}
          </span>
        )}
        {hours.map((h) => (
          <span key={h} style={{ left: pct(h) }}>
            {hmIn(h, tz)}
          </span>
        ))}
      </div>
    </section>
  );
}

