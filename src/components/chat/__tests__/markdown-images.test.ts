/**
 * 24-visual-qa, surface 7: a markdown image in an answer (never loaded, SEC-4) reads as its words, never a broken
 * image and never an invisible link: the alt text plain, nothing without one, and a link around an image keeps the
 * alt text (or shows its address).
 */
import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '@/components/chat/markdown';

describe('renderMarkdown: images', () => {
  it('an image is its alt text, with no link to the image and no <img>', () => {
    const html = renderMarkdown('See ![the pipeline chart](https://x.test/?d=secret) here.');
    expect(html).toBe('<p>See the pipeline chart here.</p>\n');
    expect(html).not.toContain('x.test');
  });

  it('an image without alt text is nothing', () => {
    expect(renderMarkdown('![](https://x.test/a.png)')).not.toMatch(/<img|x\.test/);
  });

  it('a linked image is a plain link with words, never an empty one', () => {
    expect(renderMarkdown('[![ACME logo](https://x.test/l.png)](https://acme.test)')).toMatch(/<a href="https:\/\/acme\.test"[^>]*>ACME logo<\/a>/);
    expect(renderMarkdown('[![](https://x.test/l.png)](https://acme.test/deck)')).toMatch(/<a href="https:\/\/acme\.test\/deck"[^>]*>https:\/\/acme\.test\/deck<\/a>/);
  });

  it('ordinary links and text are unchanged', () => {
    expect(renderMarkdown('Read [the doc](https://docs.test/a) **now**.')).toMatch(/<a href="https:\/\/docs\.test\/a" target="_blank" rel="noopener noreferrer">the doc<\/a> <strong>now<\/strong>/);
  });
});
