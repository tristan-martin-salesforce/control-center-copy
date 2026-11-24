/**
 * Everything the user previews is derived from a serialized payload, never from the editor DOM
 * (brief 08 §2.4). Every HTML string that reaches `dangerouslySetInnerHTML` goes through DOMPurify
 * (`isomorphic-dompurify`) after the compose library's own allowlist sanitizer (CP-2 security rule).
 */
import DOMPurify from 'isomorphic-dompurify';
import type { Destination, DraftPreview } from '@/contract';
import { normalizeDoc, parseSlackMrkdwn, payloadFor, renderPreview, sanitizeHtml, serialize, stableStringify, type DocNode, type Payload } from '@/lib/compose';
import { actionApp, actionPayloadFor } from '@/lib/actions';
import { sanitizeStyle } from '@/lib/compose/html';
import { FORBID_ATTR_SANITIZED_STYLE, FORBID_TAGS, STYLE_ATTR } from '@/client/html-forbid';
import { toComposeDestination } from './destination';

/** SEC-4's list (src/client/html-forbid.ts, P25-2); an inline style survives only through `sanitizeStyle` (hook below). */
export const PURIFY_CONFIG = {
  USE_PROFILES: { html: true },
  FORBID_TAGS: [...FORBID_TAGS],
  FORBID_ATTR: [...FORBID_ATTR_SANITIZED_STYLE],
  ALLOW_DATA_ATTR: false,
  ALLOW_ARIA_ATTR: false,
};

let hooked = false;
function ensureHooks() {
  if (hooked) return;
  hooked = true;
  // An inline style keeps only allowlisted properties with no url(), expression or @import (nothing fetches on render).
  DOMPurify.addHook('uponSanitizeAttribute', (_node, data) => {
    if (data.attrName !== STYLE_ATTR) return;
    const clean = sanitizeStyle(data.attrValue ?? '');
    if (clean) data.attrValue = clean;
    else data.keepAttr = false;
  });
  // Links in a preview never open in place and never leak the opener.
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.nodeName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  });
}

/** The single gate before any HTML injection in the composer. */
export function purify(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}

/** Preview as recipient, from the client-side payload (`renderPreview` → DOMPurify). */
export function previewHtml(doc: DocNode, destination: Destination, labels: Record<string, string> = {}): string {
  return purify(renderPreview(doc, toComposeDestination(destination), { mentionLabels: labels }));
}

/** The exact payload object `payloadFor` builds for this doc and destination. */
export function clientPayload(doc: DocNode, destination: Destination): Payload {
  return payloadFor(doc, toComposeDestination(destination));
}

export interface PayloadView {
  /** Tabs to show, first is default. */
  parts: Array<{ id: 'json' | 'html' | 'text'; label: string; bytes: string }>;
  format: string;
  byteLength: number;
}

const utf8Len = (s: string) => new TextEncoder().encode(s).length;

/** "View payload": the exact bytes from `payloadFor`. */
export function payloadView(doc: DocNode, destination: Destination): PayloadView {
  if (destination.kind === 'action') {
    // The structured request itself (the same mapping the server records and an Apply sends).
    const p = actionPayloadFor(destination);
    return { parts: [{ id: 'json', label: 'JSON', bytes: JSON.stringify(p, null, 2) }], format: `${actionApp(destination.action)} · ${destination.action}`, byteLength: utf8Len(JSON.stringify(p)) };
  }
  const s = serialize(doc, toComposeDestination(destination));
  const p = s.payload as unknown as Record<string, unknown>;
  if (destination.kind === 'email') {
    const html = String(p.html ?? '');
    const text = String(p.text ?? '');
    return {
      parts: [
        { id: 'html', label: 'HTML', bytes: html },
        { id: 'text', label: 'Plain text', bytes: text },
      ],
      format: 'Gmail · text/html + text/plain',
      byteLength: utf8Len(html) + utf8Len(text),
    };
  }
  const json = JSON.stringify(s.payload, null, 2);
  return {
    parts: [{ id: 'json', label: 'JSON', bytes: json }],
    format: s.profile === 'slack_blocks' ? 'Slack · rich_text blocks + mrkdwn fallback' : 'Slack · mrkdwn',
    byteLength: utf8Len(JSON.stringify(s.payload)),
  };
}

/** "View payload" for the server's preview: the request body the dispatch will post, byte for byte. */
export function serverPayloadView(preview: DraftPreview): PayloadView {
  const json = JSON.stringify(preview.payload, null, 2);
  const parts: PayloadView['parts'] = [{ id: 'json', label: 'Request JSON', bytes: json }];
  const html = preview.payload.html;
  if (typeof html === 'string') parts.push({ id: 'html', label: 'HTML', bytes: html });
  return { parts, format: `${String(preview.payload.api ?? preview.destination.kind)}`, byteLength: utf8Len(JSON.stringify(preview.payload)) };
}

/**
 * Render the SERVER's preview payload (what dispatch will actually post, bound to the confirm token).
 * Slack: its mrkdwn `text` is parsed and rendered; email: its `html` is sanitized and rendered.
 */
export function serverPreviewHtml(preview: DraftPreview, labels: Record<string, string> = {}): string {
  const p = preview.payload;
  if (preview.destination.kind === 'slack') {
    const text = typeof p.text === 'string' ? p.text : preview.rendition.body;
    const doc = parseSlackMrkdwn(text, { labels });
    return purify(renderPreview(doc, { kind: 'slack', channelId: preview.destination.channelId, format: 'mrkdwn' }, { mentionLabels: labels }));
  }
  const html = typeof p.html === 'string' ? p.html : preview.rendition.body;
  return purify(sanitizeHtml(`<div class="cc-preview cc-preview-email">${html}</div>`));
}

/** Visible text of an HTML string (tags removed, whitespace collapsed). Used for the parity check. */
function visibleText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|li|div|blockquote|pre|h\d)>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[​\s]+/g, ' ')
    .trim();
}

/**
 * Does the server's rendering show the same words as the editor's preview? The confirm dialog always
 * shows the server payload (that's what dispatch posts); this flags when the two renderers disagree.
 */
export function previewParity(doc: DocNode, destination: Destination, preview: DraftPreview, labels: Record<string, string> = {}): boolean {
  return visibleText(previewHtml(doc, destination, labels)) === visibleText(serverPreviewHtml(preview, labels));
}

/** Canonical identity of a doc (TipTap adds default attrs; normalizing first keeps comparisons honest). */
export const docKey = (doc: DocNode) => stableStringify(normalizeDoc(doc));
