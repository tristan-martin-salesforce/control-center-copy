/**
 * The classifier's live model: one tool-less `complete()` on the active provider (src/llm/provider, decision H-4), no
 * tools, no settings files, no filesystem. The Agent SDK adapter puts its dynamic boundary at `cacheBoundary`, so the
 * skill text is one cache entry shared by every classifier call.
 */
import { classifyError } from '@/llm/errors';
import { modelProvider, type ModelProvider } from '@/llm/provider';
import { SCANNER_MODEL } from '@/llm/models';

import type { ClassifierModel } from './types';

export const CLASSIFIER_MODEL = SCANNER_MODEL;

export function providerClassifierModel(p: () => ModelProvider = () => modelProvider()): ClassifierModel {
  return async (req) => {
    const r = await p().complete({
      model: req.model,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      maxTokens: req.maxTokens ?? 4_000,
      ...(req.cacheBoundary ? { cacheBoundary: req.cacheBoundary } : {}),
      effort: req.effort ?? 'low',
      budgetUsd: req.maxBudgetUsd,
      ...(req.signal ? { signal: req.signal } : {}),
      timeoutMs: 120_000,
    });
    return {
      ok: r.ok,
      text: r.text,
      costUsd: r.usage.costUsd,
      inputTokens: r.usage.inputTokens,
      outputTokens: r.usage.outputTokens,
      cacheReadTokens: r.usage.cacheReadTokens,
      cacheWriteTokens: r.usage.cacheWriteTokens,
      ...(r.ok ? {} : { error: { message: r.error ?? 'classifier call failed', errorClass: classifyError(r.error ?? '').errorClass } }),
    };
  };
}
