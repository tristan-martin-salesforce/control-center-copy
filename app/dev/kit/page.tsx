// Dev-only kit index (FE-1a) and the component kit's spec (01-ui-audit R10: ActionRow, QueueSection, PageHeader,
// DetailPanel, ReviewQueue in every state). 404 outside `next dev`.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { KitGallery } from './_components/KitGallery';

export const metadata = { title: 'Kit · Command Center' };

const ENTRIES: Array<{ href: string; title: string; body: string }> = [
  { href: '/dev/kit/ui', title: 'UI v2', body: 'Design v2 tokens and @/ui primitives, dark first: buttons, rows (quiet actions, loud selection), tabs, menus, dialogs, badges and states.' },
  { href: '/dev/kit/primitives', title: 'Primitives', body: 'Buttons, pills, chips, icons, overlays, side sheet, tabs, panel states, toasts, palette, autosave, optimistic and 409 demos.' },
  { href: '/dev/kit/primitives?section=chrome', title: 'Chrome pieces', body: 'Nav tabs, health, scanner pulse, Dry run / Live send and spend, in each state.' },
  { href: '/dev/kit/primitives?section=save', title: 'Save and concurrency', body: 'Autosave with ?fail=1, optimistic done/snooze with Undo, the two-editor 409 rebase and conflict.' },
  { href: '/dev/kit/lanes', title: 'Lanes', body: 'LanePage, the two-column frame for dense pages: lanes side by side with the panel closed, stacked with pills and collapsed lanes when it opens.' },
  { href: '/dev/kit/primitives?section=sheet', title: 'Drill model', body: 'List keys (j/k, Enter, d, s), the non-modal side sheet with n of N and Esc focus return.' },
];

export default function Page() {
  if (process.env.NODE_ENV !== 'development') notFound();
  return (
    <div className="px-6 py-5">
      <h1 className="text-heading text-fg-heading">Kit</h1>
      <p className="mt-0.5 max-w-[72ch] text-body text-muted">
        Dev-only galleries for the shared UI. Other lanes add their own pages under /dev/kit. The dev toolbar (bottom right) drives the mock scenario, failure rate, forced panel states and density.
      </p>
      <ul className="mt-4 grid max-w-6xl grid-cols-2 gap-3 xl:grid-cols-3">
        {ENTRIES.map((e) => (
          <li key={e.href}>
            <Link href={e.href} className="block rounded-lg border border-line bg-surface p-4 text-fg no-underline transition-shadow hover:shadow-raise hover:no-underline focus-visible:outline-none focus-visible:shadow-focus">
              <span className="block text-body-lg font-bold text-fg-heading">{e.title}</span>
              <span className="mt-1 block text-body text-muted">{e.body}</span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="mt-8 max-w-6xl">
        <KitGallery />
      </div>
    </div>
  );
}
