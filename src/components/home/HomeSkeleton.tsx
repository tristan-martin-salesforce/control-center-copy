/**
 * Home's loading skeleton, data-free: the masthead, day ribbon, Do now cards, verb columns and the closing line in
 * the final layout. Bars sit in the real classes' line boxes (headline, row title, why line), so each block has
 * the height it will have and nothing jumps when /home lands. HomePage renders it on first load; the route's
 * loading.tsx and the shell's pending-navigation skeleton render it before the route arrives. It imports only
 * home.css, so the frame can render it before Home's own chunk loads.
 */
import './home.css';

/** A non-breaking space gives a bar its line box (the real text's height). */
const NBSP = ' ';

export function Skel({ w, h = 14, className }: { w: string | number; h?: number; className?: string }) {
  return <span aria-hidden className={`hm-skel${className ? ` ${className}` : ''}`} style={{ display: 'block', width: w, height: h }} />;
}

/** A bar one line of the parent's text tall. */
function Line({ w }: { w: string | number }) {
  return (
    <span aria-hidden className="hm-skel" style={{ display: 'inline-block', width: w, maxWidth: '100%', verticalAlign: 'top' }}>
      {NBSP}
    </span>
  );
}

export function MastheadSkeleton() {
  return (
    <section className="hm-mast" aria-busy="true" aria-label="Loading today">
      <div className="hm-mast-date">
        <Line w={220} />
      </div>
      <p className="hm-headline">
        <Line w="92%" />
        <br />
        <Line w="60%" />
      </p>
      <p className="hm-dek">
        <Line w="90%" />
        <br />
        <Line w="70%" />
      </p>
    </section>
  );
}

export function RibbonSkeleton() {
  return (
    <section className="hm-day" aria-busy="true" aria-label="Loading the day">
      <Skel w="100%" h={44} />
      <div className="hm-axis" />
    </section>
  );
}

export function DoNowSkeleton() {
  return (
    <section className="hm-lead-wrap" aria-busy="true" aria-label="Loading Do now">
      <div className="hm-lead-head">
        <h2>Do now</h2>
        <Skel w={240} />
      </div>
      <div className="hm-lead">
        {[0, 1, 2].map((i) => (
          <div key={i} className="hm-panel hm-card" style={{ minHeight: 230, cursor: 'default' }}>
            <Skel w="40%" h={24} />
            <Skel w="80%" h={26} />
            <Skel w="65%" />
            <span style={{ flex: 1 }} />
            <Skel w="30%" h={36} />
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * `id` gives the column its `is-<id>` class, so the condensed rules apply (Chase folds into the closing line while
 * the panel is open); `strip`: Think ahead's 14-day strip sits under its head.
 */
export function SectionSkeleton({ title, id, strip }: { title: string; id?: string; strip?: boolean }) {
  return (
    <div className={id ? `hm-sec is-${id}` : 'hm-sec'} aria-busy="true">
      <div className="hm-sec-head">
        <h2>{title}</h2>
      </div>
      {strip ? (
        <div className="hm-strip-slot">
          <Skel w="100%" h={40} />
        </div>
      ) : null}
      {[0, 1, 2].map((i) => (
        // 73 px: a real row's title, why line and its badge.
        <div key={i} className="hm-row" style={{ minHeight: 73, cursor: 'default' }}>
          <span className="hm-edge" aria-hidden />
          <span className="hm-row-title">
            <Line w={`${70 - i * 12}%`} />
          </span>
          <div className="hm-row-line">
            <span className="hm-why">
              <Line w={160} />
            </span>
          </div>
        </div>
      ))}
      <div className="hm-sec-foot">
        <Line w={72} />
      </div>
    </div>
  );
}

const SECTIONS: Array<[id: string, title: string]> = [
  ['ahead', 'Think ahead'],
  ['fix', 'Log & fix'],
  ['chase', 'Chase'],
  // Shown only at ≥ 2,000 px of main (home.css), like the real fifth column.
  ['initiatives', 'Initiatives'],
];

export function HomeSkeleton() {
  return (
    <div className="cc-home" data-home-root data-state="loading" aria-busy="true">
      <MastheadSkeleton />
      <RibbonSkeleton />
      <DoNowSkeleton />
      <section className="hm-panel hm-sections">
        {SECTIONS.map(([id, t]) => (
          <SectionSkeleton key={id} id={id} title={t} strip={id === 'ahead'} />
        ))}
      </section>
      <footer className="hm-end" aria-hidden>
        <span className="hm-end-title">That’s everything for today.</span>
        <span className="hm-end-status">
          <Line w={320} />
        </span>
      </footer>
    </div>
  );
}
