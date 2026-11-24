/**
 * The continuation section (ASSIST-2, P31-1): its first line says why the stopped answer stopped. A step-stop
 * ("continue") and a cost-limit stop ("Allow more") read differently, and both keep the answer and its calls.
 */
import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@/contract';
import { buildChatPrompt, CONTINUE_AFTER_COST_LIMIT, CONTINUE_AFTER_STEP_LIMIT, renderContinuation } from '@/llm/chat/prompt';
import { STEP_LIMIT_CODE, stepLimitMessage } from '@/llm/chat/router';

const tool = { type: 'tool', id: 't1', name: 'search', summary: 'searched slack', args: 'slack Globex', result: '3 hits', ok: true };
const stopped = (error: Record<string, unknown>): ChatMessage =>
  ({ id: 'a1', threadId: 'th', role: 'assistant', at: '2026-11-21T10:00:00Z', text: 'Half an answer', parts: [tool, { type: 'error', error }], context: [], isMorningBrief: false }) as never as ChatMessage;

const stepStop = stopped({ code: 'internal', message: stepLimitMessage(7), retryable: true, details: { catalogCode: STEP_LIMIT_CODE } });
const legacyStepStop = stopped({ code: 'internal', message: stepLimitMessage(200), retryable: true });
const costStop = stopped({ code: 'budget_exceeded', message: 'Stopped at the cost limit', retryable: false });

describe('renderContinuation', () => {
  it('a step-stop says Steps per message and that the user said continue, never the cost limit', () => {
    for (const m of [stepStop, legacyStepStop]) {
      const out = renderContinuation(m);
      expect(out.split('\n')[0]).toBe(CONTINUE_AFTER_STEP_LIMIT);
      expect(out).toMatch(/stopped at your Steps per message limit/);
      expect(out).toMatch(/The user said continue/);
      expect(out).not.toMatch(/cost limit|allowed more/);
    }
  });

  it('a cost-limit stop keeps the old wording', () => {
    const out = renderContinuation(costStop);
    expect(out.split('\n')[0]).toBe(CONTINUE_AFTER_COST_LIMIT);
    expect(out).toMatch(/stopped at its cost limit .* The user allowed more/);
    expect(out).not.toMatch(/Steps per message/);
  });

  it('both carry the text so far and every call with its recorded result', () => {
    for (const m of [stepStop, costStop]) {
      const out = renderContinuation(m);
      expect(out).toContain('### What you wrote so far\nHalf an answer');
      expect(out).toContain('- search (slack Globex): 3 hits');
    }
  });

  it('the prompt carries the section only on a continuation', () => {
    const base = { skillBody: 'skill', pack: {}, context: [], text: 'continue', now: new Date('2026-11-21T10:00:00Z'), timezone: 'UTC' };
    expect(buildChatPrompt({ ...base, continuation: stepStop }, 'B').prompt).toContain(`## Continue your stopped answer\n${CONTINUE_AFTER_STEP_LIMIT}`);
    expect(buildChatPrompt(base, 'B').prompt).not.toContain('## Continue your stopped answer');
  });
});
