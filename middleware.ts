/**
 * Loopback-only guard (PKG-1, docs/ARCHITECTURE.md §8): every request passes `guardRequest` (src/ops/host-guard.ts)
 * or gets a short 403. The server also binds 127.0.0.1, so this is the second line: it stops DNS rebinding and
 * cross-site posts from a page open in the user's browser.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { appPort, guardRequest } from '@/ops/host-guard';

export function middleware(req: NextRequest): NextResponse {
  const r = guardRequest({ method: req.method, host: req.headers.get('host'), origin: req.headers.get('origin'), port: appPort(process.env) });
  if (r.ok) return NextResponse.next();
  return new NextResponse(`Forbidden: ${r.message}\n`, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
}
