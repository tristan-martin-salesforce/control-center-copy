'use client';
/**
 * `?` cheat sheet: the full keymap (UI-SPEC §14), grouped, in a short overlay. The frame owns the
 * "Anywhere" and "Go to" groups (v2 keys: ⌘J assistant, Esc / `]` panel, `[` sidebar, the new nav
 * chords); the other groups come from the documented table in src/client/keyboard/shortcuts.ts. "Go to" lists the
 * persona's destinations (navDestinationsFor, D-55).
 */
import { usePersona } from '@/client/persona';
import { SHORTCUT_GROUPS, type ShortcutGroup } from '@/client/keyboard/shortcuts';
import { IconButton } from '@/ui/Button';
import { KbdHint } from '@/ui/Kbd';
import { Overlay } from '@/ui/Overlay';
import { NAV_DESTINATIONS, navDestinationsFor, type NavItemDef } from './nav';

export const FRAME_SHORTCUTS: ShortcutGroup = {
  id: 'global',
  title: 'Anywhere',
  items: [
    { keys: 'mod+k', label: 'Search or run a command' },
    { keys: 'mod+j', label: 'Open or close the assistant' },
    { keys: 'escape', label: 'Close the panel, back to where you were' },
    { keys: ']', label: 'Open or close the panel' },
    { keys: '[', label: 'Collapse or expand the sidebar' },
    { keys: 'c', label: 'Capture a to-do' },
    { keys: '?', label: 'Show shortcuts' },
    { keys: 'mod+,', label: 'Settings' },
    { keys: 'z|mod+z', label: 'Undo the last change' },
  ],
};

export const GOTO_SHORTCUTS: ShortcutGroup = {
  id: 'goto',
  title: 'Go to',
  items: NAV_DESTINATIONS.map((n) => ({ keys: n.chord, label: n.label })),
};

/** The table the sheet renders: frame groups first, then everything else, with v1-only rows dropped. */
export function cheatSheetGroups(destinations: NavItemDef[] = NAV_DESTINATIONS): ShortcutGroup[] {
  const goto: ShortcutGroup = { ...GOTO_SHORTCUTS, items: destinations.map((n) => ({ keys: n.chord, label: n.label })) };
  const rest = SHORTCUT_GROUPS.filter((g) => g.id !== 'global' && g.id !== 'goto' && g.id !== 'rail').map((g) =>
    g.id === 'lists' ? { ...g, items: g.items.map((it) => (it.keys === 'enter' ? { ...it, label: 'Open in Details' } : it.keys === 'escape' ? { ...it, label: 'Close Details, back to the row' } : it)) } : g,
  );
  return [FRAME_SHORTCUTS, goto, ...rest];
}

export function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const destinations = navDestinationsFor(usePersona());
  return (
    <Overlay open={open} onClose={onClose} labelledBy="cc-cheat-title" className="w-[min(64rem,94vw)]">
      <div className="flex h-14 items-center border-b border-line px-5">
        <h2 id="cc-cheat-title" className="text-title text-fg-heading">
          Keyboard shortcuts
        </h2>
        <span className="ml-3 text-caption text-muted">Single keys never fire while you type in a field.</span>
        <IconButton icon="close" label="Close" size="sm" className="ml-auto" onClick={onClose} data-autofocus />
      </div>
      {/* a scroller is a tab stop, so the keyboard can scroll it (WCAG 2.1.1) */}
      <div tabIndex={0} role="region" aria-labelledby="cc-cheat-title" className="cc-scroll max-h-[calc(80vh-3.5rem)] overflow-y-auto rounded-b-xl px-5 py-4 focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)] focus-visible:outline-none">
        <div className="columns-1 gap-8 md:columns-2 xl:columns-3">
          {cheatSheetGroups(destinations).map((g) => (
            <section key={g.id} className="mb-5 break-inside-avoid">
              <h3 className="mb-1.5 text-caption font-bold text-fg-heading">{g.title}</h3>
              <dl className="divide-y divide-line">
                {g.items.map((it) => (
                  <div key={`${g.id}-${it.keys}-${it.label}`} className="flex min-h-8 items-center gap-3 py-1 text-body">
                    <dt className="min-w-0 flex-1 text-fg">{it.label}</dt>
                    <dd className="shrink-0">
                      <KbdHint combo={it.keys} />
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </div>
    </Overlay>
  );
}
