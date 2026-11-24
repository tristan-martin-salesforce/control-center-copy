# D-60: VDP autopilot: what the app applies by itself

- **Status:** Accepted, built · amended 2026-11-21 (SEC-6, below) · amended by D-63 · summarized by [D-85](0085-time-rules.md)
- **Date:** 2026-11-11 (this file: 2026-11-21, when the row was next touched)
- **Source:** the full 2026-11-11 text is the D-60 row in [the archive](../archive/decisions-2026-10..11.md); SEC-6 in [the security review](../reviews/2026-11-20-holistic/17-security-review.md)

## Context
Every VDP write was the user's Apply (D-59). The owner wanted the items with known values applied by themselves.

## Decision
- Settings ▸ Sending ▸ VDP autopilot (`sending.channels.vdp.autopilot`), off for every new user, on only with `confirm: true`; a daily cap (`dailyCap`, default 40).
- It applies only items whose every value is a known fact (create the company or VDP, add an engaged opp, account id and period from Org62, TA = me, strong assets, Generate once the inputs are in), each once, as an Outbox action approved under the autonomy policy, with dry run and read-back unchanged. It never deletes, never changes a value a person entered, never writes guessed text; it pauses on dry run or a stale sign-in, stops at the cap, and never retries a failure.

## Amended 2026-11-21: asset host allowlist, SEC-6
- **Why:** asset candidates come from a search over untrusted Slack, Gmail and Drive text, and any strongest-grade http(s) link (any host, a `.pdf` path) was auto-applied: a crafted message could put an outsider's link into a customer's VDP with no click.
- **Rule:** autopilot adds an asset link only when it is **https**, has **no user name/password**, **no port**, **no IP literal**, and its host is an entry of `settings.sending.autopilotAssetHosts` **or a subdomain of one** (full-hostname match; IDN compared as punycode, so a look-alike never matches). Anything else is an ordinary item that waits for the user's Apply (never dropped), and its card says "Held for you: link is on <host>, not a trusted site". The Outbox door (`autopilotRefusal`) re-checks the host right before the write.
- **Default list:** `salesforce.com`, `force.com`, `my.salesforce.com`, `salesforce-sites.com`, `trailhead.com`, `sfdcstatic.com`, `drive.google.com`, `docs.google.com`, `slides.google.com` (Google Slides: an asset kind the matcher already knows). Fixtures and goldens that reach `auto` use `docs.google.com` only; the placeholder hosts (`docs.example.com`, `example.slack.com`, `loom.com`, `x.example.test`) are not defaults: tests that want them trusted pass them explicitly. Slack files, Loom, Gong and other `RECORDING_HOSTS`/`DOC_HOSTS` stay the user's to add.
- **Setting:** Settings ▸ Sending, under the autopilot toggle: "Autopilot adds links only from these sites; anything else waits for you", with an add/remove row (at most 50). An empty list trusts nothing. Settings are JSON sections: no migration.
- **Not done:** SEC-6 also proposed holding a link first seen in a message from outside the team; the host rule covers the reported risk, provenance-based holding is left for later.

## Consequences
- `tests/vdp/autopilot.test.ts` changed (it used `https://x.example.test/a` as an autopilot asset): the VDP lane's call, made here.
- Tests: `tests/vdp/asset-hosts.test.ts`, `tests/vdp/autopilot.test.ts` (SEC-6 cases), the parity case in `tests/db/datasource/parity-mutations.test.ts`, `src/components/settings/__tests__/sending-asset-hosts.dom.test.ts`.

## Supersedes
Amends D-49 and D-59. Amended by D-63 (the AE from the Specialist Forecast is autopilot's).
