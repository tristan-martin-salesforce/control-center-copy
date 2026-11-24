'use client';
/**
 * /dev/kit: the component kit's spec (01-ui-audit R10; docs/UX.md "Component kit"). Each kit component renders here
 * with sample-data-shaped placeholders in every state; a change to the kit shows here first. Placeholders only.
 */
import { useEffect, useState } from 'react';
import { SegmentedToggle } from '@/ui';
import { DetailPanelSection, PageHeaderSection, ReviewQueueSection } from './panels';
import { ActionRowSection, QueueSectionDemo } from './rows';

const NAV = [
  { id: 'action-row', label: 'ActionRow' },
  { id: 'queue-section', label: 'QueueSection' },
  { id: 'page-header', label: 'PageHeader' },
  { id: 'detail-panel', label: 'DetailPanel' },
  { id: 'review-queue', label: 'ReviewQueue' },
];

export function KitGallery() {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  useEffect(() => {
    document.body.setAttribute('data-theme', theme);
    return () => document.body.removeAttribute('data-theme');
  }, [theme]);
  return (
    <div className="flex flex-col gap-4" data-kit-gallery="">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2 className="text-title font-bold text-fg-heading">Component kit</h2>
          <p className="mt-0.5 max-w-[72ch] text-body text-muted">src/components/kit: new rows use ActionRow, verb sections QueueSection, page headers PageHeader, Details DetailPanel, review flows ReviewQueue. Tailwind and tokens only.</p>
        </div>
        <SegmentedToggle
          label="Theme"
          value={theme}
          onChange={setTheme}
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
          ]}
        />
      </div>
      <nav aria-label="Kit components" className="flex flex-wrap gap-1">
        {NAV.map((n) => (
          <a key={n.id} href={`#${n.id}`} className="rounded-md px-2.5 py-1 text-caption font-bold text-muted no-underline hover:bg-surface-muted hover:text-fg hover:no-underline">
            {n.label}
          </a>
        ))}
      </nav>
      <ActionRowSection />
      <QueueSectionDemo />
      <PageHeaderSection />
      <DetailPanelSection />
      <ReviewQueueSection />
    </div>
  );
}
