'use client';
/**
 * Settings v2 (docs/archive/2026-build/DESIGN-V2.md "Settings: three panes"; UI-SPEC §8, §12), in five sections
 * (01-ui-audit R8): Me · Sources · Sending · Budgets · Data, then Advanced (folded):
 *   section nav (each section's pages show their current value) · one selected page (label-left rows, its own
 *   save model in the header) · an effect pane showing what the setting changes (beside the page from ~1,600 px
 *   wide, under it below that).
 * The page never scrolls; each pane scrolls on its own. `?section=` is the URL state, "Find a setting" (⌘K while
 * on this page) filters the nav, and edits wait in each section while you look at another one.
 */
import { usePathname, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { clearChatContext, setChatContext } from '@/components/chat';
import { useApi } from '@/client/hooks';
import { personaOf } from '@/personas';
import { useCommands, useKeyBinding } from '@/client/keyboard';
import { PageHeader } from '@/components/kit';
import { cn, Icon, KbdHint, PanelBoundary } from '@/ui';
import { fmtUsd } from '@/ui/format';
import { AboutEffect, AboutSection, aboutSummary } from './AboutSection';
import { AgentSection } from './AgentSection';
import { AssistantLimitsSection, BudgetsSection, DisplaySection, ProfileSection, SendingSection, ThresholdsSection } from './BasicSections';
import { Glyph } from './controls';
import { AssistantMemoryBlock } from './AssistantMemory';
import { ClosingSection } from './ClosingSection';
import { ClosingEngineSection, RoutingAndRankingSection } from './EngineSwitches';
import { asSectionId, closingSummary, groupOf, matchSections, sectionCrumb, SECTION_GROUPS, SECTIONS, type SectionId } from './derive';
import { DataEffect, DataSection, retentionSummary } from './DataSection';
import { CoverageSlot, SpendReceipts } from './SectionExtras';
import { FeedbackSection } from '@/components/feedback/FeedbackSettingsSection';
import { EffectPane } from './effects';
import { UnsavedGuard, useDirtySections } from './form';
import { useElementWidth } from './hooks';
import { PolicyEffect } from './PolicyEffect';
import { PolicySection } from './PolicySection';
import { RoleEffect, RoleSection } from './RoleSection';
import { personaErrors, roleSummary } from './role';
import { ScanningEffect, ScanningSection, scanningSummary } from './ScanningSection';
import { BROKEN, cadenceText, ConnectorsSection, WatchesSection } from './SourcesSections';
import { SettingsModelProvider, useSettingsModel } from './state';
import { TimeEffect, TimeSection, timeSummary } from './TimeSection';
import s from './settings.module.css';
import { navigate } from '@/components/shell/router';

/** The Settings frame's width (container px) from which the effect pane gets its own column (settings.module.css). */
export const EFFECT_RAIL_MIN = 1360;

const REPLIES: Record<string, string> = { L0: 'Replies suggested', L1: 'Replies drafted for you', L2: 'Replies staged', L3: 'Replies one-click', L4: 'Replies sent on their own' };

function useSummaries(): { text: Partial<Record<SectionId, string>>; attn: { connectors: number } } {
  const m = useSettingsModel();
  const settings = useApi('getSettings');
  const health = useApi('getHealth');
  const versions = useApi('getPolicyVersions');
  const appVersion = useApi('getVersion', undefined, { staleTime: 60_000 });
  const retention = useApi('getRetention');
  const st = settings.data;
  const text: Partial<Record<SectionId, string>> = {};
  if (st) {
    // D-55: the role reads from the persona (an AE is not an SE IC)
    text.profile = `${personaOf(st).id === 'se' ? (st.profile.role === 'se_manager' ? 'SE manager' : 'SE (IC)') : personaOf(st).levelLabel} · ${st.profile.timezone}`;
    text.role = roleSummary(personaOf(st));
    const v = versions.data?.versions.find((x) => x.version === st.policy.version);
    text.policy = `v${st.policy.version} · ${!v || v.by === 'system' ? 'starter pack' : v.by === 'chat' ? 'changed in chat' : 'edited by you'}`;
    const lvl = st.agentBehavior.autonomy.slack_reply ?? st.agentBehavior.autonomy.email_reply;
    text.agent = lvl ? `${REPLIES[lvl]} (${lvl})` : 'Autonomy per action';
    const ch = st.sending.channels;
    text.sending = `${st.sending.dryRun ? 'Dry run' : 'Live send'} · Slack ${ch?.slack?.mode ?? 'draft'}, Gmail ${ch?.gmail?.mode ?? 'draft'} · ${st.sending.undoWindowSec} s undo`;
    text.budgets = `${fmtUsd(st.budgets.softUsd)}/day${health.data ? ` · ${fmtUsd(health.data.spend.today.usd)} used` : ''}`;
    text.time = timeSummary(st.time);
    text.scanning = scanningSummary(st.scanning);
    if (st.closing) text.closing = closingSummary(st.closing);
  }
  if (appVersion.data) text.about = aboutSummary(appVersion.data);
  if (retention.data) text.data = retentionSummary(retention.data);
  const d = m.display;
  text.display = `${{ dark: 'Dark', light: 'Light', system: 'System' }[d.scheme]} · ${d.textSize} px · ${d.density}`;
  const t = m.thresholds.saved;
  text.thresholds = `Auto-close when ${t.autoCloseMin === 'sure' ? 'sure' : 'likely'} · reopen ${t.reopenWindowDays} d`;
  const cs = health.data?.connectors ?? [];
  const broken = cs.filter((c) => BROKEN.has(c.state)).length;
  if (cs.length) text.connectors = broken ? `${cs.length - broken} of ${cs.length} live` : `All ${cs.length} live`;
  const on = m.watches.server.filter((w) => w.enabled);
  if (m.watches.query.data) text.watches = on.length ? `${on.length} on · ${[...new Set(on.map((w) => cadenceText(w.cadence).toLowerCase()))].join(', ')}` : 'None on';
  return { text, attn: { connectors: broken } };
}

function SectionNav({ active, go, query }: { active: SectionId; go: (id: SectionId) => void; query: string }) {
  const { text, attn } = useSummaries();
  const dirty = useDirtySections();
  const visible = new Set(query.trim() ? matchSections(query, text) : SECTIONS.map((x) => x.id));
  const ref = useRef<HTMLElement>(null);
  const [openAdvanced, setOpenAdvanced] = useState(false);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...(ref.current?.querySelectorAll<HTMLAnchorElement>('a[data-go]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLAnchorElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    if (next) {
      e.preventDefault();
      next.focus();
    }
  };
  return (
    <nav className={s.nav} aria-label="Settings sections" ref={ref} onKeyDown={onKeyDown} data-testid="settings-nav">
      {SECTION_GROUPS.map((g) => {
        const items = g.items.filter((it) => visible.has(it.id));
        if (!items.length) return null;
        // Advanced folds unless you opened it, a search reaches into it, or one of its pages is open
        const folded = !!g.collapsed && !openAdvanced && !query.trim() && groupOf(active).id !== g.id;
        return (
          <div className={s.group} key={g.id} data-group={g.id} role="group" aria-labelledby={`sg-${g.id}`}>
            {g.collapsed ? (
              <button
                type="button"
                id={`sg-${g.id}`}
                aria-expanded={!folded}
                onClick={() => setOpenAdvanced(folded)}
                data-testid={`settings-group-${g.id}`}
                className="flex items-center gap-1.5 rounded-md px-3 pt-1 pb-1 text-left text-body font-bold text-fg-heading hover:bg-surface-muted focus-visible:shadow-focus focus-visible:outline-none"
              >
                <Icon name={folded ? 'chevronright' : 'chevrondown'} size="xs" className="text-faint" />
                {g.label}
                <span className="ml-auto text-caption font-normal text-faint">{folded ? g.items.length : ''}</span>
              </button>
            ) : (
              <div id={`sg-${g.id}`} className="px-3 pt-1 text-body font-bold text-fg-heading" data-testid={`settings-group-${g.id}`}>
                {g.label}
              </div>
            )}
            <div className="px-3 pb-1 text-caption text-faint">{g.blurb}</div>
            {folded ? null : items.map((it) => (
              <a
                key={it.id}
                href={`?section=${it.id}`}
                data-go={it.id}
                className={s.item}
                aria-current={active === it.id ? 'page' : undefined}
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                  e.preventDefault();
                  go(it.id);
                }}
              >
                <span className={s.itemTitle}>{it.label}</span>
                {dirty.has(it.id) ? (
                  <span className={s.edited} data-testid={`edited-${it.id}`}>
                    Edited
                  </span>
                ) : (
                  <span />
                )}
                <span className={s.itemSum}>
                  {it.id === 'connectors' && attn.connectors ? (
                    <>
                      <span className={s.attn}>
                        <Glyph name="warn" className={s.attnIcon} />
                        {attn.connectors} need{attn.connectors === 1 ? 's' : ''} auth
                      </span>
                      {text.connectors ? ` · ${text.connectors}` : ''}
                    </>
                  ) : (
                    (text[it.id] ?? ' ')
                  )}
                </span>
              </a>
            ))}
          </div>
        );
      })}
      {visible.size === 0 ? <p className={s.noMatch}>No setting matches “{query.trim()}”.</p> : null}
      <div className={s.navFoot}>
        <span>Each section says how it saves.</span>
        <span>Edits wait here while you look elsewhere.</span>
      </div>
    </nav>
  );
}

function ActiveSection({ id, connector, onConnector }: { id: SectionId; connector: string | null; onConnector: (id: string) => void }) {
  switch (id) {
    case 'profile':
      return (
        <>
          <ProfileSection />
          <CoverageSlot />
        </>
      );
    case 'role':
      return <RoleSection />;
    case 'display':
      return <DisplaySection />;
    case 'time':
      return <TimeSection />;
    case 'policy':
      return <PolicySection />;
    case 'thresholds':
      return <ThresholdsSection />;
    case 'closing':
      return <ClosingSection />;
    case 'agent':
      return <AgentSection />;
    case 'sending':
      return (
        <>
          <SendingSection />
          <ClosingEngineSection />
        </>
      );
    case 'budgets':
      return (
        <>
          <BudgetsSection />
          <AssistantLimitsSection />
          <RoutingAndRankingSection />
          <AssistantMemoryBlock />
          <SpendReceipts />
        </>
      );
    case 'connectors':
      return <ConnectorsSection selected={connector} onSelect={onConnector} />;
    case 'watches':
      return <WatchesSection />;
    case 'scanning':
      return <ScanningSection />;
    case 'feedback':
      return <FeedbackSection />;
    case 'data':
      return <DataSection />;
    case 'about':
      return <AboutSection />;
  }
}

function Effect({ id, connector }: { id: SectionId; connector: string | null }) {
  return (
    <PanelBoundary name={`settings-effect-${id}`} resetKeys={[id]}>
      {id === 'policy' ? <PolicyEffect /> : id === 'scanning' ? <ScanningEffect /> : id === 'time' ? <TimeEffect /> : id === 'role' ? <RoleEffect /> : id === 'about' ? <AboutEffect /> : id === 'data' ? <DataEffect /> : <EffectPane section={id} connector={connector} />}
    </PanelBoundary>
  );
}

function SettingsFrame() {
  const params = useSearchParams();
  const pathname = usePathname();
  const active = asSectionId(params.get('section'));
  const m = useSettingsModel();
  const [query, setQuery] = useState('');
  const [connector, setConnector] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const spaneRef = useRef<HTMLDivElement>(null);
  const epaneRef = useRef<HTMLElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const width = useElementWidth(rootRef);
  // the effect pane sits beside the page only when the form keeps room (01-ui-audit UI-32: at 1440 four columns
  // squeezed it to ~550 px); below this it follows the page in the same scroll
  const narrow = width > 0 && width < EFFECT_RAIL_MIN;

  const go = useCallback(
    (id: SectionId) => {
      const p = new URLSearchParams(params.toString());
      p.set('section', id);
      navigate(`${pathname}?${p.toString()}`, { replace: true });
    },
    [params, pathname],
  );
  useEffect(() => {
    spaneRef.current?.scrollTo?.({ top: 0 });
    epaneRef.current?.scrollTo?.({ top: 0 });
  }, [active]);

  useEffect(() => {
    setChatContext({ kind: 'settings', id: 'settings', label: 'Settings' });
    return () => clearChatContext({ kind: 'settings', id: 'settings' });
  }, []);

  // ⌘K on this page focuses "Find a setting"; pressed again (while in the box) it opens the command palette.
  useKeyBinding(
    'mod+k',
    () => {
      if (document.activeElement === findRef.current) return false;
      findRef.current?.focus();
      findRef.current?.select();
      return true;
    },
    { allowInInput: true, description: 'Find a setting' },
  );

  const commands = useMemo(() => {
    const base = SECTIONS.map((x, n) => ({ id: `settings.${x.id}`, title: `Settings: ${groupOf(x.id).label} ▸ ${x.label}`, group: 'Settings', order: n, keywords: x.keywords.split(' '), run: () => go(x.id) }));
    const p = m.policy;
    const extra = [];
    if (p.dirty && !p.fresh) extra.push({ id: 'settings.policy.preview', title: 'Preview re-rank', group: 'Settings', order: 20, run: () => (go('policy'), p.runPreview()) });
    if (p.fresh) extra.push({ id: 'settings.policy.apply', title: `Apply policy as v${(p.policy?.version ?? 0) + 1}`, group: 'Settings', order: 21, run: () => p.runApply() });
    if (p.dirty) extra.push({ id: 'settings.policy.discard', title: 'Discard policy edits', group: 'Settings', order: 22, run: () => p.discard() });
    if (p.lastApply) extra.push({ id: 'settings.policy.undo', title: 'Undo the last policy apply', group: 'Settings', order: 23, run: () => p.undo.mutate({ params: { id: p.lastApply!.auditId }, body: {} }) });
    const saves: Array<[string, boolean, () => void]> = [
      ['Profile & hours', m.profile.dirty, () => void m.profile.save()],
      ['Role & rules', m.role.dirty && !Object.keys(personaErrors(m.role.draft)).length, () => void m.role.save()],
      ['Thresholds', m.thresholds.dirty, m.thresholds.save],
      ['Budgets', m.budgets.dirty, () => void m.budgets.save()],
      ['Watches', m.watches.dirty, () => void m.watches.save()],
    ];
    saves.forEach(([label, dirty, run], i) => dirty && extra.push({ id: `settings.save.${i}`, title: `Save ${label}`, group: 'Settings', order: 30 + i, run }));
    for (const [scheme, label] of [
      ['dark', 'Dark'],
      ['light', 'Light'],
      ['system', 'System'],
    ] as const)
      if (m.display.scheme !== scheme) extra.push({ id: `settings.theme.${scheme}`, title: `Theme: ${label}`, group: 'Settings', order: 40, run: () => m.display.set({ scheme }) });
    return [...base, ...extra];
  }, [go, m]);
  useCommands(commands);

  const effect = <Effect id={active} connector={connector} />;

  return (
    <div className={s.root} ref={rootRef} data-testid="settings-page" data-section={active}>
      <header className={s.topbar}>
        <PageHeader route="settings" titleIn="topbar" inset={false} rule={false} className="min-w-0 flex-1" crumb={sectionCrumb(groupOf(active).label, SECTIONS.find((x) => x.id === active)?.label ?? '')} />
        <label className={s.find}>
          <Glyph name="search" className={s.findGlyph} />
          <input
            ref={findRef}
            type="search"
            placeholder="Find a setting…"
            aria-label="Find a setting"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const first = query.trim() ? matchSections(query)[0] : undefined;
                if (first) go(first);
              } else if (e.key === 'Escape') {
                setQuery('');
                e.currentTarget.blur();
              }
            }}
          />
          <KbdHint combo="mod+k" />
        </label>
      </header>
      <div className={s.grid}>
        <SectionNav active={active} go={go} query={query} />
        <div className={s.spane} ref={spaneRef}>
          <PanelBoundary name={`settings-${active}`} resetKeys={[active]}>
            <ActiveSection id={active} connector={connector} onConnector={setConnector} />
          </PanelBoundary>
          {narrow ? <div className={s.narrowEffect}>{effect}</div> : null}
        </div>
        {!narrow ? (
          <aside className={cn(s.epane)} ref={epaneRef} aria-label="Effect preview" data-testid="settings-effect">
            {effect}
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export function SettingsPage() {
  return (
    <UnsavedGuard>
      <SettingsModelProvider>
        <SettingsFrame />
      </SettingsModelProvider>
    </UnsavedGuard>
  );
}
