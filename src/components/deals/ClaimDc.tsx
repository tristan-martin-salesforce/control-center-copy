'use client';
/**
 * One Claim verb (D-58): the small form every Claim opens (Missed ▸ Claim, the account page's Claim DC, an opp's
 * details): the split, the role (your role's DC role by default) and what you did on it (strong evidence only: a deck,
 * demo, model or estimate built for it, or hours logged on it). It adds a DC request, which goes on your next logging
 * canvas; nothing is sent from here.
 *
 * It says what the request is before you submit: "Claim a 100% DC", or "Change your DC 50% → 100%" when you already
 * hold one. The same split as your DC is nothing to request (the server refuses it too).
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { dcRoleFor, myDcWords, type DcRequest, type MyDc } from '@/contract';
import { api } from '@/client/api';
import { usePersona } from '@/client/persona';
import { toast } from '@/client/toast';
import { Dialog } from '@/ui';
import { errorText } from '@/lib/error-text';

export interface ClaimTarget {
  /** The app's opportunity id (createDcRequest), or null when the caller submits its own way (Missed). */
  oppId: string | null;
  oppName: string;
  myDc: Pick<MyDc, 'split' | 'role'> | null;
  /** Prefilled comment (the sweep's evidence); the user edits it. */
  comment?: string;
  /** What the app knows about your work on it (hours this quarter, the team, the sweep): strong evidence only. */
  evidence?: string;
  /** Prefilled split and role (editing a request); default 100% and your role's DC role. */
  split?: number;
  role?: string;
}

export interface ClaimValues {
  split: number;
  role: string;
  comment: string;
}

const fieldCls = 'h-8 w-full rounded-md border border-line-input bg-surface px-2 text-body text-fg focus-visible:outline-none focus-visible:shadow-focus';

/** What a claim of `split` is, given my DC: the words on the form, the chat card and the canvas row. */
export function claimWords(myDc: Pick<MyDc, 'split' | 'role'> | null, split: number, oppName: string): { line: string; same: boolean } {
  if (myDc && myDc.split !== null && myDc.split === split) return { line: `You already hold a ${split}% DC on ${oppName}: nothing to request`, same: true };
  if (myDc) return { line: `Change your DC ${myDc.split === null ? '?' : `${myDc.split}%`} → ${split}%`, same: false };
  return { line: `Claim a ${split}% DC`, same: false };
}

export function ClaimDcDialog({ target, onClose, onSubmit, busy, commentRequired = true, edit = false }: { target: ClaimTarget | null; onClose: () => void; onSubmit: (v: ClaimValues) => void | Promise<unknown>; busy?: boolean; commentRequired?: boolean; edit?: boolean }) {
  const persona = usePersona();
  const defaultRole = target?.role ?? target?.myDc?.role ?? dcRoleFor(persona?.id);
  // null: the target's value (a new target shows its own prefill)
  const [splitIn, setSplit] = useState<string | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [comment, setComment] = useState<string | null>(null);
  const split = splitIn ?? String(target?.split ?? 100);
  const n = Math.round(Number(split));
  const validSplit = Number.isFinite(n) && n >= 1 && n <= 100;
  const text = (comment ?? target?.comment ?? '').trim();
  const roleText = (role ?? defaultRole).trim();
  const words = target && validSplit ? claimWords(target.myDc, n, target.oppName) : null;
  const ok = !!target && validSplit && !words?.same && roleText.length >= 2 && (!commentRequired || text.length >= 3);
  const close = () => {
    setSplit(null);
    setRole(null);
    setComment(null);
    onClose();
  };
  return (
    <Dialog
      open={!!target}
      onClose={close}
      title={edit ? `Edit the DC request on ${target?.oppName ?? ''}` : target?.myDc ? `Change your DC on ${target.oppName}?` : `Claim a DC on ${target?.oppName ?? ''}?`}
      description={
        <>
          {target?.myDc ? <span className="font-bold text-fg">{myDcWords(target.myDc)}. </span> : null}
          It goes in your next batch; nothing is sent until you Apply it on Activity.
        </>
      }
      confirmLabel={edit ? 'Save the request' : words && !words.same && target?.myDc ? 'Request the change' : 'Add DC request'}
      busy={busy}
      confirmKbd="mod+enter"
      width={460}
      onConfirm={
        ok
          ? async () => {
              await onSubmit({ split: n, role: roleText, comment: text });
              close();
            }
          : undefined
      }
    >
      <div className="flex flex-col gap-3" data-testid="claim-dc-form">
        {target?.evidence ? (
          <p className="text-caption text-muted" data-testid="claim-evidence">
            <span className="font-bold text-fg">What the app knows: </span>
            {target.evidence}. Claim only what you built or logged for it.
          </p>
        ) : null}
        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
          <label className="flex flex-col gap-1 text-caption font-bold text-muted">
            Split %
            <input className={fieldCls} type="number" min={1} max={100} step={1} value={split} onChange={(e) => setSplit(e.target.value)} aria-label="Split percent" data-testid="claim-split" />
          </label>
          <label className="flex flex-col gap-1 text-caption font-bold text-muted">
            Role
            <input className={fieldCls} value={role ?? defaultRole} onChange={(e) => setRole(e.target.value)} aria-label="Opportunity role" data-testid="claim-role" />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-caption font-bold text-muted">
          What you did on it{commentRequired ? '' : ' (optional)'}
          <textarea
            className="min-h-16 w-full min-w-0 resize-y rounded-md border border-line-input bg-surface px-2 py-1.5 text-body font-normal text-fg focus-visible:outline-none focus-visible:shadow-focus"
            rows={3}
            value={comment ?? target?.comment ?? ''}
            onChange={(e) => setComment(e.target.value)}
            placeholder="The deck, demo, model or estimate you built for it, or the hours you logged"
            aria-label="DC comment"
            data-testid="claim-comment"
          />
        </label>
        {words ? (
          <p className={words.same ? 'text-caption font-bold text-danger-700' : 'text-caption font-bold text-fg'} data-testid="claim-words">
            {words.line}
          </p>
        ) : (
          <p className="text-caption text-danger-700">The split is a whole percent from 1 to 100.</p>
        )}
      </div>
    </Dialog>
  );
}

/** The toast after a Claim: what was added, where it goes, the DC list, and Undo. */
export function dcRequestToast(r: Pick<DcRequest, 'kind' | 'fromSplit' | 'splitPercent' | 'oppName'>, auditId: string | null, key = 'dc-request'): void {
  toast({
    key,
    tone: 'success',
    title: r.kind === 'change' ? 'DC change added: it goes in your next batch' : 'DC request added: it goes in your next batch',
    body: `${r.kind === 'change' ? `Change your DC ${r.fromSplit ?? '?'}% → ${r.splitPercent}%` : `${r.splitPercent}% DC`} on ${r.oppName}. Nothing was sent.`,
    action: { label: 'DC list', href: '/deals/dcs' },
    undo: auditId ? { auditId } : undefined,
  });
}

/**
 * Claim a DC on an opp the app has, in place (the account page, an opp's details): `open(target)` shows the form,
 * Submit calls createDcRequest and toasts. Render `dialog` once.
 */
export function useClaimDc(): { open: (t: ClaimTarget) => void; dialog: ReactNode } {
  const [target, setTarget] = useState<ClaimTarget | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = useCallback(
    async (v: ClaimValues) => {
      if (!target?.oppId) return;
      setBusy(true);
      try {
        const r = await api('createDcRequest', { body: { opp: target.oppId, split: v.split, role: v.role, comment: v.comment } });
        dcRequestToast(r.entity, r.auditId ?? null, `dc-request:${target.oppId}`);
      } catch (err) {
        toast({ key: `dc-request-err:${target.oppId}`, tone: 'error', durationMs: null, title: "Couldn't add the DC request", body: errorText(err, 240) });
      } finally {
        setBusy(false);
      }
    },
    [target],
  );
  const dialog = useMemo(() => <ClaimDcDialog target={target} busy={busy} onClose={() => setTarget(null)} onSubmit={submit} />, [target, busy, submit]);
  return { open: setTarget, dialog };
}
