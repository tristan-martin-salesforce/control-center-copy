'use client';
/**
 * Left pane: the day as a real timeline (proportional heights, now line, past dimmed, time outside working
 * hours shaded). Meetings are neutral blocks; declined ones sit struck through in a narrow side lane, beside the
 * violet background agent run ("doesn't take your time"). Planned work is dashed: the selected one blue, a
 * blocked one red. ★ meetings carry their prep state as an edge plus a word. Open gaps say what fits.
 *
 * Zoom (−, the level, +; `-` `=` `0`; Ctrl/⌘ + scroll or a pinch) spreads short blocks out; past "Fit" the grid
 * scrolls inside its pane and every zoom keeps now where it was. The level is remembered (resume store).
 * Labels come from pixelLayout: a block gets the label it has room for, never one that runs into the next
 * block; a block too short for any label keeps its tooltip, and a click opens it in Details.
 *
 * Click or Enter on a block opens it in the right panel. Work blocks re-plan by drag or Alt+↑/↓
 * (15 min): a local plan only, never the calendar.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import type { CalendarEvent, WorkItem } from '@/contract';
import { useCommands, useKeyBinding } from '@/client/keyboard';
import { useResumeExtra } from '@/client/resume';
import { MeetingHover } from '@/components/panels/meeting';
import { cn, EmptyState, IconButton, PanelError } from '@/ui';
import { Badge } from './DayHeader';
import { stripLabel } from './rows';
import { clampZoom, GAP_LABEL_PX, gridHeightAt, isSideBlock, pixelLayout, stepZoom, wheelZoom, ZOOM_MAX, zoomLabel, zoomScroll, type BlockBox, type DayLayout, type TLBlock, type ZoomViewport } from './timeline';
import { hhmm, hm } from './time';
import { TODAY_SCOPE } from './useTodayKeys';

export interface MeetingState {
  star: boolean;
  tone: 'blocked' | 'risk' | 'ready' | null;
  badge: { tone: 'danger' | 'warning' | 'success' | 'neutral'; label: string } | null;
  note: string | null;
}

export interface DayTimelineProps {
  layout: DayLayout;
  nowIso: string;
  meetingCount: number;
  meetingState: (e: CalendarEvent) => MeetingState;
  items: Map<string, WorkItem>;
  blocked: ReadonlySet<string>;
  /** The selected row's item: its blocks turn blue. */
  activeItemId: string | null;
  /** Hovered row's item (outline) and the selected fit-in's gap. */
  hlItemId: string | null;
  hlHintKey: string | null;
  onOpenEvent: (e: CalendarEvent) => void;
  onOpenItem: (itemId: string) => void;
  onHoverItem: (itemId: string | null) => void;
  /** Shift a work slot by `deltaMin` (local plan). */
  onReplan: (slotId: string, deltaMin: number) => void;
  state: 'ready' | 'empty' | 'loading' | 'error';
  onRetry: () => void;
}

interface Viewport {
  h: number;
  padTop: number;
  padBottom: number;
  /** Root font size / 16 (the text-size pref): gap labels are rem-sized. */
  scale: number;
}

/** Position from the pixel layout; columns inside the main lane keep a 4 px gutter between them. */
/**
 * A meeting block is named by what it shows (axe label-content-name-mismatch, WCAG 2.5.3): the title, the badge and
 * the meta line read as shown, then a visually hidden suffix with what the block leaves out: the time when the meta
 * line doesn't carry it (live, declined, a badge in its place), and the declined line when a badge hides it.
 * A tiny block shows nothing and keeps its full aria-label.
 */
export function eventSpokenSuffix(time: string, meta: string, shownMeta: string | null, declined: boolean): string {
  const parts: string[] = [];
  if (shownMeta === null && declined) parts.push(meta);
  if (!(shownMeta ?? (declined ? meta : '')).includes(time)) parts.push(time);
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}

function place(box: BlockBox | undefined, b: TLBlock): CSSProperties {
  if (!box) return { display: 'none' };
  const w = box.right - box.left;
  return { top: box.top, height: box.height, left: `${box.left}%`, width: !isSideBlock(b) && b.cols > 1 ? `calc(${w}% - 4px)` : `${w}%` };
}

/** The zoom level (remembered per route) and the scroll anchoring that keeps now in view. */
function useDayZoom(scrollRef: RefObject<HTMLDivElement | null>, vp: Viewport, layout: DayLayout, nowOnGrid: boolean) {
  const [saved, save] = useResumeExtra<number>('dayZoom', 1);
  const [local, setLocal] = useState<number | null>(null);
  const zoom = clampZoom(local ?? saved);
  const shown = useRef(zoom);
  const pending = useRef<{ scrollTop: number; from: number; pointerY?: number } | null>(null);
  const savedRef = useRef(saved);
  savedRef.current = saved;

  const apply = useCallback(
    (next: number | ((z: number) => number), pointerY?: number) => {
      const el = scrollRef.current;
      // The first event of a burst (a pinch) records where the view was; the layout effect re-anchors once.
      if (!pending.current) pending.current = { scrollTop: el?.scrollTop ?? 0, from: shown.current };
      pending.current.pointerY = pointerY;
      setLocal((prev) => clampZoom(typeof next === 'function' ? next(clampZoom(prev ?? savedRef.current)) : next));
    },
    [scrollRef],
  );
  // Remember the level once a gesture settles (the resume store writes localStorage).
  useEffect(() => {
    if (local === null) return;
    const t = setTimeout(() => save(local), 300);
    return () => clearTimeout(t);
  }, [local, save]);

  // After the grid takes its new height: keep the anchor (now, else the pointer) where it was on screen.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom === shown.current) {
      pending.current = null;
      return;
    }
    const p = pending.current ?? { scrollTop: el.scrollTop, from: shown.current };
    const v: ZoomViewport = { start: layout.start, end: layout.end, now: nowOnGrid ? layout.now : null, viewportH: vp.h, padTop: vp.padTop, padBottom: vp.padBottom, scrollTop: p.scrollTop };
    el.scrollTop = zoomScroll(v, p.from, zoom, p.pointerY);
    shown.current = zoom;
    pending.current = null;
  }, [zoom, scrollRef, layout.start, layout.end, layout.now, nowOnGrid, vp.h, vp.padTop, vp.padBottom]);

  return { zoom, apply };
}

export function DayTimeline(p: DayTimelineProps) {
  const { layout } = p;
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [vp, setVp] = useState<Viewport>({ h: 600, padTop: 12, padBottom: 22, scale: 1 });
  const ready = p.state === 'ready' || p.state === 'empty';
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      const cs = getComputedStyle(el);
      const scale = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16) / 16;
      const next = { h: el.clientHeight || 600, padTop: parseFloat(cs.paddingTop) || 0, padBottom: parseFloat(cs.paddingBottom) || 0, scale };
      setVp((v) => (v.h === next.h && v.padTop === next.padTop && v.padBottom === next.padBottom && v.scale === next.scale ? v : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  const span = Math.max(60, layout.end - layout.start);
  const dayOver = layout.now >= layout.end;
  const nowOnGrid = !dayOver && layout.now >= layout.start;
  const { zoom, apply } = useDayZoom(scrollRef, vp, layout, nowOnGrid);
  const gridH = gridHeightAt({ viewportH: vp.h, padTop: vp.padTop, padBottom: vp.padBottom }, zoom);
  const pxPerMin = gridH / span;
  const gapLabelPx = Math.ceil(GAP_LABEL_PX - 20 + 20 * vp.scale);
  const pix = useMemo(() => pixelLayout(layout, pxPerMin, { nowOnGrid, gapLabelPx }), [layout, pxPerMin, nowOnGrid, gapLabelPx]);
  const y = (m: number) => (m - layout.start) * pxPerMin;

  // Ctrl/⌘ + scroll and a trackpad pinch zoom (non-passive, so the browser's page zoom doesn't fire).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      apply((z) => wheelZoom(z, e.deltaY, e.deltaMode), e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [apply, ready]);

  const zoomIn = useCallback(() => apply((z) => stepZoom(z, 1)), [apply]);
  const zoomOut = useCallback(() => apply((z) => stepZoom(z, -1)), [apply]);
  const fit = useCallback(() => apply(1), [apply]);
  const keyOpts = { scope: TODAY_SCOPE, enabled: ready, group: 'Today' };
  useKeyBinding(['=', '+'], () => (zoom < ZOOM_MAX ? zoomIn() : false), { ...keyOpts, description: 'Zoom the day in' });
  useKeyBinding('-', () => (zoom > 1 ? zoomOut() : false), { ...keyOpts, description: 'Zoom the day out' });
  useKeyBinding('0', () => (zoom > 1 ? fit() : false), { ...keyOpts, description: 'Fit the day' });
  useCommands([
    { id: 'today.zoom.in', title: 'Zoom the day in', group: 'Today', shortcut: '=', keywords: ['timeline', 'bigger'], run: zoomIn },
    { id: 'today.zoom.out', title: 'Zoom the day out', group: 'Today', shortcut: '-', keywords: ['timeline', 'smaller'], run: zoomOut },
    { id: 'today.zoom.fit', title: 'Fit the whole day', group: 'Today', shortcut: '0', keywords: ['timeline', 'zoom', 'reset'], run: fit },
  ]);

  // Drag to re-plan a work block (snaps to 5 minutes).
  const drag = useRef<{ id: string; y: number; moved: boolean } | null>(null);
  const [dragDelta, setDragDelta] = useState<{ id: string; min: number } | null>(null);
  const onDown = (e: PointerEvent<HTMLButtonElement>, id: string) => {
    if (e.button !== 0) return;
    drag.current = { id, y: e.clientY, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };
  const onMove = (e: PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const min = Math.round((e.clientY - d.y) / pxPerMin / 5) * 5;
    if (Math.abs(e.clientY - d.y) > 4) d.moved = true;
    if (d.moved) setDragDelta({ id: d.id, min });
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.moved && dragDelta && dragDelta.id === d.id && dragDelta.min !== 0) p.onReplan(d.id, dragDelta.min);
    setDragDelta(null);
    if (d?.moved) suppressClick.current = true;
  };
  const suppressClick = useRef(false);
  const onWorkKey = (e: KeyboardEvent<HTMLButtonElement>, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    e.stopPropagation();
    p.onReplan(id, e.key === 'ArrowUp' ? -15 : 15);
  };

  const nowY = y(layout.now);
  const off: Array<[number, number]> = [];
  if (layout.workStart > layout.start) off.push([layout.start, Math.min(layout.end, layout.workStart)]);
  if (layout.workEnd < layout.end) off.push([Math.max(layout.start, layout.workEnd), layout.end]);

  return (
    <section className="td-pane td-day" aria-label="Day timeline" data-today-day>
      <div className="td-pane-head">
        <h2>Day</h2>
        <span className="td-count">
          {p.meetingCount} meeting{p.meetingCount === 1 ? '' : 's'}
        </span>
        <div className="td-actions">
          <div className="td-legend td-tl-legend" aria-hidden>
            <span>
              <i className="lg-mtg" />
              Meeting
            </span>
            <span>
              <i className="lg-work" />▶ You
            </span>
            <span>
              <i className="lg-agent" />✦ Agent
            </span>
          </div>
          {ready ? (
            <div className="td-zoom" role="group" aria-label="Zoom the day" data-zoom={zoom}>
              <IconButton icon="zoomout" label="Zoom out" title="Zoom out ( - )" size="xs" iconSize="sm" disabled={zoom <= 1} onClick={zoomOut} aria-keyshortcuts="-" />
              <button type="button" className="td-zoom-v" onClick={fit} disabled={zoom <= 1} title={zoom > 1 ? 'Fit the whole day ( 0 )' : 'The whole day fits · zoom with + or Ctrl/⌘ + scroll'} aria-label={zoom > 1 ? `Fit: zoom ${zoomLabel(zoom)}, fit the whole day` : 'Fit: whole day shown'} aria-keyshortcuts="0">
                {zoomLabel(zoom)}
              </button>
              <IconButton icon="zoomin" label="Zoom in" title="Zoom in ( = or + · Ctrl/⌘ + scroll or pinch )" size="xs" iconSize="sm" disabled={zoom >= ZOOM_MAX} onClick={zoomIn} aria-keyshortcuts="= +" />
            </div>
          ) : null}
        </div>
      </div>
      {p.state === 'error' ? (
        <PanelError title="The day didn’t load" error={new Error('Forced error (dev toolbar)')} onRetry={p.onRetry} />
      ) : p.state === 'loading' ? (
        <div className="td-tl" aria-busy>
          <div className="flex h-full flex-col gap-3">
            {Array.from({ length: 8 }, (_, i) => (
              <span key={i} className={cn('block animate-pulse rounded-md bg-surface-sunken', i % 3 === 0 ? 'h-14' : 'h-6')} />
            ))}
          </div>
        </div>
      ) : (
        <div className="td-tl" ref={scrollRef} data-zoomed={zoom > 1 || undefined}>
          <div className="td-tl-grid" style={{ height: gridH }} data-px-per-min={pxPerMin.toFixed(3)}>
            {off.map(([s, e]) => (
              <div key={s} className="td-off" aria-hidden style={{ top: y(s), height: y(e) - y(s) }} data-off-hours="" />
            ))}
            {pix.marks.map((h) => (
              <span key={h.min} className="td-hr" data-half={h.kind !== 'hour' ? '' : undefined} data-quarter={h.kind === 'quarter' ? '' : undefined} data-past={h.min < layout.now ? '' : undefined} style={{ top: y(h.min) }}>
                {h.label ? <i>{h.label}</i> : null}
              </span>
            ))}
            <div className="td-track">
              {p.state === 'empty' && !layout.blocks.some((b) => b.type !== 'gap') ? (
                <div className="absolute inset-x-0 top-1/3">
                  <EmptyState icon="event" title="No meetings today" body="The whole day is yours. Work you plan lands here." />
                </div>
              ) : null}
              {layout.blocks.map((b) => {
                if (b.type === 'gap') {
                  const g = pix.gaps.get(b.id);
                  if (!g || g.height <= 0) return null;
                  const text = b.tail ? `Open · ~${hm(b.minutes)} from ${hhmm(b.s)}, nothing booked` : `${hm(b.minutes)} open${b.hintTitle ? ` · fits ${b.hintTitle}` : ''}`;
                  const label = b.tail ? (
                    <>
                      <b>Open · ~{hm(b.minutes)}</b> from {hhmm(b.s)}, nothing booked
                    </>
                  ) : (
                    <>
                      <b>{hm(b.minutes)} open</b>
                      {b.hintTitle ? ` · fits ${b.hintTitle}` : ''}
                    </>
                  );
                  const w = g.right - g.left;
                  return (
                    <div
                      key={b.id}
                      className="td-gap"
                      data-tail={b.tail ? '' : undefined}
                      data-collapsed={g.label ? undefined : ''}
                      data-hl={b.hintKey && b.hintKey === p.hlHintKey ? '' : undefined}
                      data-gap-start={hhmm(b.s)}
                      title={`${hhmm(b.s)}–${hhmm(b.e)} · ${text}`}
                      style={{ top: g.top, height: g.height, left: `${g.left}%`, width: `${w}%`, ...(g.label ? { [b.tail ? 'paddingTop' : 'paddingBottom']: Math.max(0, Math.min(b.tail ? 8 : 6, g.height - gapLabelPx + 2)) } : null) }}
                    >
                      {g.label ? <span>{label}</span> : null}
                    </div>
                  );
                }
                const box = pix.boxes.get(b.id);
                const style = place(box, b);
                const tier = box?.tier ?? 'none';
                const short = tier === 'line' || undefined;
                const tiny = tier === 'none' || undefined;
                const narrow = b.narrow || undefined;
                if (b.type === 'meeting') {
                  const ev = b.event;
                  const ms = p.meetingState(ev);
                  const time = `${hhmm(b.s)}–${hhmm(b.e)}`;
                  const declined = b.side;
                  const live = b.live !== null;
                  const left = live ? Math.max(0, Math.round(b.e - layout.now)) : 0;
                  const meta = declined
                    ? ev.attendance === 'cancelled'
                      ? 'Cancelled'
                      : ev.attendance === 'declined'
                        ? 'Declined'
                        : `${time} · ${ev.myResponse === 'tentative' ? 'Tentative' : 'Not answered'} · not blocking`
                    : live
                      ? `now · ${left}m left${ms.note ? ` · ${ms.note}` : ''}`
                      : `${time}${ms.note ? ` · ${ms.note}` : ''}`;
                  const shownMeta = short && ms.badge ? null : meta;
                  const spoken = eventSpokenSuffix(time, meta, shownMeta, declined);
                  const title = (
                    <span className="td-ev-t">
                      {ms.star ? <span aria-hidden className="text-fg-heading">★ </span> : null}
                      {ev.title}
                    </span>
                  );
                  // the hover card (Home's ribbon has the same) replaces the native tooltip; the accessible name keeps it
                  return (
                    <MeetingHover key={b.id} eventId={ev.id} initial={ev} title={ev.title}>
                      <button
                        type="button"
                        className="td-ev"
                        data-kind="meeting"
                        data-short={short}
                        data-tiny={tiny}
                        data-narrow={narrow}
                        data-side={declined || undefined}
                        data-declined={(declined && (ev.attendance === 'declined' || ev.attendance === 'cancelled')) || undefined}
                        data-response={ev.myResponse === 'tentative' || ev.myResponse === 'needs_action' ? ev.myResponse : undefined}
                        data-live={live || undefined}
                        data-tone={ms.tone ?? undefined}
                        data-event-id={ev.id}
                        style={{ ...style, ...(live ? ({ '--elapsed': String(b.live) } as CSSProperties) : null) }}
                        aria-label={tiny ? `${time} · ${ev.title}${declined ? (ev.attendance === 'declined' || ev.attendance === 'cancelled' ? ` · ${ev.attendance}` : ' · not answered yes: not blocking') : ''}${ms.badge ? ` · ${ms.badge.label}` : ''}` : undefined}
                        onClick={() => p.onOpenEvent(ev)}
                        onMouseEnter={() => ev.prep?.workItemId && p.onHoverItem(ev.prep.workItemId)}
                        onMouseLeave={() => p.onHoverItem(null)}
                      >
                        {tiny ? null : short ? (
                          <>
                            {title}{' '}
                            {ms.badge ? <Badge tone={ms.badge.tone}>{ms.badge.label}</Badge> : <span className="td-ev-m">{meta}</span>}
                            {spoken ? <span className="sr-only">{spoken}</span> : null}
                          </>
                        ) : (
                          <>
                            <span className="td-ev-line">
                              {title}
                              {ms.badge ? <>{' '}<Badge tone={ms.badge.tone}>{ms.badge.label}</Badge></> : null}
                            </span>{' '}
                            <span className="td-ev-m">{meta}</span>
                            {spoken ? <span className="sr-only">{spoken}</span> : null}
                          </>
                        )}
                      </button>
                    </MeetingHover>
                  );
                }
                if (b.type === 'agent') {
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className="td-ev"
                      data-kind="agent"
                      data-short={short}
                      data-tiny={tiny}
                      data-side=""
                      style={style}
                      title={`${hhmm(b.s)}–${hhmm(b.e)} · ${b.label} in the background · it doesn’t take your time`}
                      onClick={() => p.onOpenItem(b.itemId)}
                      onMouseEnter={() => p.onHoverItem(b.itemId)}
                      onMouseLeave={() => p.onHoverItem(null)}
                    >
                      {tiny ? null : (
                        <span className="td-ev-t">
                          ✦ {b.label} ~{hm(b.e - b.s)}
                        </span>
                      )}
                    </button>
                  );
                }
                if (b.type === 'suggest') {
                  return (
                    <button
                      key={b.id}
                      type="button"
                      className="td-ev"
                      data-kind="suggest"
                      data-short={short}
                      data-tiny={tiny}
                      data-narrow={narrow}
                      style={style}
                      title={`Suggested: ${b.title} · pull forward · ~${hm(b.minutes)}`}
                      onClick={() => b.itemId && p.onOpenItem(b.itemId)}
                    >
                      {tiny ? null : (
                        <>
                          <span className="td-ev-t">Suggested: {b.title}</span>
                          <span className="td-ev-m">pull forward · ~{hm(b.minutes)}</span>
                        </>
                      )}
                    </button>
                  );
                }
                // work
                const item = b.itemId ? p.items.get(b.itemId) : undefined;
                const active = !!b.itemId && b.itemId === p.activeItemId;
                const delta = dragDelta?.id === b.id ? dragDelta.min : 0;
                const moved = delta && box ? { top: box.top + delta * pxPerMin } : null;
                const title = `▶ ${stripLabel(b.label)}`;
                const liveWork = b.s <= layout.now && layout.now < b.e ? (layout.now - b.s) / (b.e - b.s) : null;
                const meta = short ? (item ? `you ~${hm(item.effort.youMin)}` : '') : `${hhmm(b.s + delta)}–${hhmm(b.e + delta)}${item ? ` · you ~${hm(item.effort.youMin)}` : ''}`;
                return (
                  <button
                    key={b.id}
                    type="button"
                    className="td-ev"
                    data-kind="work"
                    data-short={short}
                    data-tiny={tiny}
                    data-narrow={narrow}
                    data-active={active || undefined}
                    data-hl={!active && b.itemId && b.itemId === p.hlItemId ? '' : undefined}
                    data-tone={b.itemId && p.blocked.has(b.itemId) ? 'blocked' : undefined}
                    data-dragging={delta ? '' : undefined}
                    data-live={liveWork !== null || undefined}
                    data-slot-id={b.id}
                    data-item-id={b.itemId ?? undefined}
                    style={{ ...style, ...moved, ...(liveWork !== null ? ({ '--elapsed': String(liveWork) } as CSSProperties) : null) }}
                    title={`${hhmm(b.s)}–${hhmm(b.e)} · ${stripLabel(b.label)}${item ? ` · you ~${hm(item.effort.youMin)}` : ''} · drag or Alt+↑/↓ to re-plan`}
                    aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                    onPointerDown={(e) => onDown(e, b.id)}
                    onPointerMove={onMove}
                    onPointerUp={onUp}
                    onPointerCancel={() => {
                      drag.current = null;
                      setDragDelta(null);
                    }}
                    onKeyDown={(e) => onWorkKey(e, b.id)}
                    onClick={() => {
                      if (suppressClick.current) {
                        suppressClick.current = false;
                        return;
                      }
                      if (b.itemId) p.onOpenItem(b.itemId);
                    }}
                    onMouseEnter={() => b.itemId && p.onHoverItem(b.itemId)}
                    onMouseLeave={() => p.onHoverItem(null)}
                  >
                    {tiny ? null : (
                      <>
                        <span className="td-ev-t">{title}</span>
                        {meta ? <span className="td-ev-m">{meta}</span> : null}
                      </>
                    )}
                  </button>
                );
              })}
            </div>
            {nowY > 0 ? <div className="td-past" aria-hidden style={{ height: Math.min(gridH, nowY) + 12 }} /> : null}
            {!dayOver && nowY >= 0 ? (
              <div className="td-now" aria-label={`Now ${hhmm(layout.now)}`} style={{ top: nowY }} data-now="">
                <b>{hhmm(layout.now)}</b>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </section>
  );
}
