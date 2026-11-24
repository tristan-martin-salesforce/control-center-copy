'use client';
/**
 * Dropdown menu on top of Popover: role="menu", ↑/↓/Home/End roving focus, typeahead, Enter/Space
 * to select, Esc to close. Items show their shortcut with KbdHint.
 * v2: inset rounded items on the L2 popover; hover is a quiet fg/8 wash, keyboard focus is the blue selection tint.
 */
import { useRef, type KeyboardEvent, type ReactElement, type ReactNode } from 'react';
import { cn } from './cn';
import type { Placement } from './floating';
import { Icon } from './Icon';
import { useIsMac } from '@/client/keyboard/KeyboardProvider';
import { ariaKeyShortcuts, KbdHint } from './Kbd';
import { Popover } from './Popover';

export type MenuEntry =
  | {
      type?: 'item';
      id: string;
      label: string;
      description?: string;
      icon?: string;
      kbd?: string;
      tone?: 'danger';
      disabled?: boolean;
      onSelect: () => void;
    }
  | { type: 'radio'; id: string; label: string; description?: string; checked: boolean; disabled?: boolean; onSelect: () => void }
  | { type: 'separator'; id?: string }
  | { type: 'label'; id?: string; label: string }
  | { type: 'custom'; id: string; render: (close: () => void) => ReactNode };

export interface MenuProps {
  trigger: ReactElement;
  items: MenuEntry[];
  placement?: Placement;
  width?: number;
  label?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  header?: ReactNode;
  footer?: ReactNode;
}

export function Menu({ trigger, items, placement = 'bottom-end', width = 240, label, open, onOpenChange, header, footer }: MenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const isMac = useIsMac();

  const focusables = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') ?? []);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>, close: () => void) => {
    // WAI-ARIA menu: Tab on an item leaves the menu and closes it (focus goes back to the trigger, then on with the
    // Tab); a custom entry's own fields (Later ▾'s date) keep Tab
    if (e.key === 'Tab' && (e.target as HTMLElement).matches?.('[role^="menuitem"]')) {
      close();
      return;
    }
    const els = focusables();
    if (!els.length) return;
    const i = els.indexOf(document.activeElement as HTMLElement);
    const go = (n: number) => {
      e.preventDefault();
      els[(n + els.length) % els.length]?.focus();
    };
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i < 0 ? els.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(els.length - 1);
    else if (e.key.length === 1 && /\S/.test(e.key) && !e.metaKey && !e.ctrlKey) {
      const ch = e.key.toLowerCase();
      const start = i + 1;
      for (let k = 0; k < els.length; k++) {
        const el = els[(start + k) % els.length]!;
        if ((el.textContent ?? '').trim().toLowerCase().startsWith(ch)) {
          e.preventDefault();
          el.focus();
          break;
        }
      }
    }
  };

  return (
    <Popover trigger={trigger} placement={placement} width={width} role="menu" label={label} open={open} onOpenChange={onOpenChange} className="overflow-hidden p-1">
      {({ close }) => (
        <div ref={listRef} onKeyDown={(e) => onKeyDown(e, close)}>
          {header}
          {items.map((it, idx) => {
            if (it.type === 'separator') return <div key={it.id ?? `sep${idx}`} role="separator" className="-mx-1 my-1 h-px bg-line" />;
            if (it.type === 'label')
              return (
                <div key={it.id ?? `lbl${idx}`} className="eyebrow px-2.5 pt-2 pb-1">
                  {it.label}
                </div>
              );
            if (it.type === 'custom') return <div key={it.id}>{it.render(close)}</div>;
            const isRadio = it.type === 'radio';
            return (
              <button
                key={it.id}
                type="button"
                role={isRadio ? 'menuitemradio' : 'menuitem'}
                aria-checked={isRadio ? it.checked : undefined}
                aria-disabled={it.disabled || undefined}
                aria-keyshortcuts={!isRadio && it.kbd ? ariaKeyShortcuts(it.kbd, isMac) : undefined}
                tabIndex={-1}
                onClick={() => {
                  if (it.disabled) return;
                  close();
                  it.onSelect();
                }}
                className={cn(
                  'flex min-h-10 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-body outline-none compact:min-h-8 compact:py-1',
                  'focus:bg-selected focus-visible:shadow-[inset_0_0_0_2px_var(--color-focus)]',
                  // One text colour per state: same-property utilities resolve by CSS order, not class order.
                  it.disabled
                    ? 'cursor-not-allowed text-disabled'
                    : !isRadio && it.tone === 'danger'
                      ? 'text-danger-700 hover:bg-fg/8'
                      : 'text-fg hover:bg-fg/8 focus:text-fg-heading',
                )}
              >
                {isRadio ? (
                  <span className="grid size-4 shrink-0 place-items-center">{it.checked ? <Icon name="check" size="sm" className="text-link" /> : null}</span>
                ) : it.icon ? (
                  <Icon name={it.icon} size="md" className={it.disabled ? undefined : it.tone === 'danger' ? 'text-danger-700' : 'text-muted'} />
                ) : null}
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{it.label}</span>
                  {it.description ? <span className="block truncate text-caption text-muted">{it.description}</span> : null}
                </span>
                {!isRadio && it.kbd ? <KbdHint combo={it.kbd} decorative /> : null}
              </button>
            );
          })}
          {footer}
        </div>
      )}
    </Popover>
  );
}
