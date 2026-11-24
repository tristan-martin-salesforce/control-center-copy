'use client';
/**
 * Start in Claude (UI-SPEC §12). POST /agents/launch returns the claude://code/new URL plus the run record
 * (nothing opens yet). Review prompt then shows the repo folder and the whole prompt, with "runs with your
 * permissions" (SEC-10, ./LaunchReview); only the explicit "Open in Claude" click opens the URL.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { api, ApiError } from '@/client/api';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { Button, Popover } from '@/ui';
import { openClaudeUrl, rankTasks } from './claude';
import { LaunchPromptReview, LaunchReviewDialog, OPEN_IN_CLAUDE_LABEL, REVIEW_PROMPT_LABEL } from './LaunchReview';

/** Folder + the whole prompt, as the user is about to open it (SEC-10: the shared review, ./LaunchReview). */
export function LaunchPreview({ url }: { url: string }) {
  return <LaunchPromptReview url={url} />;
}

/** Confirm opening a not-yet-started Claude session whose claude://code/new link we already have: Review prompt, then Open in Claude. */
export function StartConfirmDialog({ url, title, onClose }: { url: string | null; title?: string; onClose: () => void }) {
  return <LaunchReviewDialog url={url} title={title} onClose={onClose} onOpen={(u) => openClaudeUrl(u) && toast({ title: 'Opening in Claude', key: 'start-claude', durationMs: 3000 })} />;
}

/** Header action: pick (optionally) a task, prepare the launch, then confirm and open. */
export function StartInClaude({ variant = 'primary', open: openProp, onOpenChange }: { variant?: 'primary' | 'secondary'; open?: boolean; onOpenChange?: (open: boolean) => void }) {
  const qc = useQueryClient();
  const [innerOpen, setInnerOpen] = useState(false);
  const open = openProp ?? innerOpen;
  const setOpen = (o: boolean) => {
    setInnerOpen(o);
    onOpenChange?.(o);
  };
  const [workItemId, setWorkItemId] = useState('');
  const [title, setTitle] = useState('');
  const [folder, setFolder] = useState('');
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ url: string; title: string } | null>(null);
  const items = useApi('listItems', { query: { tab: 'all_open' } }, { enabled: open });
  // 2026-11-13 audit C8: every open task, ranked, searchable (it stopped at the first 40)
  const [taskQ, setTaskQ] = useState('');
  const all = useMemo(() => items.data?.items ?? [], [items.data]);
  const tasks = useMemo(() => rankTasks(all, taskQ), [all, taskQ]);
  const picked = all.find((t) => t.id === workItemId);

  const reset = () => {
    setLaunched(null);
    setError(null);
    setWorkItemId('');
    setTitle('');
    setFolder('');
    setPrompt('');
    setTaskQ('');
  };

  const prepare = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api('launchAgent', {
        body: {
          ...(workItemId ? { workItemId } : {}),
          ...(title.trim() ? { title: title.trim() } : {}),
          ...(folder.trim() ? { folder: folder.trim() } : {}),
          ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        },
      });
      setLaunched({ url: res.url, title: res.run.title });
      void qc.invalidateQueries({ queryKey: ['agents'] });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const field = 'h-8 w-full rounded-md border border-line-input bg-surface px-2 text-body placeholder:text-faint focus:border-brand-600 focus:outline-none';
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
      placement="bottom-end"
      width={500}
      label="Start in Claude"
      trigger={
        <Button variant={variant} size="md" icon="agent_session" kbd="shift+s" data-testid="start-in-claude">
          Start in Claude
        </Button>
      }
    >
      {({ close }) =>
        launched ? (
          <div className="flex flex-col gap-3 p-3">
            <p className="text-body-lg font-bold text-fg-heading">
              {REVIEW_PROMPT_LABEL}: {launched.title}
            </p>
            <LaunchPreview url={launched.url} />
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-caption text-muted">Not now keeps it queued here.</span>
              {/* the form (and its focused button) is gone: focus lands here, as the dialog's Not now does, so Esc and Tab stay in the popover */}
              <Button size="sm" variant="secondary" onClick={close} autoFocus data-testid="start-claude-not-now">
                Not now
              </Button>
              <Button
                size="sm"
                variant="primary"
                icon="new_window"
                data-testid="confirm-open-claude"
                onClick={() => {
                  if (openClaudeUrl(launched.url)) toast({ title: 'Opening in Claude', key: 'start-claude', durationMs: 3000 });
                  close();
                }}
              >
                {OPEN_IN_CLAUDE_LABEL}
              </Button>
            </div>
          </div>
        ) : (
          <form
            className="flex flex-col gap-2 p-3"
            onSubmit={(e) => {
              e.preventDefault();
              void prepare();
            }}
          >
            <p className="text-body-lg font-bold text-fg-heading">Start a Claude session</p>
            <label className="flex flex-col gap-0.5 text-caption text-muted">
              Task (its context pack becomes the prompt)
              <input value={taskQ} onChange={(e) => setTaskQ(e.target.value)} placeholder={`Search ${all.length} open tasks by title or account`} className={field} aria-label="Search tasks" data-testid="start-claude-task-search" />
              <select value={workItemId} onChange={(e) => setWorkItemId(e.target.value)} className={field} aria-label="Task">
                <option value="">No task, a blank session</option>
                {picked && !tasks.includes(picked) ? <option value={picked.id}>{picked.title}</option> : null}
                {tasks.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.rank ? `#${t.rank} · ` : ''}
                    {t.title}
                    {t.refs.account?.label ? ` · ${t.refs.account.label}` : ''}
                  </option>
                ))}
              </select>
              <span className="text-caption text-faint tabular-nums">{taskQ ? `${tasks.length} of ${all.length} tasks match` : `${all.length} open tasks, ranked`}</span>
            </label>
            <label className="flex flex-col gap-0.5 text-caption text-muted">
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the task title" className={field} />
            </label>
            <label className="flex flex-col gap-0.5 text-caption text-muted">
              Repo folder
              <input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="Default repo folder" className={`${field} font-mono`} />
            </label>
            <label className="flex flex-col gap-0.5 text-caption text-muted">
              Prompt (optional)
              <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="Leave empty to use the task’s context pack" className="rounded-md border border-line-input bg-surface p-2 text-body placeholder:text-faint focus:border-brand-600 focus:outline-none" />
            </label>
            {error ? (
              <p role="alert" className="text-caption text-danger-700">
                Couldn’t prepare the session: {error}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <span className="mr-auto text-caption text-muted">Next: review the whole prompt, then open.</span>
              <Button size="sm" variant="secondary" onClick={close}>
                Cancel
              </Button>
              <Button size="sm" variant="primary" type="submit" loading={busy} data-testid="start-claude-review">
                {REVIEW_PROMPT_LABEL}
              </Button>
            </div>
          </form>
        )
      }
    </Popover>
  );
}
