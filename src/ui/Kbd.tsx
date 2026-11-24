'use client';
/**
 * Keyboard hints. `Kbd` is one key cap; `KbdHint` renders a key spec ("mod+k", "g h", "shift+enter")
 * as caps, mac glyphs on macOS. Mono is reserved for exactly this (brief 12 §6).
 * v2 (mockup `.kbd`): 12 px mono on surface-sunken with a hairline. `inverse` tints from the text colour, so it
 * reads on any fill (accent buttons, tooltips) in both themes.
 */
import type { ReactNode } from 'react';
import { parseSequence, sequenceKeys } from '@/client/keyboard/keymap';
import { useIsMac } from '@/client/keyboard/KeyboardProvider';
import { cn } from './cn';

export type KbdTone = 'default' | 'inverse' | 'quiet';

const TONE: Record<KbdTone, string> = {
  default: 'border border-line bg-surface-sunken text-muted',
  quiet: 'border border-current/25 text-muted',
  inverse: 'border border-current/30 bg-current/15',
};

export function Kbd({ children, tone = 'default', className }: { children: ReactNode; tone?: KbdTone; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-grid h-5 min-w-5 place-items-center rounded-sm px-1.5 font-mono text-micro leading-none font-normal',
        TONE[tone],
        className,
      )}
    >
      {children}
    </kbd>
  );
}

const ARIA_KEY: Record<string, string> = { enter: 'Enter', escape: 'Escape', space: 'Space', up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', delete: 'Delete', backspace: 'Backspace', tab: 'Tab' };

/**
 * A key spec as an `aria-keyshortcuts` value ("mod+k" → "Meta+K" on a Mac, "Control+K" elsewhere; "j|k" → "J K").
 * A chord ("g h") has no ARIA form, so it is left out; undefined when nothing is left.
 */
export function ariaKeyShortcuts(combo: string, isMac: boolean): string | undefined {
  const out: string[] = [];
  for (const alt of combo.split('|')) {
    let seq;
    try {
      seq = parseSequence(alt);
    } catch {
      continue;
    }
    if (seq.length !== 1) continue;
    const c = seq[0]!;
    const mods = [c.meta || (c.mod && isMac) ? 'Meta' : null, c.ctrl || (c.mod && !isMac) ? 'Control' : null, c.alt ? 'Alt' : null, c.shift ? 'Shift' : null].filter(Boolean);
    const key = ARIA_KEY[c.key] ?? (c.key.length === 1 ? c.key.toUpperCase() : c.key[0]!.toUpperCase() + c.key.slice(1));
    out.push([...mods, key].join('+'));
  }
  return out.length ? out.join(' ') : undefined;
}

export interface KbdHintProps {
  /** Key spec: "mod+k", "g h", "shift+enter", "j|k" ("|" = alternatives). */
  combo: string;
  tone?: KbdTone;
  className?: string;
  /**
   * The hint sits on a control that names its shortcut itself (`aria-keyshortcuts`): the caps are only seen, never
   * read, so the control's name is its visible label (WCAG 2.5.3). Otherwise the caps are read as they show (no
   * aria-label on a plain span: that is prohibited ARIA and screen readers drop it).
   */
  decorative?: boolean;
}

/** A small key hint used in buttons, menus, the palette and the cheat sheet. */
export function KbdHint({ combo, tone = 'default', className, decorative = false }: KbdHintProps) {
  const isMac = useIsMac();
  const alternatives = combo.split('|');
  return (
    <span className={cn('inline-flex items-center gap-1 whitespace-nowrap', className)} aria-hidden={decorative || undefined}>
      {alternatives.map((alt, ai) => (
        <span key={ai} className="inline-flex items-center gap-1">
          {ai > 0 ? <span className="text-micro text-muted">/</span> : null}
          {sequenceKeys(alt, isMac).map((group, gi) => (
            <span key={gi} className="inline-flex items-center gap-0.5">
              {gi > 0 ? <span className="px-0.5 text-micro text-muted">then</span> : null}
              {isMac ? (
                <Kbd tone={tone}>{group.join('')}</Kbd>
              ) : (
                group.map((k, ki) => (
                  <Kbd key={ki} tone={tone}>
                    {k}
                  </Kbd>
                ))
              )}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
}
