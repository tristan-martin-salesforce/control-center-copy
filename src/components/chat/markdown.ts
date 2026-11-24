/**
 * Sanitized markdown for chat bubbles (VDP's renderMarkdown pattern): `marked` passes raw HTML through, so
 * every render goes through DOMPurify. External links open in a new tab with rel=noopener.
 */
import DOMPurify from 'isomorphic-dompurify';
import { Marked, type Tokens } from 'marked';

import { FORBID_ATTR, FORBID_TAGS } from '@/client/html-forbid';

const g = globalThis as { __ccChatPurifyHook?: boolean };
if (!g.__ccChatPurifyHook) {
  g.__ccChatPurifyHook = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      const href = node.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href)) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    }
  });
}

/**
 * SEC-4 (17-security-review): the text is model output, and the model reads untrusted Slack, Gmail and Drive text. A
 * remote image (`![](https://host/?q=…)`) or any other auto-loading element would make the browser send whatever the
 * model put in its URL off this Mac with no click, around the Outbox. So: HTML only (no SVG or MathML), and nothing
 * that fetches on render; a link still needs the user's click. The list is shared with the composer (src/client/html-forbid.ts).
 */
export const MARKDOWN_PURIFY = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...FORBID_TAGS],
  FORBID_ATTR: [...FORBID_ATTR],
};

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Images are never loaded (above), so a markdown image renders as its words: the alt text, plain (no link to the
 * image's URL, which is the part that could carry data), or nothing without one. A link whose only content was an
 * image keeps its alt text, or shows its address, so it is never an invisible, empty link (24-visual-qa).
 */
const chatMarked = new Marked({
  async: false,
  gfm: true,
  breaks: false,
  renderer: {
    image(token: Tokens.Image) {
      return esc(token.text ?? '');
    },
    link(token: Tokens.Link) {
      const inner = this.parser.parseInline(token.tokens);
      if (inner.replace(/<[^>]*>/g, '').trim()) return false;
      return `<a href="${esc(token.href)}">${esc(token.href)}</a>`;
    },
  },
});

export function renderMarkdown(md: string | null | undefined): string {
  if (!md) return '';
  const raw = chatMarked.parse(md) as string;
  return DOMPurify.sanitize(raw, MARKDOWN_PURIFY) as unknown as string;
}

/**
 * Put the streaming caret inside the last text block, so it trails the words instead of dropping to its
 * own line. `caretHtml` is trusted markup built by the caller (never model output).
 */
export function withCaret(html: string, caretHtml: string): string {
  if (!html) return `<p>${caretHtml}</p>`;
  const m = /(<\/(?:p|li|h[1-6]|td|th|code|blockquote)>)((?:\s*<\/(?:ul|ol|pre|table|tbody|thead|tr|blockquote)>)*\s*)$/.exec(html);
  if (!m) return html + caretHtml;
  return html.slice(0, m.index) + caretHtml + html.slice(m.index);
}
