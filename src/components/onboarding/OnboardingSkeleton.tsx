'use client';
/**
 * Onboarding's frame pieces and its data-free loading skeleton (the route's loading.tsx, the gate while it hands
 * over, and the page before its state arrives), in the final three-pane grid so nothing jumps when data lands.
 */
import { ONBOARDING_STEPS } from '@/contract';
import type { ReactNode } from 'react';
import { Skeleton } from '@/ui';
import { STEP_META } from './derive';
import o from './onboarding.module.css';

export function OnboardingTopBar({ step, right }: { step?: ReactNode; right?: ReactNode }) {
  return (
    <header className={o.top}>
      <div className={o.brand}>
        <span className={o.mark} aria-hidden>
          cc
        </span>
        <span className={o.brandName}>Command Center</span>
        <span className={o.brandSep} aria-hidden>
          ·
        </span>
        <span className={o.brandStep}>Set up{step ? <> · {step}</> : null}</span>
      </div>
      {right ? <div className={o.topRight}>{right}</div> : null}
    </header>
  );
}

export function OnboardingSkeleton() {
  return (
    <div className={o.root} data-testid="onboarding-skeleton" aria-busy="true">
      <OnboardingTopBar />
      <div className={o.grid}>
        <nav className={o.nav} aria-label="Setup steps">
          {ONBOARDING_STEPS.map((s, i) => (
            <span key={s} className={o.stepItem} aria-current={i === 0 ? 'step' : undefined}>
              <span className={o.stepNum}>{i + 1}</span>
              <span className={o.stepText}>
                <span className={o.stepLabel}>{STEP_META[s].label}</span>
                <span className={o.stepSum}> </span>
              </span>
            </span>
          ))}
        </nav>
        <main className={o.main}>
          <div className={o.scroll}>
            <section className={o.sec}>
              <header className={o.head}>
                <h1>{STEP_META.you.title}</h1>
                <p>{STEP_META.you.blurb}</p>
              </header>
              <div className="flex flex-col gap-6 pt-6" aria-hidden>
                <Skeleton variant="line" count={3} className="max-w-[40rem]" />
                <Skeleton variant="block" className="h-40 w-full" />
                <Skeleton variant="block" className="h-40 w-full" />
              </div>
            </section>
          </div>
          <footer className={o.foot} aria-hidden>
            <span className={o.footState}> </span>
          </footer>
        </main>
        <aside className={o.aside} aria-label="What this changes">
          <div className="flex flex-col gap-4" aria-hidden>
            <Skeleton variant="line" className="w-40" />
            <Skeleton variant="block" className="h-48 w-full" />
          </div>
        </aside>
      </div>
    </div>
  );
}
