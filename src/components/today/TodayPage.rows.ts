/**
 * Today ▸ what a row does: its primary action (the filled button, ⌘↵), the hover actions, and the renegotiate
 * hand-off to the assistant (split out of TodayPage.tsx; behaviour as before). Nothing is sent: drafts land in the Outbox.
 */
import { useCallback, type Dispatch, type SetStateAction } from 'react';
import type { WorkItem } from '@/contract';
import { toast } from '@/client/toast';
import { setChatContext, useOptionalChat } from '@/components/chat';
import { navigate } from '@/components/shell/router';
import { useRightPanel, type PanelEntity } from '@/components/shell/panel';
import type { PopoverState } from './ctx';
import { claudeIntent } from './model';
import type { DayRow } from './rows';
import type { RowAction } from './RunOfDay';
import type { TodayActions } from './useTodayActions';

export interface RowActionsIn {
  actions: TodayActions;
  openDetails: (entity: PanelEntity) => void;
  openRow: (row: DayRow) => void;
  pullIn: (item: WorkItem) => Promise<string | null>;
  setPopover: (p: PopoverState | null) => void;
  setReauthFor: Dispatch<SetStateAction<string | null>>;
}

export function useRowActions({ actions, openDetails, openRow, pullIn, setPopover, setReauthFor }: RowActionsIn) {
  const panel = useRightPanel();
  const chat = useOptionalChat();

  const renegotiate = useCallback(
    (item: WorkItem) => {
      const entity: PanelEntity = { kind: 'work_item', id: item.id, label: item.title };
      if (!chat) {
        openDetails(entity);
        return;
      }
      const who = item.counterparty?.name ?? 'them';
      setChatContext({ kind: 'work_item', id: item.id, label: item.title });
      chat.sendMessage(`Draft a short note to ${who} renegotiating "${item.title}" (promised ${item.ageDays}d ago): ask whether I can get it to them by a new date I propose. Put it in the Outbox as a draft; don't send.`);
      panel.openAssistant(entity);
      toast({ key: `reneg:${item.id}`, title: 'Asked the assistant for a renegotiation draft', body: 'It lands in the Outbox as a draft; nothing is sent.' });
    },
    [chat, openDetails, panel],
  );

  const runPrimary = useCallback(
    (row: DayRow) => {
      const it = row.item;
      const p = row.primary;
      switch (p.kind) {
        case 'card': {
          const card = row.card;
          if (!card || !it) return openRow(row);
          if (it.state === 'likely_done') return actions.confirmDone(it);
          if (it.state === 'suggested') return actions.accept(it);
          switch (card.nba?.verb) {
            case 'start_in_claude': {
              const intent = claudeIntent(card, null);
              if (intent.kind === 'open') actions.openClaude(intent.url, card.nba.title);
              else actions.launchClaude(it, card.nba.title);
              return;
            }
            case 'run_tool':
              return setPopover({ kind: 'tool', itemId: it.id, surface: row.section });
            case 'confirm_done':
              return actions.confirmDone(it);
            case 'log':
              return navigate('/activity');
            default:
              // send · nudge · answer · review: the composer / answer chips live in the panel's detail.
              return openRow(row);
          }
        }
        case 'outbox':
          return navigate('/outbox');
        case 'rail': {
          const a = p.entry.action;
          if (!a) return openRow(row);
          if (a.kind === 'open_in_claude' && a.href) return actions.openClaude(a.href, p.entry.title);
          if (a.kind === 'approve') return navigate(a.href ?? '/outbox');
          if (a.kind === 'reauth') return setReauthFor(p.entry.ref.id);
          if (a.kind === 'review' || a.kind === 'open') return a.href ? navigate(a.href) : openRow(row);
          return openRow(row);
        }
        case 'reauth':
          return setReauthFor((v) => (v === p.connectorId ? null : p.connectorId));
        case 'pull':
          if (it) void pullIn(it);
          return;
        case 'shelf': {
          if (!it) return;
          const verb = p.entry.action.verb;
          if (verb === 'kick_off') return actions.launchClaude(it, it.title);
          if (verb === 'start') return void pullIn(it);
          if (verb === 'renegotiate') return renegotiate(it);
          if (verb === 'let_go') return actions.letGo(it);
          return openRow(row);
        }
        default:
          return openRow(row);
      }
    },
    [actions, openRow, pullIn, renegotiate, setPopover, setReauthFor],
  );

  const rowAction = useCallback(
    (row: DayRow, a: RowAction) => {
      const it = row.item;
      if (!it) return;
      if (a === 'snooze') setPopover({ kind: 'snooze', itemId: it.id, surface: row.section });
      else if (a === 'done') (it.state === 'likely_done' ? actions.confirmDone : actions.done)(it);
      else if (a === 'nudge') openRow(row);
      else if (a === 'renegotiate') renegotiate(it);
      else if (a === 'let_go') actions.letGo(it);
    },
    [actions, openRow, renegotiate, setPopover],
  );

  return { renegotiate, runPrimary, rowAction };
}
