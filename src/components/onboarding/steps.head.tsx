'use client';
/**
 * Onboarding steps, shared: the step header and the field-error map (the entry is ./steps.tsx).
 */
import type { ReactNode } from 'react';
import type { OnboardingStep } from '@/contract';
import { STEP_META } from './derive';
import o from './onboarding.module.css';

export type Errors = Record<string, string>;

export function StepHead({ step, actions, headingRef }: { step: OnboardingStep; actions?: ReactNode; headingRef?: React.Ref<HTMLHeadingElement> }) {
  return (
    <header className={o.head}>
      <h1 ref={headingRef} tabIndex={-1} data-testid="onboarding-step-title">
        {STEP_META[step].title}
      </h1>
      {actions ? <div className={o.headActs}>{actions}</div> : <span />}
      <p>{STEP_META[step].blurb}</p>
    </header>
  );
}
