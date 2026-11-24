'use client';
/**
 * One Needs-you row as a kit ActionRow (the "NeedRow" configuration in ActionRow.tsx): the kind as its badge, the why
 * line with the source link (`o`), ✦ AI on a guess, the estimate and the account on the meta side, the primary verb
 * (quiet until selected; ⌘↵ and its own key run it), the second verb beside it and the rest as overflow. A question
 * shows its answers: the first three as buttons, every one past them in a "More…" menu (none is ever dropped; keys
 * 1–9 pick the first nine). Every key a row's page uses stays the same: `a` the primary verb, `n` / `x` the
 * dismiss, `s` Later.
 */
import type { NeedRow, NeedVerb } from '@/contract';
import { ActionRow, type ActionRowOverflow } from '@/components/kit/ActionRow';
import type { QueueRowContext } from '@/components/kit/QueueSection';
import { estimateText, isAiKind, KIND_LABEL, primaryOf } from './model';

/** Answer choices shown as buttons; the rest are in the row's "More…" menu. */
export const CHOICE_BUTTONS = 3;

const ICON: Partial<Record<NeedVerb['id'], string>> = {
  dismiss: 'close',
  reject: 'close',
  not_done: 'undo',
  close: 'close',
  stop: 'close',
  snooze: 'clock',
  open: 'new_window',
  edit: 'edit',
  seen: 'check',
  done: 'check',
  allow_today: 'check',
};

export interface NeedActionRowProps {
  row: NeedRow;
  ctx: QueueRowContext;
  onRun: (row: NeedRow, v: NeedVerb, extra?: { choiceId?: string; choiceLabel?: string }) => void;
  onOpen: (row: NeedRow, mode: 'details' | 'page') => void;
  onSelect?: (id: string) => void;
  /** Show the group as a meta chip (Home's single section). */
  showGroup?: string | null;
}

export function NeedActionRow({ row, ctx, onRun, onOpen, onSelect, showGroup }: NeedActionRowProps) {
  const primary = primaryOf(row);
  const answer = primary?.id === 'answer' ? primary : null;
  const rest = row.verbs.filter((v) => v !== primary);
  const alt = answer ? null : (rest.find((v) => v.call && v.id !== 'open') ?? null);
  const overflow: ActionRowOverflow[] = rest
    .filter((v) => v !== alt)
    .map((v) => ({ id: v.id, label: v.label, icon: ICON[v.id] ?? 'chevronright', k: v.kbd ?? undefined, onClick: () => onRun(row, v), testId: `need-verb-${v.id}` }));
  const keys: Record<string, () => void> = {};
  for (const v of row.verbs) if (v.kbd && v.kbd !== 'o' && !keys[v.kbd]) keys[v.kbd] = () => onRun(row, v);
  answer?.choices?.slice(0, 9).forEach((c, i) => (keys[String(i + 1)] = () => onRun(row, answer, { choiceId: c.id, choiceLabel: c.label })));
  const est = estimateText(row.estimateMin);
  return (
    <ActionRow
      key={row.id}
      id={row.id}
      {...ctx.rowProps}
      data-kind={row.kind}
      data-testid="need-row"
      title={row.title}
      why={row.why}
      badge={<span className="inline-flex h-5 items-center rounded-sm border border-line bg-surface px-1.5 text-micro font-bold text-fg">{KIND_LABEL[row.kind]}</span>}
      confidence={row.confidence ?? undefined}
      tint={isAiKind(row.kind) ? 'ai' : null}
      dashed={isAiKind(row.kind)}
      source={row.source}
      meta={
        <>
          {showGroup ? <span>{showGroup}</span> : null}
          {row.account ? <span className="min-w-0 truncate">{row.account.label}</span> : null}
          {est ? <span className="tabular-nums">{est}</span> : null}
        </>
      }
      edge={row.urgency >= 0.8 ? 'warning' : 'none'}
      verb={primary && !answer ? { label: primary.label, kbd: primary.kbd ?? undefined, onClick: () => onRun(row, primary), testId: 'need-primary' } : null}
      altVerb={alt ? { label: alt.label, onClick: () => onRun(row, alt), testId: `need-verb-${alt.id}` } : null}
      trailing={
        answer ? (
          <span className="flex items-center gap-1">
            {(answer.choices ?? []).slice(0, CHOICE_BUTTONS).map((c, i) => (
              <button
                key={c.id}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onRun(row, answer, { choiceId: c.id, choiceLabel: c.label })}
                title={`${c.label} (${i + 1})`}
                data-testid="need-choice"
                className="inline-flex h-8 max-w-40 items-center truncate rounded-md border border-line bg-surface px-2.5 text-caption font-bold text-fg hover:bg-surface-muted focus-visible:shadow-focus focus-visible:outline-none"
              >
                {c.label}
              </button>
            ))}
            {(answer.choices?.length ?? 0) > CHOICE_BUTTONS ? (
              <select
                aria-label="More answers"
                data-testid="need-choice-more"
                value=""
                onMouseDown={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const c = answer.choices?.find((x) => x.id === e.target.value);
                  if (c) onRun(row, answer, { choiceId: c.id, choiceLabel: c.label });
                }}
                className="h-8 max-w-40 rounded-md border border-line bg-surface px-2 text-caption font-bold text-fg hover:bg-surface-muted focus-visible:shadow-focus focus-visible:outline-none"
              >
                <option value="">More… ({(answer.choices?.length ?? 0) - CHOICE_BUTTONS})</option>
                {answer.choices!.slice(CHOICE_BUTTONS).map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {`${i + CHOICE_BUTTONS < 9 ? `${i + CHOICE_BUTTONS + 1}. ` : ''}${c.label}`}
                  </option>
                ))}
              </select>
            ) : null}
          </span>
        ) : undefined
      }
      overflow={overflow}
      inlineOverflow={2}
      keys={keys}
      live={ctx.live}
      liveTone={ctx.liveTone}
      selected={ctx.selected}
      onFocus={() => onSelect?.(row.id)}
      onOpen={(mode) => onOpen(row, mode)}
    />
  );
}
