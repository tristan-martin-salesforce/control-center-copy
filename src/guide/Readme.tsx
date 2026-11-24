'use client';
/**
 * ⌘K ▸ Read the README: the repository README rendered in the app (GET /guide/readme), so a teammate can read the
 * setup and update steps without an editor or a remote. Opened by `openReadme()` from anywhere.
 */
import { useEffect, useState } from 'react';
import { useApi } from '@/client/hooks';
import { MarkdownBubble } from '@/components/chat/ChatMessages';
import { IconButton } from '@/ui/Button';
import { Overlay } from '@/ui/Overlay';
import { Skeleton } from '@/ui';

const OPEN_EVENT = 'cc:open-readme';

export function openReadme() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

function ReadmeBody() {
  const q = useApi('getReadme', undefined, { staleTime: 5 * 60_000 });
  if (q.isLoading) return <Skeleton variant="block" className="h-64 w-full" />;
  if (!q.data) return <p className="text-muted">The README isn’t in this folder. It lives at the root of the Command Center checkout.</p>;
  return <MarkdownBubble text={q.data.markdown} />;
}

export function ReadmeDialog() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, on);
    return () => window.removeEventListener(OPEN_EVENT, on);
  }, []);
  return (
    <Overlay open={open} onClose={() => setOpen(false)} labelledBy="cc-readme-title" className="w-[min(52rem,94vw)]">
      <div className="flex h-14 items-center border-b border-line px-5">
        <h2 id="cc-readme-title" className="text-title text-fg-heading">
          README
        </h2>
        <span className="ml-3 text-caption text-muted">Setup, personas, updating, where your data lives</span>
        <IconButton icon="close" label="Close" size="sm" className="ml-auto" onClick={() => setOpen(false)} data-autofocus />
      </div>
      <div className="cc-scroll max-h-[calc(80vh-3.5rem)] overflow-y-auto px-6 py-4" data-testid="readme-body">
        {open ? <ReadmeBody /> : null}
      </div>
    </Overlay>
  );
}
