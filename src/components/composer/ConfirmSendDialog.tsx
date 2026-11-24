'use client';
/**
 * The border confirm (UI-SPEC §7, R-UI-18): destination, recipients and the SERVER's rendered payload,
 * the dry-run note, and what happens next. Confirm is the only primary; Cancel has focus on open.
 * Reused by the Outbox page.
 */
import { useState } from 'react';
import { isAdminDraft, type Destination, type DispatchMode, type DraftPreview } from '@/contract';
import type { ComposeWarning } from '@/lib/compose';
import { Button, Icon, StatePill } from '@/ui';
import { ConfirmFrame, cx } from './_bits';
import { channelName, destinationLabel, recipientRows } from './destination';
import { PayloadPanel } from './PayloadPanel';
import { serverPayloadView } from './preview';
import { RecipientPreview } from './RecipientPreview';
import { actionApp, actionIcon } from '@/lib/actions';

export interface ConfirmSendDialogProps {
  open: boolean;
  mode: DispatchMode;
  destination: Destination;
  /** POST /drafts/:id/preview result. Null while loading. */
  preview: DraftPreview | null;
  loading?: boolean;
  dryRun: boolean;
  undoSec: number;
  warnings?: ComposeWarning[];
  /** false when the server's rendering differs from the editor preview (shown as a note). */
  parity?: boolean | null;
  labels?: Record<string, string>;
  senderName?: string;
  senderEmail?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** Render in place without a portal/backdrop (kit gallery). */
  inline?: boolean;
}

export function confirmTitle(mode: DispatchMode, d: Destination): string {
  if (d.kind === 'action') return `Apply ${d.changes.length > 1 ? 'these changes' : 'this change'} to ${actionApp(d.action)}?`;
  if (d.kind === 'slack') return mode === 'send' ? `Send to ${d.channelName}?` : `Save a Slack draft for ${d.channelName}?`;
  return mode === 'send' ? 'Send this email?' : 'Save as a Gmail draft?';
}

export function confirmLabel(mode: DispatchMode, dryRun: boolean, d?: Destination): string {
  const base = d?.kind === 'action' ? 'Apply' : mode === 'send' ? 'Send' : 'Save draft';
  return dryRun ? `${base} (dry run)` : base;
}

export function ConfirmSendDialog({
  open,
  mode,
  destination,
  preview,
  loading,
  dryRun,
  undoSec,
  warnings = [],
  parity,
  labels,
  senderName,
  senderEmail,
  onConfirm,
  onCancel,
  inline,
}: ConfirmSendDialogProps) {
  const [showPayload, setShowPayload] = useState(false);
  const app = channelName(destination);
  const after = dryRun
    ? `After you confirm you have ${undoSec} s to undo. Then the payload is rendered and recorded. Nothing is sent.`
    : mode === 'send'
      ? `After you confirm you have ${undoSec} s to undo. Then it posts to ${app} and is checked by reading it back.`
      : `After you confirm you have ${undoSec} s to undo. Then a draft is created in ${app} for you to send yourself.`;

  return (
    <ConfirmFrame
      open={open}
      inline={inline}
      onClose={onCancel}
      size="lg"
      title={confirmTitle(mode, destination)}
      description={after}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && preview && !loading) {
          e.preventDefault();
          onConfirm();
        }
      }}
      footer={
        <>
          {dryRun ? (
            <span className="mr-auto inline-flex items-center gap-1.5 text-caption text-muted">
              <Icon name="lock" size="xs" />
              Dry run is on in Settings
            </span>
          ) : null}
          <Button variant="secondary" onClick={onCancel} data-autofocus data-testid="confirm-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm} disabled={!preview || loading} kbd="mod+enter" data-testid="confirm-send">
            <Icon name={mode === 'send' ? 'send' : 'edit'} size="sm" />
            {confirmLabel(mode, dryRun, destination)}
          </Button>
        </>
      }
    >
      <div data-testid="confirm-dialog" className="space-y-4">
        {dryRun ? (
          // Dry run is a mode, not a risk: a quiet but bold callout that says exactly what confirming does.
          <div data-dry-run className="flex items-start gap-2.5 rounded-md border border-line-strong bg-surface-sunken px-4 py-3 text-body text-fg">
            <Icon name="lock" size="sm" className="mt-1 shrink-0 text-muted" />
            <p className="max-w-[68ch]">
              <span className="font-bold">Dry run is on.</span> Confirming renders this exact payload and records it {isAdminDraft({ destination }) ? 'on Activity' : 'in the Outbox'}. Nothing leaves this machine.
            </p>
          </div>
        ) : null}

        <section aria-label="Where it goes">
          <h3 className="mb-2 text-body font-bold text-fg-heading">Where it goes</h3>
          <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-1.5 rounded-md border border-line px-4 py-3 text-body">
            <dt className="text-caption leading-6 text-muted">Destination</dt>
            <dd className="flex min-w-0 flex-wrap items-center gap-1.5 text-fg" data-destination={destination.kind}>
              <Icon name={destination.kind === 'slack' ? 'slack' : destination.kind === 'action' ? actionIcon(destination.action) : 'email'} size="xs" className="text-muted" />
              <span className="min-w-0 break-words">{destinationLabel(destination)}</span>
              <StatePill tone="neutral" size="md" className="ml-1" label={destination.kind === 'action' ? `Applies ${destination.changes.length === 1 ? 'one change' : `${destination.changes.length} changes`}` : mode === 'send' ? 'Sends now' : `${app} draft, you send it`} />
            </dd>
            {recipientRows(destination).map((r) => (
              <div key={r.label} className="contents">
                <dt className="text-caption leading-6 text-muted">{r.label}</dt>
                <dd className="min-w-0 break-words text-fg">{r.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        {warnings.map((w) => (
          <div key={w.code + w.message} className="flex items-center gap-2 rounded-md border border-warning-200 bg-warning-50 px-4 py-2 text-body text-warning-700">
            <Icon name="warning" size="sm" />
            {w.message}
          </div>
        ))}

        <section aria-label="Exactly what will be sent">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <h3 className="text-body font-bold text-fg-heading">{destination.kind === 'action' ? `Exactly what changes in ${actionApp(destination.action)}` : `Exactly what ${destination.kind === 'slack' ? 'they' : 'the recipient'} will see`}</h3>
            {parity === false ? (
              <span className="text-caption text-warning-700" title="The server renders the payload that will be sent; this is it.">
                ▲ Differs from the editor preview. This is what will be sent.
              </span>
            ) : null}
          </div>
          {preview && !loading ? (
            <RecipientPreview preview={preview} destination={destination} labels={labels} senderName={senderName} senderEmail={senderEmail} className="max-h-80 overflow-y-auto" />
          ) : (
            <div aria-busy className="h-28 animate-pulse rounded-md border border-line bg-surface-muted" />
          )}
        </section>

        {preview ? (
          <div>
            <button
              type="button"
              aria-expanded={showPayload}
              onClick={() => setShowPayload((v) => !v)}
              className="inline-flex items-center gap-1 text-caption text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none"
            >
              <Icon name={showPayload ? 'chevrondown' : 'chevronright'} size="xs" />
              View payload
            </button>
            {showPayload ? <PayloadPanel view={serverPayloadView(preview)} caption="What dispatch will post" className={cx('mt-1.5')} maxHeightClass="max-h-48" /> : null}
          </div>
        ) : null}
      </div>
    </ConfirmFrame>
  );
}
