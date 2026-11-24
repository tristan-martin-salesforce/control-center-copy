/**
 * SEC-4 (17-security-review), P25-2: the one list of HTML that never renders, for every DOMPurify gate that shows
 * model output or other people's text (chat markdown, the composer's previews and source bodies). Nothing here may
 * fetch on render (images, media, frames, stylesheets, `srcset`, `poster`, `background`, `ping`), run, or submit; a link
 * still needs the user's click. Add to this list; never fork it.
 *
 * `style` is forbidden outright for chat markdown. The composer's previews keep an inline `style` only through
 * `sanitizeStyle` (`src/lib/compose/html.ts`: an allowlist of properties, never `url(`, `expression`, `@import`),
 * because "Preview as recipient" must show the email's own inline styles (`STYLE_ATTR` below).
 */
export const FORBID_TAGS: readonly string[] = [
  'script', 'style', 'form', 'input', 'button', 'textarea', 'select', 'iframe', 'frame', 'object', 'embed',
  'img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'svg', 'math', 'link', 'meta', 'base',
];

export const FORBID_ATTR: readonly string[] = ['style', 'srcset', 'poster', 'background', 'formaction', 'xlink:href', 'ping'];

/** The one attribute a gate may keep through a value sanitizer instead of dropping (the composer's previews). */
export const STYLE_ATTR = 'style';

/** `FORBID_ATTR` without `style`, for a gate that runs every inline style through `sanitizeStyle`. */
export const FORBID_ATTR_SANITIZED_STYLE: readonly string[] = FORBID_ATTR.filter((a) => a !== STYLE_ATTR);
