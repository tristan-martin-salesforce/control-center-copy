'use client';
/**
 * The release items' own pieces (D-90, W12-7), shared by the Outbox row and the Review card:
 *
 *   ReleaseFacts       the version, where it goes (the Drive folder link / the channel), the full sha256, the files to
 *                      upload or the post's exact text, and what to set when the folder or channel is missing
 *   copyInstructions   "Copy upload instructions": the exact prompt for Claude Code, to the clipboard
 *   markUploaded       "Mark uploaded": a preview for its confirm token, then dispatch. The server marks the hand-off
 *                      (status sent, a `release` landing); there is no tool call and nothing leaves the machine.
 */
import type { Draft } from '@/contract';
import { api } from '@/client/api';
import { toast } from '@/client/toast';
import { copyText } from '@/components/time/shared';
import { releaseRowFacts, releaseUploadInputOf } from '@/outbox/adapters/release-handoff';

export async function copyInstructions(d: Draft): Promise<boolean> {
  const text = d.destination.kind === 'action' ? releaseRowFacts(d.destination).copyText : null;
  if (!text) return false;
  const ok = await copyText(text);
  toast(ok ? { key: `release:${d.id}`, title: 'Upload instructions copied', body: 'Paste them into Claude Code (or upload the three files yourself), then Mark uploaded.', tone: 'success' } : { key: `release:${d.id}`, tone: 'error', title: "Couldn't copy", body: 'Open the row (Space) and copy the instructions from there.' });
  return ok;
}

export async function markUploaded(d: Draft): Promise<void> {
  const p = await api('previewDraft', { params: { id: d.id }, body: { mode: 'send' } });
  await api('dispatchDraft', { params: { id: d.id }, body: { ifVersion: p.version, mode: 'send', confirmToken: p.confirmToken } });
}

export function ReleaseFacts({ draft }: { draft: Draft }) {
  const dest = draft.destination;
  if (dest.kind !== 'action') return null;
  const f = releaseRowFacts(dest);
  const u = f.kind === 'upload' ? releaseUploadInputOf(dest) : null;
  const sha = u?.sha256 ?? String((dest.input as { sha256?: unknown }).sha256 ?? '');
  return (
    <div className="grid max-w-[44rem] gap-2" data-testid="release-facts" data-release-kind={f.kind}>
      {f.missing ? (
        <p role="alert" className="text-body text-danger-700" data-testid="release-missing">
          {f.missing}
        </p>
      ) : null}
      <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-1 text-body">
        <dt className="text-muted">Release</dt>
        <dd className="tabular-nums text-fg">v{f.version}</dd>
        <dt className="text-muted">{f.kind === 'upload' ? 'Drive folder' : 'Post to'}</dt>
        <dd className="min-w-0 truncate text-fg">
          {f.kind === 'upload' && f.where ? (
            <a href={f.where} target="_blank" rel="noopener noreferrer" className="font-bold text-link hover:underline focus-visible:shadow-focus focus-visible:outline-none">
              {f.where}
            </a>
          ) : (
            (f.where ?? 'not set')
          )}
        </dd>
        {sha ? (
          <>
            <dt className="text-muted">sha256</dt>
            <dd className="min-w-0 break-all font-mono text-caption text-fg" title={sha}>
              {sha}
            </dd>
          </>
        ) : null}
      </dl>
      {u ? (
        <>
          <h4 className="text-caption font-bold text-muted">Files to put in the folder</h4>
          <ul className="grid gap-0.5 text-caption text-fg">
            {u.files.map((x) => (
              <li key={x.path} className="min-w-0 truncate font-mono" title={x.path}>
                {x.path}
              </li>
            ))}
          </ul>
          <h4 className="text-caption font-bold text-muted">Upload instructions (Copy upload instructions)</h4>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-sunken p-2 text-caption text-fg" data-testid="release-instructions">
            {u.copyText}
          </pre>
        </>
      ) : (
        <>
          <h4 className="text-caption font-bold text-muted">Exactly what the channel will see</h4>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-sm bg-surface-sunken p-2 font-sans text-body text-fg" data-testid="release-post">
            {dest.text ?? ''}
          </pre>
        </>
      )}
    </div>
  );
}
