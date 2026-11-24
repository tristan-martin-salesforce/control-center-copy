'use client';
/**
 * The update banner (H-11, H-12): data-driven and quiet. When GET /version carries `update` (a newer release on this
 * channel), one slim line: "Command Center 2.0.1 is available · Ask Claude Code to update"; the click copies the exact
 * prompt to give Claude Code. No `update` field: nothing renders. The app never updates itself from here.
 */
import { useState } from 'react';
import { updateBanner } from '@/client/health-setup';
import { useApi } from '@/client/hooks';
import { toast } from '@/client/toast';
import { copyToClipboard } from '@/components/panels/bits';
import { cn, Icon } from '@/ui';

export function UpdateBannerView({ banner, onCopy, copied, className }: { banner: NonNullable<ReturnType<typeof updateBanner>>; onCopy: () => void; copied?: boolean; className?: string }) {
  return (
    <div role="status" data-update-banner className={cn('flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-info-200 bg-info-50 px-4 py-2 text-body text-info-700', className)}>
      <Icon name="download" size="sm" className="shrink-0" />
      <span className="min-w-0 font-bold">{banner.text}</span>
      <button type="button" onClick={onCopy} title={banner.prompt} data-testid="update-copy-prompt" className="rounded-sm font-bold text-link hover:underline focus-visible:outline-none focus-visible:shadow-focus">
        {copied ? 'Prompt copied: paste it into Claude Code' : 'Ask Claude Code to update'}
      </button>
      <span className="text-caption text-muted" data-update-source={banner.source}>
        {banner.how}
      </span>
      {banner.notes ? <span className="min-w-0 truncate text-caption text-muted" title={banner.notes}>{banner.notes}</span> : null}
    </div>
  );
}

export function UpdateBanner({ className }: { className?: string }) {
  const q = useApi('getVersion', undefined, { staleTime: 60_000 });
  const [copied, setCopied] = useState(false);
  const banner = updateBanner(q.data);
  if (!banner) return null;
  const onCopy = async () => {
    const ok = await copyToClipboard(banner.prompt);
    setCopied(ok);
    if (!ok) toast({ key: 'update-prompt', tone: 'error', title: 'Couldn’t copy', body: banner.prompt, durationMs: 20_000 });
  };
  return <UpdateBannerView banner={banner} copied={copied} onCopy={() => void onCopy()} className={className} />;
}
