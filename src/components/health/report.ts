'use client';
/**
 * "Report this" on a Setup row (11 R8): the Feedback panel opens with what the row was about (the dependency and its
 * catalog code) already in the report's context, so the owner groups reports by code without asking. The same capture
 * as the topbar's Feedback button; nothing is sent until the user reviews it (*Nothing leaves without approval*).
 */
import { useCallback } from 'react';
import { usePersona } from '@/client/persona';
import { recentClientErrors } from '@/components/feedback/client-errors';
import { captureFeedbackContext, CLIENT_BUILD, openFeedbackReport } from '@/components/feedback/context';
import { FEEDBACK_LABEL } from '@/components/shell/FeedbackButton';
import { useRightPanel } from '@/components/shell/panel';

/** The line the report carries for a Setup problem ("Setup · Slack · AUTH.SLACK.SIGNED_OUT: Slack needs you to sign in"). */
export function reportLine(label: string, code: string | null, title: string | null): string {
  return `Setup · ${label}${code ? ` · ${code}` : ''}${title ? `: ${title}` : ''}`;
}

export function useReportProblem(): (p: { depId: string; label: string; code: string | null; title: string | null }) => void {
  const panel = useRightPanel();
  const persona = usePersona();
  return useCallback(
    ({ depId, label, code, title }) => {
      const ctx = captureFeedbackContext({
        pathname: window.location.pathname,
        search: window.location.search,
        lookingAt: { kind: 'connector', id: depId, label: `${label} setup` },
        persona: persona ? persona.levelLabel || persona.label : null,
        version: CLIENT_BUILD.version,
        sha: CLIENT_BUILD.sha,
        errors: [...recentClientErrors(), reportLine(label, code, title)],
        viewport: { width: window.innerWidth, height: window.innerHeight },
      });
      panel.openDetails({ kind: 'feedback', id: openFeedbackReport(ctx), label: FEEDBACK_LABEL });
    },
    [panel, persona],
  );
}
