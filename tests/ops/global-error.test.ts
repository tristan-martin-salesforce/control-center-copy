import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import GlobalError from '../../app/global-error';

// vitest emits classic React.createElement for .tsx (see src/components/composer/__tests__/dom.ts)
(globalThis as { React?: typeof React }).React = React;

describe('app/global-error (PKG R9)', () => {
  it('says what happened in plain words with Retry and Copy details, and never renders the error text', () => {
    const error = Object.assign(new Error('<html><body><script>alert(1)</script>ECONNREFUSED 127.0.0.1:5432 Acme Corp</body></html>'), { digest: 'd1' });
    const html = renderToStaticMarkup(createElement(GlobalError, { error, reset: () => {} }));
    expect(html).toContain('Something went wrong loading Command Center.');
    expect(html).toMatch(/>Retry<\/button>/);
    expect(html).toMatch(/>Copy details<\/button>/);
    expect(html).not.toMatch(/ECONNREFUSED|Acme|alert\(1\)|<script/);
  });
});
