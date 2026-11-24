/**
 * 01 R9: Getting started is its own page (app/getting-started/page.tsx, in the frame). The route table names it for
 * the topbar and the kit's PageHeader, and the client router loads the same page for in-app navigation.
 */
import { describe, expect, it } from 'vitest';
import { pageTitle } from '@/components/kit/PageHeader';
import { isClientPath, matchRoute, pageTitleFor } from '@/components/shell/routes';

describe('Getting started route', () => {
  it('has one title from the route table and is a client route like the others', () => {
    expect(pageTitle('gettingStarted')).toBe('Getting started');
    expect(pageTitleFor('/getting-started')).toBe('Getting started');
    expect(matchRoute('/getting-started').key).toBe('gettingStarted');
    expect(isClientPath('/getting-started')).toBe(true);
    expect(isClientPath('/triage')).toBe(true);
  });
});
