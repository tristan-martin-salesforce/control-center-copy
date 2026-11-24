# 11 · Packaging, install/update/feedback loop, end-to-end errors (lane PKG)

Reviewer: PACKAGING. Scope: owner's ask #12 and follow-up (packaged app, version drift, Slack feedback as bug intake, out-of-the-box for non-technical teammates, end-to-end error handling). Per-connector failure catalogue: CONNECTORS-PROVIDERS lane. Storage engine choice (PGlite/SQLite): DATA-MODEL lane. This report references both rather than duplicating them. Read-only; nothing under `src/`, `scripts/` or other docs was changed.

## 1. Summary

1. **The plumbing is good, but the person has to hold it together.** `npm run update` (`scripts/ops/lib/update.mjs:48-169`) has real rollback, the worker's schema guard (`src/worker/schema-guard.ts:1-13`) is sound, and doctor (`src/ops/doctor.ts:531-550`) has 18 checks. A teammate still runs about 14 terminal steps across six tools before onboarding (§2.1). Those steps rely on Homebrew, Postgres, Python and Playwright. Four steps are **hard** for a non-technical user. The worst is the VDP cookie script, which is copied from another repo.
2. **Versions drift in ways nobody can see.** The npm on each Mac rewrites the lockfile. This worktree has `package-lock.json` modified, with 168 `libc` lines removed. Upstream changes to the lock then make the `--ff-only` update fail. Local "fix it myself" edits leave the git sha unchanged, so the version line and the feedback report can't show them (`next.config.ts:7-21`). Nothing pins Node: `engines >=20`, no `.nvmrc`.
3. **Rollback is half done.** When the build or migration fails, the web's previous `.next` is restored. The worker, though, runs **TypeScript source through tsx** (`package.json` `worker:start`), and the source has already been fast-forwarded. The worker restarts on the new code and old schema while the web serves the old build (`scripts/ops/update.mjs:117,134-141`).
4. **Shell decision.** My recommendation is (a) now: keep localhost web + LaunchAgents, add a one-line bootstrap installer, embedded DB (DATA-MODEL lane) and an in-app updater now (weeks). Later add (b)+(d), a **signed** Electron menubar shell, but only once a Developer ID or Jamf distribution is confirmed. Tauri is not worth a one-person maintainer's time here. A Homebrew cask is ruled out: unsigned casks are deprecated, and Homebrew planned to disable casks that fail Gatekeeper from September 2026 (cited in §4).
5. **Error handling is split three ways and missing one level.** There are three classifiers, `src/llm/errors.ts:21-44`, `src/outbox/errors.ts:15-34` and `src/server/errors.ts:3-11`, with three code namespaces and no shared catalog of code → user text → next step → action. Doctor exists **only as a CLI**: Health never shows Postgres, Claude CLI, disk or backup state. The Claude CLI isn't checked for sign-in, quota or overage, and has no `claude -p` smoke test. Separately, **the web binds every network interface** (`next start` with no `-H`, `scripts/ops/lib/plist.mjs:35`) and has no Origin/Host check. That must be fixed before anyone else installs the app.

## 2. How it works today

### 2.1 Install as a non-technical teammate experiences it (README.md:7-60, scripts/ops/setup.mjs)

| # | Step (where documented) | Who does it | Non-technical rating | Why |
|---|---|---|---|---|
| 1 | Install Homebrew (README.md:9) | user, Terminal | Medium | One paste, then an admin password. Managed Macs may block it or need Self Service |
| 2 | `brew install node` (README.md:10) | user | Easy | Unpinned: they get whatever Node is current (this machine has v25.4) |
| 3 | `brew install postgresql@17` + `brew services start` (README.md:13-16) | user | Medium | Breaks if they already run Postgres on :5432, and the error is cryptic |
| 4 | Install Claude Code and sign in | user | Medium | Not in README. Scanner expects the binary at `~/.local/bin/claude` (`src/llm/env.ts:15-17`), but doctor checks `claude` on PATH (`src/ops/doctor.ts:617`) |
| 5 | Have the `slack` and `Org62-Sobject-Read` MCP servers configured, then two `claude mcp login`s (README.md:19-20) | user | **Hard** | Login is documented. Adding the server entries is not: doctor only says "add the … MCP server in Claude Code" (`src/ops/doctor.ts:146`) |
| 6 | Install devbar (internal), `devbar auth login`, `devbar mcpgw connectors connect google-workspace-readonly` (README.md:21-27) | user | Medium-Hard | Three tools and three concepts. devbar is also the LLM `apiKeyHelper` gateway (`src/llm/claude-env.ts:1-11`), which isn't explained anywhere |
| 7 | VDP: admin-issued PAT pasted into `~/.claude.json`, plus a Python script copied from another repo, `pip install playwright`, `playwright install chromium` (README.md:72-97) | SE only | **Very hard** | Hand-editing JSON with a secret, a Python toolchain, and a script that isn't in this repo |
| 8 | Fonts from sfdc.co/fonts (optional) | user | Easy | Optional |
| 9 | `git clone <repo-url>` (README.md:36) | user | Medium | Needs git, Xcode CLT (prompts a 1 GB install) and repo access |
| 10 | `npm install` (1.1 GB node_modules, measured) | user | Medium | Slow; native-binary warnings look like failures |
| 11 | `npm run setup` (5 infra steps, `setup.mjs:150-213`) | user | Easy | Good: idempotent, prints a to-do list |
| 12 | "Build and start it in the background now?" → `npm run build` + `ops:install` (`setup.mjs:282-327`) | user | Easy (if it works) | The build takes minutes and devDependencies must be installed |
| 13 | Onboarding in the browser, six steps (README.md:51-58) | user | Easy | Sources step offers **Copy** only (`src/components/onboarding/steps.tsx:369-373`), while Health has buttons that run the re-auth (`src/reauth/handlers.ts:24-46`) |
| 14 | `npm run doctor` when something is off | user | Hard | CLI only. Some output is personal: sibling apps `talk-track`/`pulse-footprint` and `~/Projects/PORTS.md` (`src/ops/doctor.ts:266-269,303-321`). Those checks are `skip` when absent (fine), but they're Tristan's, not a teammate's |

Minimum useful set: Slack (step 5) plus Calendar, which comes through **devbar** (step 6). "Calendar+Slack only" therefore still needs devbar, Claude Code, Node and today's Postgres. Onboarding doesn't block on missing sources (`src/components/onboarding/derive.ts:261-274`), so the degradation itself works.

### 2.2 Update (scripts/ops/update.mjs, scripts/ops/lib/update.mjs)
`git fetch` → a major version asks first → `git merge --ff-only` → `launchctl bootout` both agents → `npm install` (**not `npm ci`**, `update.mjs:123`) → snapshot `.next` (APFS clone) → `npm run build` → `pg_dump` backup → `db:migrate` (one transaction) → bootstrap the agents → poll `/api/v1/version` (`update.mjs:156-161`). A failure at install, build, backup or migrate restores `.next` and restarts the agents (`lib/update.mjs:122-150`). It refuses when the agents run another checkout (`lib/update.mjs:59-63`). That refusal is correct, and it is why lanes and worktrees can never update the live install.

### 2.3 Release (scripts/release.mjs, docs/RELEASING.md)
`npm run release -- patch|minor|major`: refuses a dirty tree, bumps the package and lock, folds `[Unreleased]` plus conventional commit subjects into CHANGELOG, commits, and creates an annotated tag. It never pushes. Distribution is then done **by hand**: `git commit-tree "vX^{tree}" -p share`, then `git push origin share:main` (README.md:233-247), with `npm run scan:private` run first (also by hand). No git hook enforces it (`core.hooksPath` unset, no `.husky`). Teammates get updates only when they run `npm run update`. Nothing tells them a new version exists.

### 2.4 Bug intake (D-56; src/server/feedback/*, src/outbox/adapters/feedback.ts)
Feedback button → the panel captures page, route, "looking at", version, sha, persona and the **last 10 browser console/window errors** (`src/components/feedback/context.ts:35-48`, `client-errors.ts:7-56`) → `POST /feedback/diagnose`. That route scrubs the text (pass 1), then runs `skills/feedback-diagnose.md` (Sonnet, ≤ $0.40, 14 turns). The skill gets read-only `feedback_*` tools over event log, jobs, health, scans, trace, page and entity, plus **Read/Grep/Glob over the repo source**. Its output is scrubbed again (pass 2). The user edits it, and `POST /feedback/reports` scrubs it a third time and stages one `feedback.post` Outbox item. Send goes through the normal confirm-token dispatch to the one configured channel (`config/team.json` or Settings ▸ Feedback), under dry run, with "Post live" respected (`src/lib/feedback/payload.ts:79-81`).
The post (`src/server/feedback/format.ts:16-37`) contains: kind, title, `vX · sha · persona · page · looking-at`, summary, steps, expected/actual, diagnosis (cause, files, confidence), and the reporter's first name. It does **not** contain: worker version or mismatch, migration state, doctor results, connector states, error codes, OS/Node/Claude CLI versions, a "locally modified" flag, or any server log lines.

### 2.5 Errors and logging today
- **Scanner/LLM:** `classifyError` uses ordered regex signatures → `{errorClass, code, gateway}` (`src/llm/errors.ts:21-56`). `reauthFor` maps auth errors to a command (`:89-107`). The result is a `ConnectorHealthProbe` that Health renders.
- **Outbox:** its own regex list, with user-facing messages inline (`src/outbox/errors.ts:15-39`).
- **API:** `AppError` with 7 codes (`src/server/errors.ts:3-34`). Unknown errors become `internal` carrying the raw `err.message` to the client (`src/server/http.ts:41`). `stripHtml`/`clipSentence` make toasts readable (`src/lib/error-text.ts`).
- **Worker → UI:** `app_events` (component, code, errorClass, fingerprint, occurrence count, resolved; `src/db/schema/health.ts:33-67`) plus NOTIFY triggers (0026), Health ▸ Needs you (`src/components/health/NeedsYou.tsx`), worker heartbeat/blocked state, and macOS notifications for four kinds only (`src/ops/notify.ts:4-10`).
- **Logging:** `console.log('[worker] msg {json}')` (`src/worker/index.ts:62-65`). `pino` is a dependency and `serverExternalPackages` entry (`next.config.ts:30`) but **is imported nowhere** in `src/`, `app/` or `scripts/`. `run-service.mjs` writes rotated logs (10 MB × 5) and scrubs **only env-file values whose key looks secret** (`scripts/ops/lib/envfile.mjs:33-40`). There's no `uncaughtException`/`unhandledRejection` handler in the worker. launchd `KeepAlive` and `ThrottleInterval 15` restart it (`ops/launchd/com.controlcenter.worker.plist.tmpl:30-38`).

## 3. Findings

**PKG-1 (blocker for any teammate install): the web listens on every interface, with no auth and no Origin/Host check.** The plist runs `next start -p 4327` with no `-H` (`scripts/ops/lib/plist.mjs:35`), and the installed Next CLI documents `-H` as "default: 0.0.0.0" (`node_modules/next/dist/bin/next:114`). A grep found no `middleware.ts` and no Origin, Host or `sec-fetch` checks in `src/` or `app/`. Anyone on the same café or hotel Wi-Fi who can reach the Mac (if the macOS firewall allows node) can read `/api/v1/*`: customer names, deals, drafts. A malicious web page can also send simple cross-origin POSTs to `localhost:4327`, and DNS rebinding can read responses. Dispatch needs a confirm token, but `previewDraft` hands one out over the same API. *Tenets: Local data, privacy-safe logs; Nothing leaves without approval.*

**PKG-2 (major): rollback reverts the web but not the worker or the code.** The worker runs `tsx src/worker/index.ts` (`package.json` `worker:start`; the plist uses `npm run worker:start`, `plist.mjs:35`). Update fast-forwards the tree (`update.mjs:117`) before install and build. On failure, `restore` only swaps `.next` back (`update.mjs:134-141`). The tree, `node_modules` and the worker stay on the new code. The schema guard saves the case where the new code has a new migration (the worker waits). With no migration, the worker runs v(N+1) and the web v(N): the "mismatch" amber footer, with "Run npm run update" as the fix, which is the command that just failed. The failure message prints `git reset --keep <sha>` for the user to run (`lib/update.mjs:166`). Nobody non-technical will do that.

**PKG-3 (major): the lockfile drifts per machine and breaks the next update.** `npm install` (`update.mjs:123`) on a different npm rewrites `package-lock.json`. Proof: this worktree shows `M package-lock.json` with 168 `libc` lines removed. The next `git merge --ff-only` aborts whenever upstream also touched the lock ("Your local changes would be overwritten"). The user sees only "merge failed. Nothing changed." (`lib/update.mjs:22`). The `^` ranges stay pinned by the lock only while `npm ci` is used, and it isn't. Node isn't pinned either (`engines: >=20`, no `.nvmrc`). Today's machines run 20 through 25.

**PKG-4 (major): local edits can't be seen in version or feedback.** `buildMeta` records `git rev-parse --short HEAD` and nothing about a dirty tree (`next.config.ts:14-20`). A teammate who "fixed it themselves" reports `v1.3.0 · abc1234`, identical to a clean install. A local *commit* gives an unknown sha, and from then on `--ff-only` fails for good (§PKG-3, same message). The `share` branch's shas aren't in Tristan's `main` (README.md:233-247), so mapping a reported sha back to code needs `git log share`.

**PKG-5 (major): doctor is CLI-only, and Health can't see the machine.** `runDoctor` is imported only by `src/ops/doctor.ts` itself (grep). Health shows scanner-probe connector states, worker liveness and spend (`NeedsYou.tsx:26-36`), but never Postgres, migrations-as-doctor-sees-them, the Claude CLI, devbar install state, the VDP script, disk, the backup age, or the LaunchAgent Node path. Those exist only in the terminal. And when Postgres is down the web can't render at all: no `app/error.tsx` or `global-error.tsx` exists (find), and the API returns `internal` with the raw `ECONNREFUSED` text (`src/server/http.ts:41`).

**PKG-6 (major): "Claude Code itself" is barely checked.** Doctor runs only `claude --version` (`doctor.ts:124-128`). Nothing checks the sign-in or API state, the subscription or overage limit, or the minimum CLI version for SDK 0.3.316. No cheap `claude -p` smoke test exists. There's no signature for "credit balance too low" or "usage limit reached" in `src/llm/errors.ts:21-44`, so those read as `unknown` (retried) or `rate_limited`. Doctor checks `claude` on PATH while the runners use `CC_CLAUDE_BIN ?? ~/.local/bin/claude` (`src/llm/env.ts:15-17`; `src/llm/one-call.ts:145`, `skill-runner.ts:522`, `chat/runner.ts:325`). A Homebrew or npm Claude install passes doctor and then fails every scan with `executable_missing`. `claude mcp list` output is parsed as human-readable text (`src/ops/mcp.ts:41-45`), which can break silently on a CLI update.

**PKG-7 (major): three error vocabularies, and no catalog.** LLM codes (`needs_auth`, `http_401`, `gateway_error`, …), Outbox codes (`auth`, `not_sent`, …) and API codes (`conflict`, `upstream_unavailable`, …) overlap. The same "token expired" becomes `invalid_auth` in a scan and `auth` in a send, and the fix text lives in three places (`llm/errors.ts:89-107`, `outbox/errors.ts:22`, the `doctor.ts` `fix:` strings, `src/reauth/handlers.ts`). Some next steps lead nowhere. Google auth says "Reconnect this source from Settings → Connectors" (`llm/errors.ts:106`) when the fix is devbar. The re-auth state model is 4 states (`ok | auth_needed | offline | unknown`, `src/reauth/types.ts:20-24`), which can't tell *not installed* from *signed out* from *expired*. Onboarding works around that with regexes over messages (`src/server/onboarding/sources.ts:94-101`). *Tenet: Every handoff is one click away* (the "Settings → Connectors" text breaks it).

**PKG-8 (major): feedback reports carry no machine diagnostics.** The post has version/sha/persona/page plus the model's diagnosis (`format.ts:16-37`). It leaves out the worker version, migration state, the failing connector states and codes, recent `app_events` codes, doctor results, OS/Node/Claude CLI versions, a dirty flag and server log lines. The agent *reads* health, but only the prose diagnosis reaches Slack. With several users, Tristan can't group reports ("12 reports, 9 are `gateway_error` on v1.3.0"), because no stable error code or fingerprint is in the post. The diagnose agent also needs **the repo source on disk** (Read/Grep, `skills/feedback-diagnose.md:9`, `service.ts:137`). A packaged app that ships only a built bundle (Electron asar, `output: 'standalone'`) loses that unless it ships `src/` too.

**PKG-9 (minor): pino is a dead dependency and logs aren't structured.** It appears in `package.json` and `next.config.ts:30` with no import. Worker lines are greppable but not JSON, and the web logs whatever Next and `console.error` print, including full error objects (`http.ts:42`). Log scrubbing knows only env-file secrets. It doesn't apply the `safeLogText` redaction the scanners use (`src/llm/redact.ts:144`). So a `Cookie:` header echoed in an MCP error would reach `worker.log` unredacted (not verified with a live error). *Tenet: Local data, privacy-safe logs.*

**PKG-10 (minor): no crash recording.** The worker has no `uncaughtException`/`unhandledRejection` handler, and launchd restarts it every 15 s. A crash loop shows as "worker stopped beating" (heartbeat) with no reason. The cause is only in `worker.log`, which the feedback report doesn't include.

**PKG-11 (minor): onboarding copies the command, Health runs it.** The re-auth handlers with `act({confirm})` (`src/reauth/types.ts:40-47`) open Terminal with the exact command (`src/reauth/terminal.ts:21-36`). Onboarding's Sources step offers only Copy, and tells the user to paste it in Terminal (`steps.tsx:369-373,477`). Non-technical users drop off at exactly that point.

**PKG-12 (minor): Tristan-specific doctor checks and the release dance.** The sibling apps and the `~/Projects/PORTS.md` registry (`doctor.ts:266-321`) mean nothing to a teammate. They `skip` cleanly, but still print. The share-branch commit-tree and push are done by hand, and so is `scan:private`. One missed step publishes private history (README.md:221-247). *Tenet: Low upkeep, team-portable.*

**PKG-13 (minor): D-3 is stale.** D-3 says "Localhost web app. Revisit a menubar shell after P5 (B-050)" (`docs/DECISIONS.md:30`), and PLAN P7 lists "packaging" with no decision behind it (`docs/PLAN.md:18`). Ask #12 is the moment to revisit it. §5 has the options.

## 4. App-shell options (research, with sources)

Research was done 2026-11-20. Claims marked *unverified* couldn't be confirmed.

**Gatekeeper facts that decide everything:**
- Since macOS 15 the Control-click → Open bypass is gone. An unsigned or un-notarized downloaded app needs System Settings ▸ Privacy & Security ▸ Open Anyway ([MacRumors 2024-08](https://www.macrumors.com/2024/08/06/macos-sequoia-gatekeeper-security-change/), [Apple](https://support.apple.com/guide/mac-help/mh40616/mac)).
- On Tahoe 26.6, ad-hoc-signed **quarantined** code was offered for Trash, while ad-hoc-signed **non-quarantined** code launched with no prompt ([Eclectic Light 2026-08-11](https://eclecticlight.co/2026/08/11/how-can-you-run-code-that-hasnt-been-notarised/)).
- `curl` and CLI `git` don't set quarantine ([Apple forums](https://developer.apple.com/forums/thread/706442)). One report says Jamf profiles did set it.
- Jamf or Munki installs skip quarantine. An MDM allow-list needs a signing certificate ([Tom Bridge](https://tombridge.com/2019/09/04/manipulating-the-system-policy-database-with-configuration-profiles/)).
- The Developer Program costs $99/yr ([Apple](https://developer.apple.com/support/compare-memberships)).

So **today's git-clone + local build is, by accident, the Gatekeeper-proof path**. Any downloaded app bundle needs signing and notarization, or Jamf, to be usable by non-technical people.

| | (a) localhost web + LaunchAgents + installer | (b) Electron (Next + worker in-process) | (c) Tauri 2 + Node sidecar | (d) menubar-only shell | (e) Homebrew tap |
|---|---|---|---|---|---|
| Install UX | One pasted line (`curl … \| bash`), or a `.pkg` via Jamf Self Service; opens the browser | Drag `.app` from a `.dmg` | Same as (b) | (b) or (c), plus browser tab | `brew tap` + `brew install --cask` |
| Update UX | In-app "Update" running the update steps (§7) | `electron-updater`: download, restart. **Requires a signed app on macOS** ([electron-builder](https://www.electron.build/docs/features/auto-update)) | `tauri-plugin-updater`; minisign update signatures are mandatory ([Tauri](https://v2.tauri.app/plugin/updater/)) | Per the host shell | `brew upgrade` (user must remember) |
| Embedded DB | Postgres today. PGlite/SQLite per DATA-MODEL lane removes the Homebrew/Postgres steps | PGlite in-process fits. PGlite is a single connection, and web+worker share it (v0.4 multiplexing; [PGlite v0.4](https://electric.ax/blog/2026/03/25/announcing-pglite-v04)) | Same, inside the sidecar | Same | Formula can depend on `postgresql@17` + `brew services` |
| Claude Code / MCP | Unchanged: external CLI, detected | Unchanged. The app spawns `claude`, and needs PATH discovery because GUI apps don't get the shell PATH | Same, plus sidecar process management | Same | Same |
| Signing | Not needed for clone+build or Jamf `.pkg`. A downloaded `.pkg` needs a Developer ID Installer cert | Developer ID + notarization in practice. Unsigned means no auto-update | Same as (b), plus the updater key (lose it and you strand installs) | Same as host | Homebrew 5.0 deprecated unsigned casks and planned to disable casks failing Gatekeeper from Sept 2026 ([brew.sh 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0), [6.0.0](https://brew.sh/2026/06/11/homebrew-6.0.0/)); private taps also need a GitHub token per user ([Workbrew](https://workbrew.com/docs/create-a-private-tap)) |
| Build complexity (one maintainer + agents) | **Low**: scripts already exist | Medium-High: `output: 'standalone'` (copy `public/` and `.next/static` by hand), unpack native modules from the asar, `utilityProcess` for the worker ([Electron](https://electronjs.org/docs/latest/api/utility-process)); about 250-400 MB (estimate; `@anthropic-ai` alone is 333 MB in node_modules) | **High**: Rust toolchain, `pkg`/`bun --compile` of Next and the worker (pkg struggles with native modules), sidecar lifecycle is yours to manage ([Tauri sidecar](https://v2.tauri.app/learn/sidecar-nodejs/)) | Medium (Electron `menubar`) | Low build, but blocked by signing |
| Compliance | Unchanged: local, MCP + `claude -p` | Unchanged if loopback-only. A new binary may need a security review | Same as (b) | Same | Same |
| Private feed | git remote (exists) | electron-updater on a private GitHub repo puts `GH_TOKEN` on every Mac ("not suitable for all users", electron-builder docs). Use a generic HTTPS or S3 feed instead | Static `latest.json` anywhere | — | Token per user |

**What this means:** (b), (c), (d) and (e) all depend on one question that isn't technical: **can Salesforce IT sign the app (Developer ID) or push it through Jamf Self Service?** Without that, any bundle you download takes four clicks into System Settings and gets no auto-update. That isn't "works out of the box." With it, (b)+(d) is the best end state. Tauri costs more and gains nothing that matters here, because the payload is a Node server anyway (Tauri's 3-10 MB shell becomes about 100 MB once Node is bundled; [next-bun-compile](https://www.pkgstats.com/pkg:next-bun-compile)).

## 5. Recommendations (prioritized)

**R1 (S, do first): loopback-only, plus an Origin/Host guard.** Add `-H 127.0.0.1` to the web agent (`plist.mjs:35`) and to `dev:web`. Add `middleware.ts` that rejects any request whose `Host` isn't `localhost:<port>`/`127.0.0.1:<port>` and any mutating request whose `Origin` isn't the same, which also covers DNS rebinding. Add a test. There's no data migration; re-running `npm run ops:install` re-renders the plist. Fixes PKG-1.

**R2 (S): a deterministic update.**
- Use `npm ci` instead of `npm install` (`update.mjs:123`).
- Pin Node via `.nvmrc` + `engines: ">=22 <25"` and have doctor check it.
- Before the merge, run `git checkout -- package-lock.json` when only the lock is dirty.
- When the tree has other changes or local commits, stop with a plain message: "You changed the app's code here (N files). Update would overwrite them. [Save my changes to a branch and update] / [Cancel]", which runs `git stash push -u -m cc-update-<ts>`, or creates a branch.
Fixes PKG-3 and the second half of PKG-4.

**R3 (M): rollback that covers code and worker.**
- Build into a staging dir, or `git worktree add .cc-next <newsha>`, and swap only on success. Alternatively, on any failure after the merge, `git reset --keep <fromSha>` + `npm ci` automatically, before the agents restart.
- Compile the worker (`tsup`/`esbuild` to `dist/worker.mjs`) so the worker, like the web, runs an artifact that can be snapshotted. That also drops `tsx` from production dependencies.
Fixes PKG-2. Depends on lane TESTING/BUILD for the bundler choice.

**R4 (S): version identity that shows drift.**
- `buildMeta` adds `dirty: n files` and `channel`.
- `/api/v1/version` and the footer show `v1.3.0 · abc1234 · modified` (amber).
- Feedback carries it.
- Release stamps `CC_RELEASE_TAG` so share-branch shas map back.
Fixes PKG-4.

**R5 (M): one error catalog (`src/errors/catalog.ts`)** used by all three classifiers. Each entry:
`{code: 'AUTH.SLACK.EXPIRED', class, severity, retry, userTitle, userText, nextStep, action?: {kind: 'reauth'|'run'|'open'|'link', ref}, docsAnchor}`.
- The classifiers return a code. Health, toasts, the Outbox, doctor and the feedback post all render from the catalog.
- Codes are stable strings. Old codes map through an alias table, so stored `app_events.code` and `connector_health` rows keep reading. There's no schema change, because `code` is already text.
Taxonomy (the CONNECTORS-PROVIDERS lane fills the per-connector rows):

| Class | Prefix | Examples | Retry | Default next step |
|---|---|---|---|---|
| Dependency | `DEP.*` | `DEP.CLAUDE.MISSING`, `DEP.CLAUDE.TOO_OLD`, `DEP.DEVBAR.MISSING`, `DEP.PYTHON.NO_PLAYWRIGHT`, `DEP.DB.DOWN`, `DEP.NODE.TOO_OLD` | no | Install button / command, then **Check again** |
| Auth | `AUTH.<src>.*` | `AUTH.SLACK.SIGNED_OUT`, `AUTH.ORG62.EXPIRED`, `AUTH.GOOGLE.DEVBAR_SIGNED_OUT`, `AUTH.VDP.COOKIE_EXPIRED`, `AUTH.VDP.NO_PAT`, `AUTH.LLM.GATEWAY_KEY` | no; pause the source | Re-auth button (existing `src/reauth` act) |
| Network/gateway | `NET.*` | `NET.OFFLINE`, `NET.VPN_REQUIRED` (Zscaler), `NET.GATEWAY_DOWN` (maintenance page), `NET.TIMEOUT` | backoff | "Connect to Zscaler / wait; we retry at HH:MM" |
| Quota/rate | `RATE.*` | `RATE.SLACK`, `RATE.ORG62.REQUEST_LIMIT`, `RATE.LLM.USAGE_LIMIT`, `RATE.LLM.CREDIT` | backoff / pause till reset | "Resumes at HH:MM" or "Your Claude plan's limit…" |
| Data/schema | `DATA.*` | `DATA.SCHEMA_BEHIND`, `DATA.SCHEMA_AHEAD`, `DATA.CONTRACT_INVALID`, `DATA.SOQL_INVALID` | no | Update button / report |
| Bug | `BUG.*` | `BUG.UNHANDLED`, `BUG.CHECK_CRASHED`, `BUG.WORKER_CRASH_LOOP` | no | **Report this** (pre-filled feedback) |

**R6 (M): doctor becomes a service, and Health ▸ Setup shows it.** Move the checks into `src/ops/checks/*`, shared by the CLI and a new `GET /api/v1/doctor`. The worker runs them every 15 min, writes results as `app_events` (`DEP.*`), and the web reads that cached state. Health gains a "This Mac" section, and the sidebar shows one amber dot when something needs the user. When the DB is down, a static `app/global-error.tsx` and a DB-free `/api/v1/doctor` explain "The database isn't running" with a Start button (`brew services start`, or a PGlite restart after DATA-MODEL). Drop or gate the Tristan-only checks behind `CC_DEV_CHECKS=1`. Fixes PKG-5 and PKG-12.

**R7 (M): doctor-driven onboarding.** One state machine per dependency, and the Onboarding Sources step and Health ▸ Setup render the same rows. Every state has plain-language *why*, an exact command, a **Run** button (the existing `src/reauth` `act`, which opens Terminal for anything interactive and never touches credentials), a verify probe, and a degrade rule.

States: `missing → installed → signed_out → expired → ok`, plus `offline` (network) and `unknown` (the probe failed; never treated as broken). That extends `ReauthStatus.state` (`src/reauth/types.ts:22`) in a way that adds without breaking: map old `auth_needed` to `signed_out`/`expired`.

| Dependency | Why (user words) | Probes (read-only) | States → action | Degrade when not ok |
|---|---|---|---|---|
| Claude Code CLI | "Control Center reads your sources through Claude Code" | Resolve binary: `CC_CLAUDE_BIN` → `~/.local/bin/claude` → `/opt/homebrew/bin/claude` → `which claude` (one resolver shared by doctor and runners). Run `claude --version` ≥ pinned min. **Smoke**: `claude -p "reply OK" --max-turns 1 --model <haiku>`, once a day and on Check again, about $0.001 | missing → "Install Claude Code" link + command; too_old → `claude update`; signed_out (smoke fails auth) → `claude` /login in Terminal; quota (`RATE.LLM.*`) → shows reset time / plan; ok | Nothing works; show a full-page blocker in onboarding |
| LLM gateway (devbar apiKeyHelper, `claude-env.ts`) | "Your Claude usage goes through the company gateway" | Smoke result classified `AUTH.LLM.GATEWAY_KEY`/`NET.GATEWAY_DOWN` | → `devbar auth login` (Run) | All model stages pause (exists) |
| Slack MCP | "To-dos from your DMs and mentions" | Server present in `claude mcp list` (prefer `--json` if available, else today's parse with a version pin); state | missing → "Add Slack to Claude Code" (exact command or the org's managed config: *open question*); signed_out/expired → `claude mcp login slack` (Run) | Slack scanner off; Home says "Slack not connected · Connect" |
| Org62 MCP | "Deals, events, logging" | Same | Same, `Org62-Sobject-Read` | Org62 scans, Time logging and DC suggestions off; Time still logs locally |
| devbar + Google | "Gmail, Calendar, Drive, Gemini notes" | `devbar --version`; `auth status --json`; `mcpgw status --json`; HTTP probe (existing `doctor.ts:167-195`) | missing → install instructions (internal link); signed_out → `devbar auth login`; gateway down → `devbar daemon start`; connector missing → `devbar mcpgw connectors connect google-workspace-readonly` | Calendar, Gmail and Gemini off. With Slack only, the app is a reply/ask list |
| VDP (SE only) | "Keep your VDPs current" | `~/.claude.json` entry, PAT presence (never read out), cookie JWT exp, script path, Python with Playwright (`resolvePython`) | no_pat → "Ask your VDP admin" (mailto template); no_script → **ship the script** (or vendor it under `ops/vdp/` with its license, see D-B); no_playwright → Run `python3 -m pip install --user playwright && python3 -m playwright install chromium`; expired → Re-auth VDP (exists) | VDP pages read-only from the mirror; autopilot paused (exists) |
| Network (Zscaler / Okta) | "Org62 and VDP need the corporate network" | Classify `NET.VPN_REQUIRED` from DNS/TLS failures on the Org62/VDP hosts; Okta = VDP window refresh | Text only: "Turn on Zscaler" | Retry with backoff; no re-auth loop (exists for VDP) |
| Database | "Where your data lives on this Mac" | `pg_isready` today; PGlite open after DATA-MODEL | missing/down → Start (Run `brew services start postgresql@17`) | App unusable → global error page |
| Background worker | "Scans while you work" | heartbeat (exists), blocked (exists), crash count (R9) | dead → Restart (`launchctl kickstart -k`); blocked → Update | Pages show last data, "Paused since HH:MM" |

The minimum to "Start first scan" is Claude CLI ok + one source ok. Everything else is a row with a button, so the app never fails as a whole because one source is missing.

**R8 (S): the feedback post carries diagnostics automatically.** Append a fixed, scrubbed `Diagnostics` block (collapsed in Slack as a code block):
- `version · sha · modified · channel`, OS, Node, Claude CLI version;
- worker version and mismatch; migration state;
- the connector states with their **catalog codes**;
- the last 10 open `app_events` codes with counts;
- the doctor summary;
- **the last 50 lines of `worker.log`/`web.log`**, put through `safeLogText` and the feedback `Scrubber` (both exist), with a per-line cap.
The user still sees and edits the whole text before Send. *Tenet: Nothing leaves without approval* holds, because it's the same Outbox item and dry run. The block also gives Tristan a grouping key: `top code`. The agent should use `feedback_*` reads only when `src/` isn't present (packaged build), so diagnosis keeps working without the source (PKG-8).

**R9 (S): crash policy.**
- Worker: `process.on('uncaughtException'|'unhandledRejection')` writes a `BUG.UNHANDLED` app_event (code + stack top frame, redacted), flushes, and exits 1. launchd restarts it.
- On start, run-service counts restarts in the last 10 min. More than 5 means `BUG.WORKER_CRASH_LOOP`, Health shows "The worker keeps stopping · Report this", and the throttle backs off to 5 min.
- Web: the same, plus `app/global-error.tsx`.
- Replace the hand-rolled `console.log` lines with pino (already a dependency) using its `redact` paths, or remove pino. One structured JSON line format feeds R8's log tail.

**R10 (M): in-app update and a release channel.**
- Release, as one command. `npm run release` gains `--publish`, which:
  1. runs `scan:private` and refuses on any hit;
  2. builds the `share` commit from the tag tree (README.md:241);
  3. pushes `share:main` and tag `vX.Y.Z` to the shared remote;
  4. creates a **GitHub Release** with the CHANGELOG section as notes and `prerelease` for beta.
  This needs Tristan's sign-off, because it pushes (CLAUDE.md invariant: agents never push, so Tristan runs it). Hard invariant 1 is not affected, because it covers external business systems, not git.
- Channels: `stable` (tags `vX.Y.Z`) and `beta` (`vX.Y.Z-beta.N`). The setting lives in Settings ▸ About, and the default is stable.
- Update check: the worker polls `git ls-remote --tags origin` once a day, read-only, with no account data sent. The web shows a banner like "1.4.0 is available: what's new · Update". "What's new" is the CHANGELOG sections between versions (`sectionsBetween` exists). **Update** queues an `app.update` job that a tiny detached updater runs (it must outlive the web it stops). The updater runs today's `runUpdate` with R2/R3, writes progress to a file, and the page polls `/api/v1/version` until it reads the new version. A major version needs an explicit confirm that shows the manual step.
- Telemetry: none automatic. The only signal back is the user-approved feedback post (R8). That's consistent with the tenets.

**R11 (S, process): `docs/FEEDBACK-INTAKE.md`.**
- Each week, read the feedback channel and copy each post into a GitHub issue on the private repo (by hand, or via a Claude session Tristan runs) with labels: `kind:bug|idea`, `code:<catalog code>`, `version:<x.y>`, `persona:se|ae`, `sev:blocker|major|minor`, `dup-of`.
- Triage rule: a `code:` seen from ≥ 2 users, or any blocker, goes into the next **patch**; ideas get rolled into the next **minor**. Each release's CHANGELOG lines cite the issues. Reply in the Slack thread with "fixed in vX.Y.Z · Update in the app".
- The post's diagnostics block (R8) makes grouping mechanical.

**R12 (L, after R1-R10 and a signing answer): a signed Electron menubar shell.**
- A tray icon (worker state, "N need you", Open, Update, Quit) hosts the Next standalone server and the compiled worker as `utilityProcess` children, bound to 127.0.0.1.
- It uses the embedded DB from the DATA-MODEL lane, and keeps an "Open in browser" option so the UI stays the same web app.
- `electron-updater` uses a generic HTTPS or S3 feed, never a per-user `GH_TOKEN`. Distribution is through Jamf Self Service if IT agrees.
- Until then, (a) plus R7 + R10 delivers about 80% of "packaged app that gets updates."

**R13 (S): security and compliance checklist for a packaged internal tool** (gates the first teammate install).

| Item | Today | Needed |
|---|---|---|
| Loopback only, plus Host/Origin guard | ✗ binds 0.0.0.0, no guard (PKG-1) | R1 |
| No secrets stored by the app | ✓ env file has none; sign-ins stay in Claude Code/devbar (`setup.mjs:35-41`); the VDP PAT/cookie live in `~/.claude.json` and are only read for presence and expiry (`src/ops/mcp.ts:68-92`) | Keep it. Doctor and reports must never echo header values (they don't today) |
| Redaction in logs | Partial: env-file values only (PKG-9) | `safeLogText` + header/cookie/JWT patterns on every log line (R9) |
| Redaction in feedback | ✓ three scrub passes | Extend it to the diagnostics block (R8) |
| In-app privacy statement | ✗ README only (README.md:162-218) | Settings ▸ About ▸ "What stays on this Mac": what's read, where it's stored, what leaves (only Outbox items you approve, incl. feedback), retention table, no telemetry |
| Outbound writes | ✓ Outbox, confirm tokens, dry run, allowlist (hard invariants 1-2) | Unchanged. The updater's `git fetch` and tag check are reads of the app's own repo, never of customer systems |
| `scan:private` before push | Manual (README.md:220-231) | Enforced inside `release --publish` (R10). Optionally a `pre-push` hook installed by setup for the maintainer only |
| Supply chain | `^` ranges, `npm install` | `npm ci` against the committed lock (R2), Node pinned, `npm audit --omit=dev` in `check` (warn only) |
| Unsigned app on managed Macs | N/A (clone + build isn't quarantined) | If a bundle ships: Developer ID + notarization, or Jamf Self Service. Never tell users to run `xattr -d` or disable Gatekeeper |
| Compliance scope | Local app, MCP read tools + `claude -p` | Write it in the privacy statement in exactly those words. The shell (Electron) adds no network path of its own beyond the update feed |
| Data at rest | Postgres in the user's account, backups chmod 700 dir | FileVault is assumed (doctor could warn via `fdesetup status`). Backups never go to cloud folders (exists) |

**Interim path reachable in about 3 weeks:**
- Week 1: R1, R2, R4, R9.
- Week 2: R5, R6, R8.
- Week 3: R7, R10, plus a **bootstrap script**, `curl -fsSL <internal raw url>/install.sh | bash`. The script checks for or installs Homebrew, Node (pinned), git, and Postgres (or nothing, after PGlite). It clones, runs `npm ci`, `setup --start`, and opens onboarding. Because the files arrive by `git` or `curl`, nothing is quarantined, so no Gatekeeper prompts appear (§4).
- The VDP script is vendored or fetched by the installer (D-B).

### Dependencies on other lanes
- DATA-MODEL: the embedded DB removes steps 3 and 9 of the table in §2.1 and the `DEP.DB.*` rows. Backups (`pg_dump`) change with it. Migration path: a one-shot `pg_dump` → import into the new engine, run by `npm run update` as a **major** (D-57).
- CONNECTORS-PROVIDERS: fills the `AUTH.*`/`NET.*` rows per connector and the provider abstraction. The catalog (R5) is the shared format.
- TESTING/BUILD: worker compilation (R3), the `npm ci` lane cost.
- UI: the Health ▸ Setup section and the update banner.

## 6. Decisions for Tristan

**D-A: the app shell (revisits D-3).** Options are (a) localhost + installer + in-app update, (b)/(d) a signed Electron menubar, (c) Tauri, (e) a brew cask. **My recommendation: (a) now, then (b)+(d) only if IT confirms Developer ID signing or Jamf distribution.** Ask IT one question: "Can an internal Mac app be signed with the corporate Developer ID, or distributed through Self Service?" If the answer is no, stay on (a) permanently. That works, because clone+build is Gatekeeper-safe. Rule out (c) and (e).

**D-B: how to ship the VDP cookie script.** Options: keep pointing at the other repo, vendor a pinned copy under `ops/vdp/`, or have the installer fetch it from the VDP repo at a pinned commit. **My recommendation: fetch it at a pinned commit, with a hash check.** That removes the hardest manual step without forking someone else's code. Check the license and ownership with the VDP app's owners first.

**D-C: whether the in-app update can stop and restart the app's own services.** Today only a terminal command does this. With R10, a button in the web UI triggers a detached updater that restarts the web. That isn't a write to an external system, so the hard invariants don't apply. It is still a new kind of local self-modification. **My recommendation: allow it**, with backup-first, rollback (R3), and a confirm dialog that shows the version and the changelog.

**D-D: whether a feedback post includes log lines.** **My recommendation: include them** (the last 50, redacted twice, editable before Send). The alternative is codes only. Logs are the difference between a fix and a "can you send me…" loop. *Tenet: Local data, privacy-safe logs* holds, because the logs already hold ids and codes only by design and the user reviews the text.

**D-E: a stable/beta channel.** **My recommendation: add beta**, opt-in in Settings ▸ About. You run beta, and teammates get stable a few days later.

## 7. What's fine, don't touch

- `runUpdate` as pure orchestration over injected deps, with its failure messages (`scripts/ops/lib/update.mjs`). Extend it (R2/R3); don't rewrite it.
- The refusal to update from a checkout the agents don't run (`lib/update.mjs:59-63`). It protects the shared DB from lanes.
- The schema guard: it waits rather than exiting, beats `blocked`, and keeps one Health event (`src/worker/schema-guard.ts`). The migration journal test (`tests/ops/migrations-journal.test.ts`, per RELEASING.md).
- `src/reauth/*`: status/describe/act with `confirm`, AppleScript via argv (no injection), and safe server names (`terminal.ts:8-36`). This is the right base for the Run buttons.
- The three-pass scrubbing in feedback, the server-resolved channel, the confirm-token dispatch and "Post live" (`src/server/feedback/service.ts`). *Tenets: Nothing leaves without approval; Audit everything outbound.*
- `run-service.mjs`: it waits for Postgres, rotates logs, forwards signals, and exits 0 on a deliberate stop.
- The env file at chmod 600 with no credentials in it (`setup.mjs:35-59`). Sign-ins stay in Claude Code and devbar (README.md:31).
- Semver rules and the CHANGELOG discipline (docs/RELEASING.md). `/api/v1/version` with the mismatch and migrationPending flags.
- The backup copy folder that refuses cloud-synced folders (README.md:186-190).

## 8. Open questions / not verified

- How the `slack` and `Org62-Sobject-Read` MCP server *entries* get into a teammate's Claude Code: org-managed config, claude.ai connectors, or a manual `claude mcp add`. It isn't documented in this repo. R7's `missing` action depends on the answer.
- Salesforce IT's policy on Developer ID signing, Jamf Self Service, and whether Jamf adds quarantine to git-cloned files (one report says it can).
- Whether Homebrew's September 2026 cask disable actually ran, and whether it applies to private taps. Research couldn't confirm either.
- Whether `claude mcp list` has a machine-readable output mode in the installed CLI version. Not run, because MCP calls are off-limits for this review.
- Whether a macOS firewall on managed Macs already blocks inbound :4327 (it would soften PKG-1, not remove it). Not tested.
- How long `npm run build` takes on a teammate's Mac, and how big `.next` is (no build run here). The Electron size of 250-400 MB is an estimate.
- Whether MCP error text echoed into `worker.log` ever contains a `Cookie:`/`Authorization:` value (PKG-9). I didn't see one, but nothing guards against it.
- PGlite with two processes (web + worker) sharing one database is the open risk for the embedded-DB path. It's the DATA-MODEL lane's call.
