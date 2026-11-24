'use client';
/**
 * "Feedback" (D-56): the topbar button, next to Capture and the Assistant, on every page. The click captures where
 * the user is (page, route, what they were looking at, persona, recent client errors) BEFORE the panel opens, since
 * opening it changes the panel's entity, then opens the Feedback panel (`registerDetailRenderer('feedback')`,
 * src/components/feedback/register.ts). `useOpenFeedback` is the same click for other entry points (⌘K, the
 * Getting started checklist).
 */
import { useCallback, useEffect } from 'react';
import { usePersona } from '@/client/persona';
import { getChatContext } from '@/components/chat/context-store';
import { installClientErrorCapture, recentClientErrors } from '@/components/feedback/client-errors';
import { captureFeedbackContext, CLIENT_BUILD, openFeedbackReport } from '@/components/feedback/context';
import { Button } from '@/ui/Button';
import { cn } from '@/ui/cn';
import { Icon } from '@/ui/Icon';
import { Tooltip } from '@/ui/Tooltip';
import { useRightPanel } from './panel';

export const FEEDBACK_LABEL = 'Report a bug / idea';

/** Opens the Feedback panel with this page's context. Installs the client-error capture once. */
export function useOpenFeedback(): () => void {
  const panel = useRightPanel();
  const persona = usePersona();
  useEffect(() => installClientErrorCapture(), []);
  return useCallback(() => {
    const chat = getChatContext();
    const lookingAt = panel.open && panel.entity && panel.entity.kind !== 'feedback' ? panel.entity : chat ? { kind: chat.kind, id: chat.id, label: chat.label } : null;
    const ctx = captureFeedbackContext({
      pathname: window.location.pathname,
      search: window.location.search,
      lookingAt,
      persona: persona ? persona.levelLabel || persona.label : null,
      version: CLIENT_BUILD.version,
      sha: CLIENT_BUILD.sha,
      errors: recentClientErrors(),
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    panel.openDetails({ kind: 'feedback', id: openFeedbackReport(ctx), label: FEEDBACK_LABEL });
  }, [panel, persona]);
}

/** The topbar's "Feedback" button: front and center, between Capture and the Assistant. */
export function TopbarFeedback() {
  const open = useOpenFeedback();
  const panel = useRightPanel();
  const active = panel.open && panel.entity?.kind === 'feedback';
  return (
    <Tooltip content="Report a bug or an idea: the app diagnoses it, swaps names for placeholders, and you edit it before Send" side="bottom">
      <Button variant="secondary" size="sm" onClick={open} aria-label={`Feedback: ${FEEDBACK_LABEL}`} aria-pressed={active} data-feedback-entry className={cn(active && 'bg-selected')}>
        <Icon name="bug" size="sm" />
        <span className="@max-[760px]/topbar:sr-only">Feedback</span>
      </Button>
    </Tooltip>
  );
}
