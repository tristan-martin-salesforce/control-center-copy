'use client';
/**
 * Priority policy effect pane: what your top 5 would do before anything re-ranks.
 * - The lists come from the real preview route (POST /policy/preview): the current order, and after apply.
 * - ▲ / ▼ (green / amber) and "was #N" mark moves; who enters and who drops out is spelled out.
 * - Click a row for its score breakdown (weight × signal, plus rules); the changed part is blue, a grey tick
 *   marks where it was.
 * - "What changed recently" is the policy's version history, with Revert and Undo.
 * - At 860 px of pane and wider, the lists become a top 10 before/after slope view.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { PolicyVersion } from '@/contract';
import { useApi } from '@/client/hooks';
import { useRightPanel } from '@/components/shell';
import { Button, cn, Skeleton, useNow } from '@/ui';
import { fmtAgo, fmtClock, fmtDay } from '@/ui/format';
import { compareRanks, scoreBreakdown, type CompareRow, type RankCompare } from './derive';
import { useElementWidth } from './hooks';
import { useSettingsModel } from './state';
import s from './settings.module.css';

const DIV_H = 32;
const fmt = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

function Move({ row }: { row: CompareRow }) {
  if (row.was === null) return <span className={cn(s.mv, s.mvUp)} aria-label="New in your top 10">▲ new</span>;
  const d = row.was - row.rank;
  if (d > 0)
    return (
      <span className={cn(s.mv, s.mvUp)} aria-label={`Up ${d}`}>
        ▲ {d}
      </span>
    );
  if (d < 0)
    return (
      <span className={cn(s.mv, s.mvDown)} aria-label={`Down ${-d}`}>
        ▼ {-d}
      </span>
    );
  return (
    <span className={cn(s.mv, s.mvSame)} aria-label="No change">
      –
    </span>
  );
}

function RankItem({ row, mode, selected, onPick }: { row: CompareRow; mode: 'now' | 'after' | 'single'; selected: boolean; onPick: (id: string) => void }) {
  const moved = mode === 'after' && row.was !== row.rank;
  const why = moved ? `${row.was === null ? 'new' : `was #${row.was}`}${row.why ? ` · ${row.why}` : ''}` : (row.why ?? '');
  return (
    <li
      className={cn(s.rk, row.rank > 5 && s.outside, selected && s.rkSel)}
      data-rank-row={row.id}
      tabIndex={0}
      // a pick in a list: an option of its listbox (an li can't be a button, and a list holds only list items)
      role="option"
      aria-selected={selected}
      title={row.title}
      onClick={() => onPick(row.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPick(row.id);
        }
      }}
    >
      <span className={s.rkN}>{row.rank}</span>
      {mode === 'after' ? <Move row={row} /> : mode === 'single' ? <span className={cn(s.mv, s.mvSame)} aria-hidden /> : null}
      <span className={s.rkBody}>
        <span className={s.rkTitle}>{row.title}</span>
        {why ? <span className={s.rkWhy}>{why}</span> : null}
      </span>
    </li>
  );
}

function RankList({ rows, mode, n, selected, onPick, label }: { rows: CompareRow[]; mode: 'now' | 'after' | 'single'; n: number; selected: string | null; onPick: (id: string) => void; label: string }) {
  const out: ReactNode[] = [];
  rows.slice(0, n).forEach((r, i) => {
    if (i === 5)
      out.push(
        <li key="div" className={s.divRow} aria-hidden>
          {n > 6 ? 'Rest of your top 10' : 'Outside your top 5'}
        </li>,
      );
    out.push(<RankItem key={r.id} row={r} mode={mode} selected={r.id === selected} onPick={onPick} />);
  });
  return (
    <ol role="listbox" aria-label={label}>
      {out}
    </ol>
  );
}

function SlopeLines({ cmp, n, rowH, selected }: { cmp: RankCompare; n: number; rowH: number; selected: string | null }) {
  const now = cmp.now.slice(0, n);
  const after = cmp.after.slice(0, n);
  const H = n * rowH + (n > 5 ? DIV_H : 0);
  const y = (i: number) => i * rowH + (i >= 5 ? DIV_H : 0) + rowH / 2;
  const aIdx = new Map(after.map((r, i) => [r.id, i]));
  const nIdx = new Map(now.map((r, i) => [r.id, i]));
  const paths: ReactNode[] = [];
  now.forEach((r, i) => {
    const j = aIdx.get(r.id);
    const y1 = y(i);
    const y2 = j === undefined ? H + 12 : y(j);
    const cls = j === i ? s.same : j === undefined || j > i ? s.down : s.up;
    paths.push(<path key={`n${r.id}`} className={cn(cls, r.id === selected && s.lineSel)} d={`M2 ${y1} C 64 ${y1}, 64 ${y2}, 126 ${y2}`} strokeDasharray={j === undefined ? '4 4' : undefined} />);
  });
  after.forEach((r, j) => {
    if (nIdx.has(r.id)) return;
    const y2 = y(j);
    paths.push(<path key={`a${r.id}`} className={cn(s.up, r.id === selected && s.lineSel)} strokeDasharray="4 4" d={`M2 ${H + 12} C 64 ${H + 12}, 64 ${y2}, 126 ${y2}`} />);
  });
  return (
    <svg className={s.cmpLines} viewBox={`0 0 128 ${H}`} height={H} aria-hidden>
      {paths}
    </svg>
  );
}

function Breakdown({ id, cmp, previewing }: { id: string; cmp: RankCompare; previewing: boolean }) {
  const { policy: m } = useSettingsModel();
  const panel = useRightPanel();
  const detail = useApi('getItem', { params: { id } });
  const nowRow = cmp.now.find((r) => r.id === id) ?? null;
  const afterRow = previewing ? (cmp.after.find((r) => r.id === id) ?? null) : null;
  const item = detail.data?.item;
  const title = item?.title ?? afterRow?.title ?? nowRow?.title ?? '';
  const draft = previewing && m.preview ? m.preview.draft : null;
  const bd = item && m.saved ? scoreBreakdown(item.rankReasons, nowRow?.score ?? item.score, m.saved, draft, afterRow?.score ?? null) : null;
  const nowTotal = bd?.nowTotal ?? nowRow?.score ?? 0;
  const afterTotal = previewing ? (afterRow?.score ?? bd?.afterTotal ?? null) : null;
  const rankNow = nowRow?.rank ?? null;
  const rankAfter = previewing ? (afterRow?.rank ?? null) : rankNow;
  const max = bd ? Math.max(0.1, ...bd.lines.map((l) => Math.max(Math.abs(l.now), Math.abs(l.after ?? 0)))) : 1;
  const tot = afterTotal !== null && Math.abs(afterTotal - nowTotal) > 1e-9 ? `${fmt(nowTotal)} → ${fmt(afterTotal)}` : fmt(nowTotal);
  const sign = (k: string, n: number) => ((k.startsWith('rule:') || k === 'boost' || k === 'other') && n > 0 ? `+${fmt(n)}` : fmt(n));

  return (
    <div className={s.card} aria-live="polite" data-testid="policy-breakdown">
      <div className={s.cardHead}>
        <h4>{rankAfter ? `Why it ranks #${rankAfter}` : 'Outside your top 10 after apply'}</h4>
        {previewing && rankNow && rankAfter !== rankNow ? <span className={s.muted}>was #{rankNow}</span> : null}
        <button type="button" className={s.linkBtn} onClick={() => panel.openDetails({ kind: 'work_item', id, label: title })}>
          Open
        </button>
      </div>
      <div className={s.bdTitle}>{title}</div>
      <div className={s.bdSub}>Score {tot} · weight × signal, plus rules</div>
      {detail.isLoading ? <Skeleton variant="row" count={3} /> : null}
      {detail.error ? (
        <p className={s.help}>
          Couldn’t load the breakdown.{' '}
          <button type="button" className={s.linkBtn} onClick={() => void detail.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {bd?.lines.map((l) => {
        const after = l.after ?? l.now;
        const changed = !!draft && l.changed;
        return (
          <div key={l.key} className={cn(s.bdRow, changed && s.changed)}>
            <span className={s.bdLab} title={l.label}>
              {l.label}
            </span>
            <span className={s.bdBar} aria-hidden>
              <i className={after < 0 ? 'neg' : undefined} style={{ width: `${(Math.abs(after) / max) * 100}%` }} />
              {changed ? <s style={{ left: `${(Math.abs(l.now) / max) * 100}%` }} /> : null}
            </span>
            <span className={s.bdVal}>{changed ? `${sign(l.key, l.now)} → ${l.after === null ? '?' : sign(l.key, l.after)}` : sign(l.key, l.now)}</span>
          </div>
        );
      })}
      {bd ? (
        <div className={cn(s.bdRow, s.total)}>
          <span className={s.bdLab}>Score</span>
          <span />
          <span className={s.bdVal}>{tot}</span>
        </div>
      ) : null}
    </div>
  );
}

function History() {
  const { policy: m } = useSettingsModel();
  const versions = useApi('getPolicyVersions');
  const now = useNow();
  const [all, setAll] = useState(false);
  const vs: PolicyVersion[] = [...(versions.data?.versions ?? [])].sort((a, b) => b.version - a.version);
  const current = m.policy?.version;
  const by = (v: PolicyVersion) => (v.by === 'user' ? 'you' : v.by === 'chat' ? 'the assistant' : 'the starter pack');
  return (
    <div className={s.card} data-testid="policy-history">
      <div className={s.cardHead}>
        <h4>What changed recently</h4>
        {vs.length > 3 || all ? (
          <button type="button" className={s.linkBtn} onClick={() => setAll((x) => !x)} aria-expanded={all}>
            {all ? 'Show recent' : `View audit log (${vs.length}) →`}
          </button>
        ) : null}
      </div>
      {versions.isLoading ? <Skeleton variant="row" count={2} /> : null}
      {versions.error ? (
        <p className={s.help}>
          Couldn’t load the history.{' '}
          <button type="button" className={s.linkBtn} onClick={() => void versions.refetch()}>
            Retry
          </button>
        </p>
      ) : null}
      {(all ? vs : vs.slice(0, 3)).map((v) => (
        <div key={v.version} className={s.ver} data-policy-version={v.version}>
          <span className={s.verN}>v{v.version}</span>
          <span className={s.verNote} title={v.note}>
            {v.note}
          </span>
          {v.version === current ? (
            m.lastApply ? (
              <Button size="sm" variant="secondary" icon="undo" loading={m.undo.isPending} onClick={() => m.undo.mutate({ params: { id: m.lastApply!.auditId }, body: {} })} data-testid="policy-undo">
                Undo
              </Button>
            ) : (
              <span className={s.verCur}>Current</span>
            )
          ) : (
            <Button size="sm" variant="secondary" loading={m.revert.isPending} disabled={!m.policy} onClick={() => m.policy && m.revert.mutate({ body: { ifVersion: m.policy.version, toVersion: v.version } })}>
              Revert
            </Button>
          )}
          <span className={s.verMeta}>
            Applied by {by(v)} · {fmtDay(v.at)} · {fmtAgo(v.at, now)}
          </span>
        </div>
      ))}
      {m.revert.error || m.undo.error ? (
        <p role="alert" className="text-body text-danger-700">
          Couldn’t {m.undo.error ? 'undo' : 'revert'}: {(m.undo.error ?? m.revert.error)!.message}
        </p>
      ) : null}
      <p className={s.help} style={{ marginTop: 8 }}>
        Apply saves a new version you can revert. Changes made from chat land here too.
      </p>
    </div>
  );
}

export function PolicyEffect() {
  const { policy: m } = useSettingsModel();
  const live = useApi('previewPolicy', { body: {} });
  const ref = useRef<HTMLDivElement>(null);
  const cmpRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const [rowH, setRowH] = useState(64);
  const wide = width >= 860;
  const n = wide ? 10 : 6;

  const shown = m.dirty ? m.preview : null;
  const base = shown?.data ?? live.data ?? null;
  const cmp = base ? compareRanks(base.before, shown ? base.after : base.before) : null;
  const previewing = !!shown;
  const firstMover = cmp && previewing ? cmp.after.find((r) => r.rank <= 5 && r.was !== r.rank)?.id : undefined;
  const ids = cmp ? new Set([...cmp.now, ...cmp.after].map((r) => r.id)) : new Set<string>();
  const selected = m.selected && ids.has(m.selected) ? m.selected : (firstMover ?? cmp?.now[0]?.id ?? null);

  // Row height follows density (--rk-h); the slope lines need it in px.
  const density = typeof document === 'undefined' ? null : document.documentElement.getAttribute('data-density');
  useLayoutEffect(() => {
    if (!cmpRef.current) return;
    const h = parseFloat(getComputedStyle(cmpRef.current).getPropertyValue('--rk-h'));
    if (h) setRowH(h);
  }, [density, previewing, wide]);
  // A new preview starts on its biggest story: the first row that moved.
  useEffect(() => {
    if (shown) m.setSelected(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown?.key]);

  const v = m.policy?.version ?? 1;
  const at = shown ? shown.at : live.dataUpdatedAt;
  let summary: ReactNode;
  if (shown && cmp) {
    const parts: ReactNode[] = [];
    cmp.enters.forEach((e, i) => parts.push(<span key={`e${e.id}`}>{i ? ', ' : ' '}<b>{e.title}</b> enters at #{e.rank}</span>));
    cmp.leaves.forEach((l, i) => parts.push(<span key={`l${l.id}`}>{i || cmp.enters.length ? '; ' : ' '}<b>{l.title}</b> drops {l.to ? `to #${l.to}` : 'out of your top 10'}</span>));
    const changes = m.policy && shown ? (m.changes.length ? m.changes : []) : [];
    summary = (
      <>
        <b>{changes.join(', ') || 'Your edit'}</b> {cmp.movedTop5 ? `moves ${cmp.movedTop5} of your top 5.` : 'leaves your top 5 as it is.'}
        {parts}
        {parts.length ? '.' : null}
      </>
    );
  } else if (m.dirty) {
    summary = (
      <>
        You changed <b>{m.changes.join(', ')}</b>. Preview the re-rank to see what moves before anything changes.
      </>
    );
  } else {
    summary = 'Change a weight or a rule, then preview: this pane shows what would move before anything re-ranks.';
  }

  return (
    <div className={s.ep} ref={ref} data-effect="policy">
      <div>
        <div className={s.kicker}>
          <h2>Effect preview</h2>
          <span className={s.badge} data-testid="policy-effect-badge">
            {previewing ? 'Not applied' : `v${v} · live`}
          </span>
        </div>
        <p className={s.sub}>{previewing ? `v${v} plus your edit · computed ${fmtClock(new Date(at))} from the real ranking` : `Live ranking · updated ${at ? fmtClock(new Date(at)) : '…'}`}</p>
      </div>
      <div>
        <h3 className={s.epTitle}>{previewing ? 'How your top 5 would reorder' : `Your top 5 under v${v}`}</h3>
        <p className={s.epSum} data-testid="policy-effect-summary">
          {summary}
        </p>
      </div>
      {m.stale ? (
        <div className={s.stale} role="status">
          ↻ <span>You changed the policy since this preview. Preview again to see what moves; Apply waits for it.</span>
        </div>
      ) : null}

      {!cmp ? (
        live.error ? (
          <div className={s.card}>
            <h4>Couldn’t load your ranking</h4>
            <p className={s.help}>{live.error.message}</p>
            <div className="mt-3">
              <Button size="sm" variant="secondary" onClick={() => void live.refetch()}>
                Retry
              </Button>
            </div>
          </div>
        ) : (
          <Skeleton variant="row" count={6} />
        )
      ) : cmp.now.length === 0 ? (
        <div className={s.card}>
          <h4>Nothing ranked yet</h4>
          <p className={s.help}>Open work appears here once the scanners find some. The policy still applies to whatever arrives.</p>
        </div>
      ) : (
        <div className={cn(s.cmp, !previewing && s.clean)} ref={cmpRef} data-testid="policy-compare">
          <div className={cn(s.cmpHead, s.cmpHeadNow)}>Now · v{v}</div>
          <div className={cn(s.cmpHead, s.cmpHeadGap)} />
          <div className={s.cmpHead}>{previewing ? 'After apply' : 'Top 5 now'}</div>
          <div className={s.cmpNow}>{previewing && wide ? <RankList rows={cmp.now} mode="now" n={n} selected={selected} onPick={m.setSelected} label="Current ranking" /> : null}</div>
          <div className={s.cmpLines}>{previewing && wide ? <SlopeLines cmp={cmp} n={n} rowH={rowH} selected={selected} /> : null}</div>
          <RankList rows={previewing ? cmp.after : cmp.now} mode={previewing ? 'after' : 'single'} n={n} selected={selected} onPick={m.setSelected} label={previewing ? 'Ranking after apply' : 'Current ranking'} />
        </div>
      )}

      <div className={cn(s.epGrid, s.wideL)}>
        {cmp && selected ? <Breakdown id={selected} cmp={cmp} previewing={previewing} /> : <div />}
        <History />
      </div>
    </div>
  );
}
