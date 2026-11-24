# D-76: Loopback-only web bind with a Host/Origin guard

- **Status:** Accepted · built in 1.3.1 (chunk p0-ops-safety)
- **Date:** 2026-11-20
- **Source:** H-1. [synthesis §8](../reviews/2026-11-20-holistic/README.md); [lane 11](../reviews/2026-11-20-holistic/11-packaging.md) PKG-1, R1, R13

## Context
`next start -p 4327` had no `-H`, so the installed web app listened on every network interface, with no Host or Origin check. Anyone on the same network could read the app's API, and a page open in the browser could post to it (DNS rebinding, cross-site POST).

## Decision
- The web binds `127.0.0.1` everywhere it starts: the LaunchAgent, `dev:web`, `start`.
- `middleware.ts` runs every request through `guardRequest` (`src/ops/host-guard.ts`): the Host must be `localhost`, `127.0.0.1` or `[::1]` on the app's port, and a write that carries an `Origin` must be same-origin. Anything else gets a short 403.
- Shipped as a patch before any other work.

## Consequences
- Requests without an Origin (curl, scripts, the worker) still pass, so local tooling keeps working.
- `npm run doctor` warns when the web agent still listens on every interface (an old LaunchAgent plist).
- Gates the first teammate install (lane 11 R13 checklist).

## Supersedes
None. Adds to `docs/ARCHITECTURE.md` §8.
