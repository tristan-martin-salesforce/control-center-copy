'use client';
/**
 * Home ▸ Plan (01 R3, H-10: Today folded into Home). The toggle on Home's date line switches between the briefing and
 * the plan; the plan is the Today page's own tree (TodayView: the day column, the run of the day, the meter), so
 * `/today` and Home ▸ Plan never diverge. `p` toggles, from either side. The topbar title stays Home's (the route
 * table): the toggle is a view of Home, not another page.
 */
import { useCallback } from 'react';
import { SegmentedToggle } from '@/ui';
import { navigate } from '@/components/shell/router';
import { TodayView } from '@/components/today/TodayPage';

export type HomeMode = 'home' | 'plan';

/** `/?view=plan` is Home ▸ Plan; anything else is the briefing. */
export function homeModeOf(q: { get(name: string): string | null }): HomeMode {
  return q.get('view') === 'plan' ? 'plan' : 'home';
}

export function homeModeHref(mode: HomeMode): string {
  return mode === 'plan' ? '/?view=plan' : '/';
}

export function useSetHomeMode() {
  return useCallback((m: HomeMode) => navigate(homeModeHref(m), { replace: true }), []);
}

export function ViewToggle({ mode, onMode }: { mode: HomeMode; onMode: (m: HomeMode) => void }) {
  return (
    <span className="hm-view-toggle" title="Plan: the day column and the run of the day (p)" data-testid="home-view-toggle">
      <SegmentedToggle<HomeMode>
        size="xs"
        label="Home view"
        value={mode}
        onChange={onMode}
        options={[
          { value: 'home', label: 'Home' },
          { value: 'plan', label: 'Plan' },
        ]}
      />
    </span>
  );
}

export function HomePlan({ onMode }: { onMode: (m: HomeMode) => void }) {
  const back = useCallback(() => onMode('home'), [onMode]);
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2" data-home-mode="plan" data-testid="home-plan">
      <div className="flex items-center gap-3 px-6 pt-4">
        <ViewToggle mode="plan" onMode={onMode} />
        <span className="text-caption text-muted">The day column and the run of the day, the same as Today.</span>
      </div>
      <div className="min-h-0 flex-1">
        <TodayView embedded onPlanKey={back} />
      </div>
    </div>
  );
}
