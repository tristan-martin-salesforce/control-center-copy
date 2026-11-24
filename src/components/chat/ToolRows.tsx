'use client';
/**
 * Tool activity (v2, mockup "Searched Slack · 3 threads · 2 more tools"): one violet ✦ line that expands
 * to mono rows (tool, what it set out to do → result), credential-redacted. While the turn streams, the
 * rows stay open so you can watch them run; once it finishes they fold into the line.
 * Scan tools are not listed here: they render as scan rows (ScanRow).
 */
import { useId, useState } from 'react';
import { redactCredentials, type ChatToolView } from '@/client/chat';
import { ChatIcon } from './icons';
import { isHeldForYou, isScanTool, toolPhrase, toolSummaryLine } from './thread-model';
import { useChatUi } from './ui-context';
import s from './assistant.module.css';

/**
 * A read of other people's text: the server marks every `search` / `fetch` result untrusted for the model
 * (src/llm/chat/tools.ts `UNTRUSTED_TOOLS`, rows `<source>.search` / `<source>.read`); the row says so in words.
 */
const OTHERS_TEXT = /^(ledger|slack|gmail|drive|calendar|org62|vdp)\.(search|read)$/;
export const readsOthersText = (name: string) => OTHERS_TEXT.test(name);
export const OTHERS_TEXT_LABEL = 'others’ words';
export const OTHERS_TEXT_TITLE = 'Other people’s text: the Assistant reads it as information and never takes instructions from it. It acts only on what you write.';

/** One expanded row: `name args → result`. */
export function ToolRow({ tool }: { tool: ChatToolView; defaultOpen?: boolean }) {
  const args = tool.startSummary && tool.startSummary !== tool.summary ? redactCredentials(tool.startSummary) : null;
  const result = tool.ok === null ? 'running…' : redactCredentials(tool.summary);
  const cost = tool.costUsd ? ` · $${tool.costUsd < 0.01 ? tool.costUsd.toFixed(3) : tool.costUsd.toFixed(2)}` : '';
  return (
    <li data-tool={tool.name} data-tool-ok={String(tool.ok)} data-ok={isHeldForYou(tool) ? 'held' : String(tool.ok)} title={`${tool.name}${args ? ` ${args}` : ''} → ${result}`}>
      <span>
        <span className={s.tn}>{tool.name}</span>
        {args ? ` ${args}` : ''} <span className={s.res}>→ {result}</span>
        {tool.ok && readsOthersText(tool.name) ? (
          <span className={s.others} title={OTHERS_TEXT_TITLE} data-untrusted>
            {OTHERS_TEXT_LABEL}
          </span>
        ) : null}
        {cost && !result.includes('$') ? (
          <span className="tabular-nums text-muted" data-tool-cost={tool.costUsd}>
            {cost}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export function ToolRows({ tools, live, changed }: { tools: ChatToolView[]; live: boolean; /** The turn changed something (receipt or proposal below). */ changed?: boolean }) {
  const ui = useChatUi();
  const [open, setOpen] = useState(!!ui.defaults?.toolsOpen);
  const id = useId();
  const listed = tools.filter((t) => !isScanTool(t));
  if (!listed.length) return null;

  if (live) {
    return (
      <ul className={s.liveTools} aria-label="Tool calls" aria-live="polite" data-tools-live>
        {listed.map((t) => (
          <li key={t.id} data-tool={t.name} data-tool-ok={String(t.ok)}>
            {t.ok === null ? (
              <span className={s.dotPulse} aria-hidden />
            ) : isHeldForYou(t) ? (
              <span aria-hidden className={s.held}>
                –
              </span>
            ) : (
              <ChatIcon name={t.ok ? 'check' : 'x'} size={14} className={t.ok ? s.ok : s.bad} />
            )}
            <span>{redactCredentials(toolPhrase(t))}</span>
          </li>
        ))}
      </ul>
    );
  }

  const sum = toolSummaryLine(tools);
  return (
    <div className={s.tools} data-tools>
      <button type="button" className={s.toolsSum} aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} data-tools-summary>
        <span className={s.spark} aria-hidden>
          ✦
        </span>
        <span className={s.txt}>{redactCredentials(sum.line)}</span>
        {sum.more ? (
          <span className={s.faint}>
            · {sum.more} more tool{sum.more === 1 ? '' : 's'}
          </span>
        ) : null}
        {sum.failed && (sum.more || !sum.line.includes('failed')) ? <span className={s.bad}>· {sum.failed} failed</span> : null}
        <ChatIcon name="chev-r" size={14} className={s.chev} />
      </button>
      {open ? (
        <ol id={id} className={s.toolList} aria-label="Tool calls">
          {listed.map((t) => (
            <ToolRow key={t.id} tool={t} />
          ))}
          <li className={s.toolFoot}>{changed ? 'The changes are on the card below, with Undo.' : 'Read-only. Nothing changed.'}</li>
        </ol>
      ) : null}
    </div>
  );
}
