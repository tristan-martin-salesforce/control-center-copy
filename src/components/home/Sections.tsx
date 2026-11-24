'use client';
/**
 * Verb columns (Reply & approve · Think ahead · Log & fix · Chase · Initiatives at a wide container).
 * Each row keeps its verb as quiet text; the selected row gets the filled button. Edges light up only when a
 * row needs you (red broken or blocked, amber at risk, violet drafted by AI); everything else stays grey.
 */
import { AppLink } from '@/components/shell/AppLink';
import { useFillingEmpty } from '@/components/shell/FillingIn';
import type { HomeAheadDay, HomeRow, HomeSection } from '@/contract';
import { AheadStrip, SectionColumn as DomainSectionColumn } from '@/components/domain';
import { ReadIn, StateBadge, useHomeView } from './ctx';
import { rowKey } from './model';
import { NotNeededButton, useSetAside } from '@/components/needs/SetAside';

function Row({ section, row }: { section: HomeSection; row: HomeRow }) {
  const v = useHomeView();
  const setAside = useSetAside();
  const key = rowKey(section.id, row);
  const selected = v.selectedKey === key;
  const isOpen = v.openKey === key;
  const primary = v.primaryKey === key && !isOpen;
  const target = v.target(key);
  const errKey = row.item?.id ?? (row.entity.kind === 'connector' ? `connector:${row.entity.id}` : row.id);
  const err = v.actions.errors[errKey];
  const busy = row.entity.kind === 'connector' && v.actions.busy[row.entity.id];
  const runVerb = (e: React.MouseEvent) => {
    e.stopPropagation();
    v.actions.run(row.verb, { title: row.title, fallbackHref: row.href });
  };
  const badgeInWhy = !row.progress;
  return (
    <div
      className={['hm-row', selected ? 'is-selected' : '', primary ? 'is-primary' : '', isOpen ? 'is-open' : ''].filter(Boolean).join(' ')}
      tabIndex={0}
      // a row of its column's grid (it holds its own buttons, so it is not a button itself: nested-interactive)
      role="row"
      data-home-key={key}
      data-live={v.liveOf?.(key)}
      aria-label={`${row.title}. ${row.stateLabel ? `${row.stateLabel}. ` : ''}${row.why}`}
      aria-current={selected ? 'true' : undefined}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button,a')) return;
        if (target) v.openTarget(target);
      }}
      onFocus={(e) => {
        if (e.target === e.currentTarget) v.select(key);
      }}
    >
      {/* one cell that takes no box, so the row's own layout holds */}
      <div role="gridcell" className="contents">
        <span className="hm-edge" data-tone={row.state ?? undefined} aria-hidden />
        <div className="hm-row-title" title={row.title}>
          {row.title}
        </div>
        {row.progress ? (
          <div className="hm-meter-line">
            <div className="hm-meter" data-tone={row.state ?? undefined} role="meter" aria-valuemin={0} aria-valuemax={row.progress.total} aria-valuenow={row.progress.done} aria-label={`${row.progress.done} of ${row.progress.total} ${row.progress.label ?? ''}`}>
              <i style={{ width: `${Math.min(100, (row.progress.done / Math.max(1, row.progress.total)) * 100)}%` }} />
            </div>
            <StateBadge state={row.state} label={row.stateLabel} />
          </div>
        ) : null}
        <div className="hm-row-line">
          <span className="hm-why" title={row.why}>
            {badgeInWhy ? <StateBadge state={row.state} label={row.stateLabel} /> : null}
            {row.why}
            <ReadIn state={row.readInState} colored={!row.state} />
          </span>
          <span className="hm-acts">
            <button type="button" className="hm-btn is-quiet hm-act-quiet" data-home-verb={row.verb.action} onClick={runVerb} disabled={!!busy} tabIndex={-1}>
              {row.verb.label}
            </button>
            <button type="button" className="hm-btn is-primary is-sm hm-act-primary" data-home-verb={row.verb.action} onClick={runVerb} disabled={!!busy}>
              {row.verb.label}
            </button>
          </span>
        </div>
        {row.resolve ? (
          // Log & fix: every row can be set aside (src/components/needs/SetAside.tsx): Not now until the next working
          // day, or Not needed with a reason where the rule allows it. A gap row's own item keeps Done.
          <span className="hm-hover-acts" data-home-resolve>
            <button
              type="button"
              className="hm-icon-btn"
              aria-label={`Not now: back ${v.moveLabel}`}
              title={`Not now: back ${v.moveLabel}`}
              data-home-not-now
              onClick={(e) => {
                e.stopPropagation();
                setAside.decide(row.resolve!, { kind: 'snooze', ...(v.moveAt ? { until: v.moveAt } : {}) });
              }}
            >
              ◔
            </button>
            {row.resolve.reasons.length ? <NotNeededButton resolve={row.resolve} label="Not needed…" question="Why is this not needed?" onPick={(reason) => setAside.decide(row.resolve!, { kind: 'not_needed', reason })} /> : null}
            {row.item ? (
              <button
                type="button"
                className="hm-icon-btn"
                aria-label="Mark done"
                title="Done (d)"
                data-home-done
                onClick={(e) => {
                  e.stopPropagation();
                  v.actions.done(row.item!, row.title);
                }}
              >
                ✓
              </button>
            ) : null}
          </span>
        ) : row.item ? (
          <span className="hm-hover-acts">
            <button
              type="button"
              className="hm-icon-btn"
              aria-label={`Move to ${v.moveLabel}`}
              title={`Move to ${v.moveLabel} (s)`}
              onClick={(e) => {
                e.stopPropagation();
                v.actions.snooze(row.item!, row.title);
              }}
            >
              ◔
            </button>
            <button
              type="button"
              className="hm-icon-btn"
              aria-label="Mark done"
              title="Done (d)"
              data-home-done
              onClick={(e) => {
                e.stopPropagation();
                v.actions.done(row.item!, row.title);
              }}
            >
              ✓
            </button>
          </span>
        ) : null}
        {err ? (
          <span className="hm-err" role="alert">
            Couldn’t {err.verb}: {err.message}
            <button type="button" className="hm-link" onClick={(e) => (e.stopPropagation(), err.retry())}>
              Retry
            </button>
          </span>
        ) : null}
      </div>
    </div>
  );
}

function Initiatives({ section }: { section: HomeSection }) {
  const v = useHomeView();
  return (
    <ul className="hm-inits">
      {section.rows.map((row) => {
        const key = rowKey(section.id, row);
        const t = v.target(key);
        const cls = row.heat === 'hot' ? 'is-hot' : row.heat === 'at_risk' || row.heat === 'drifting' ? 'is-risk' : row.heat === 'paused' ? 'is-paused' : '';
        return (
          <li
            key={row.id}
            tabIndex={0}
            data-home-key={key}
            data-live={v.liveOf?.(key)}
            className={v.selectedKey === key ? 'is-selected' : undefined}
            title={`${row.title} · ${row.why}`}
            onClick={() => t && v.openTarget(t)}
            onFocus={() => v.select(key)}
          >
            <span className="hm-dot" data-tone={row.state ?? undefined} aria-hidden />
            <span className={`nm${row.heat === 'paused' ? ' is-paused' : ''}`}>{row.title}</span>
            <span className={`nx ${cls}`}>{row.heat === 'at_risk' || row.heat === 'drifting' ? `▲ ${row.stateLabel}` : (row.stateLabel ?? row.why)}</span>
            <span className="dt">{row.dateLabel}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * One verb column: the domain SectionColumn shell (title, count, sub, batch action, "See all N →") with
 * Home's rows inside. Home rows are engine view models (gaps, meetings, folded promises, initiatives), so
 * they render with HomeRowView rather than WorkRow. Rows arrive capped by the server (3, or 5 with ?wide=1).
 */
export function SectionColumn({ section, strip }: { section: HomeSection; strip?: HomeAheadDay[] }) {
  const inits = section.id === 'initiatives';
  const rows = inits ? (section.rows.length ? [<Initiatives key="list" section={section} />] : []) : section.rows.map((r) => <Row key={r.id} section={section} row={r} />);
  return (
    <DomainSectionColumn
      id={`hm-sec-${section.id}`}
      title={section.title}
      count={section.count}
      sub={section.sub ?? undefined}
      action={
        section.batch ? (
          <AppLink className="hm-link" href={section.batch.href}>
            {section.batch.label}
          </AppLink>
        ) : undefined
      }
      cap={inits ? 1 : 3}
      capWide={inits ? 1 : 5}
      total={inits ? 1 : section.count}
      seeAllHref={section.seeAllHref}
      seeAllLabel={`${section.seeAllLabel} →`}
      before={strip ? <AheadStrip days={strip.map((d) => ({ date: d.date, count: d.count, atRisk: d.risk, summary: d.summary, big: d.big }))} label="Items per day" className="hm-strip-slot" /> : undefined}
      empty={useFillingEmpty(section.empty)}
      className={`hm-sec is-${section.id}`}
    >
      {rows}
    </DomainSectionColumn>
  );
}

