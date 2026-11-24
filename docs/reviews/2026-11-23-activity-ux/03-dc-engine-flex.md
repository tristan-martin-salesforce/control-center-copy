# 03 · DC, use-case and time attribution: making the engine flexible

Review and design only (no application code). Base: `b36d889`. Decision drafted: [D-103 (proposed)](../../decisions/0103-coverage-and-event-driven-dc.md).
Cited by tenet name (docs/TENETS.md). Line numbers are at `b36d889`.

## 1. The owner's brief, point by point

**Exists** = it works today for the owner's case. **Partial** = the parts exist but the owner's case falls through. **Gap** = nothing in the repo does it.

| # | Requirement | State | Where (file:line, decision) |
|---|---|---|---|
| 1 | Re-check an open opp's DC for template compliance | **gap** | No checker. A DC comment is written once, at claim time, from the suggestion's reasons (`src/engines/attribution/view.ts:35` `dcComment`; `src/contract/deals.ts:299`). |
| 2 | The manager's DC template held as data | **gap** | No template anywhere: not in Settings, not in the team pack (D-28). `config/team.json` holds only the feedback channel. |
| 3 | A template change re-checks every open deal | **gap** | Nothing reacts to a template change, because no template exists. |
| 4 | New time logged on an opp or account triggers a DC-comment check | **gap** | New time rebuilds `opp_engagement` and re-runs the DC *suggestion* batch (`src/jobs/handlers/opp-engagement.ts:7-8`). It never revisits the comment on an existing DC. |
| 5 | DCs I add by hand in Org62 are taken into account | **exists** | `myDealContributions` reads every DC of mine (`src/engines/deals/soql.ts:86-88`). A hand-made DC closes the gap or request (EDGE-CASES DC-01..03, D-68), and its account joins my book (`src/projections/org62.ts:373`). |
| 6 | "The AEs I support": where they are set and how one is added | **exists** | **Settings ▸ Time ▸ AEs I cover** (`src/components/settings/TimeSection.tsx:160,211-260`): Find by name, which checks the app's people and then makes one read-only Org62 User read (`src/contract/routes.ts:227`, `src/engines/attribution/discover.ts:149`). The list is stored in settings `time.coveredAes` (`src/contract/settings.ts:425-435,461`). It is **not** in `config/team.json`. It shows only for a persona whose book is its opp teams (SE, `src/personas/se.ts:23`). |
| 7 | Scan the open opps of the AEs I support | **partial** | Discovery finds opps where a covered AE is the owner **or on the opp team** (`src/engines/attribution/discover.ts:5-8,236-240`; team rows stored at `src/server/datasource/db/attribution.ts:649-660`). The DC rule and the scorer, however, match a covered AE **only as the opp owner** (`src/engines/attribution/dc.ts:108-119`, `score.ts:164-165`). A specialist AE is usually on the team, not the owner, so their deals are found but never credited. |
| 8 | Scan my AEs' Specialist Forecast (SAR) records | **gap** | `forecast.sync` reads only *my own* SFRs (`src/server/forecast/soql.ts:63-66`, AE persona). `vdp.specialist_aes` runs the other way: from opps the app already has to their SFR owner (`src/server/vdp/specialist-aes.ts:1-14,36-42`). Nothing asks "which opps did my AE just put an SFR on?" |
| 9 | Be on every opp my AEs are on: shown as recommended | **partial, conflicts with the spec** | AT-09 / `dc.ts:13-14,150-151`: "a covered AE's opp I never touched is never suggested." The owner's guidance is the opposite. |
| 10 | Dismiss a recommendation | **exists (three paths)** | DC suggestion Reject (`dc.ts:238-241`). DC gap Not needed (`src/engines/deals/needs.ts:21-25`). Missed-opp Dismiss (`src/server/datasource/db/domains/deals.ts:355-360`). |
| 11 | A dismissal is remembered | **partial** | A rejected suggestion or a Not-needed gap comes back only after 2 h more logged or when I join the team (`dc.ts:159-164`, `src/lib/need-decisions.ts:27,45`). A dismissed missed-opp finding never comes back. The three paths keep three separate memories. |
| 12 | A call on that account overrides the dismissal | **gap** | No resurface rule looks at calls. A 30-minute call adds neither 2 h nor team membership. |
| 13 | Context: the other Data & AI DCs already on the deal or account | **partial** | The missed-opp sweep names them with their splits (`src/engines/deals/findings.ts:112-117`, read by `soql.ts:91-94`, role `AI%Data Architect`). DC suggestions carry only a boolean "split question" (`dc.ts:184-187`), set only when the sweep saw the opp (`src/server/datasource/db/attribution.ts:342-344`). Specialist AEs on the deal are not shown. |
| 14 | Several specialists on one AE (an SE on the small deals, a distinguished SE on the big one) | **partial** | Suggestions are per opp, and another architect's DC turns the row into a split question (AT-12). There is no per-person context to decide with (row 13). |
| 15 | Backfill VDPs for my AEs' accounts | **partial** | A 100% DC brings the account into VDP scope, and the Changes tree lists what is missing (docs/UX.md:212, D-63/D-69). "Find assets for all" runs with `estimateOnly` first and "Allow $N more today" after (`src/server/datasource/db/domains/vdp.ts:180-209`, D-80). |
| 16 | On a backfill, search Drive and Slack for use cases (there are no meetings) | **gap** | `use_cases.extract` reads only the last 21 days of local items (`src/jobs/handlers/use-cases-extract.ts:1-4`). No per-account historical search runs. |
| 17 | VDP scan optional on a backfill, with cost control | **partial** | Find assets is its own opt-in button with an estimate (row 15). No "backfill mode" bundles use cases with an optional VDP scan. |
| 18 | Compliance: suggest removing me from opps I joined by mistake | **gap** | Owner-marked backlog. Added as B-114. |
| 19 | OOO cover for another TA earns credit | **partial** | Calls and Slack on the opp earn engagement, so a DC is suggested under the work rule (`dc.ts:144-147`, DC-33). There is no coverage window, and the split defaults to 100% (`dcSplit: 'full'`, `dc.ts:183`). |
| 20 | An SME assist earns partial credit (50% or 25%) | **partial** | The split can be edited on Edit or Claim (`dc.ts:240`, `src/components/deals/ClaimDc.tsx`). Nothing proposes 50% or 25%. The `evidence` split is a share of my own work, not a credit rule. |
| 21 | Pick it up from any direction: logged in Org62, claimed on my AE's SFR, or a call of mine | **partial** | Org62: exists (row 5). Call: exists, through engagement → `meetings`/`work` reasons (`dc.ts:146-147`). AE's SFR: gap (row 8). |
| 22 | Log time to an **account** when there is no open opp | **partial** | The mechanism exists: a Solutions Event whose WhatId is the Account id (`001…`) (`src/server/datasource/db/store/log-batch.ts:7-9,168`; `src/engines/activity/propose.meetings.ts:21`; enum `what_kind` 'account', `src/db/schema/enums.ts:405`). The app produces it only as a *fallback flagged as a problem*: "Logs to the account for now… Pick the opportunity." (`src/engines/activity/classify.ts:168`, `src/lib/time-issues.ts:67`). That flag shows even when the account has no open opp. The user cannot pick an account on purpose, because `ActivityPatch` has `oppId` only (`src/contract/requests.ts:221-237`). **The repo has no other mechanism.** If the team logs post-sale time differently (another record type or task type; the unused `what_kind` values `dsr` and `strategic_initiative` hint at it), that case is missing: **ask the owner** (§4, J-2). |
| 23 | Show the engine's groundwork ("no active opps, so I tied it to the account") | **partial** | The engine ranks the account first and asks when it has several open opps (`score.ts:242`, AT-02). The rundown lists the likely opps (`src/components/time/OppRundown.tsx:1-6`). No sentence states the decision and the fact behind it. |
| 24 | Fall back to an Org62 search | **partial** | The opp search matches opp or account names (`src/contract/routes.ts:197-198`, `src/contract/time.ts:645-648`). A hit can only set an opp, never an account. |
| 25 | "Three opps this could tie to, I think this one: DCs for all three?" | **partial** | Engagement credits the top candidates without splitting hours. The DC group offers "Claim N DCs" (`dc.ts:169-205`, AT-12, D-84). This happens in the next batch on another surface, not as one confirm on the row. |
| 26 | Adding an AE is a simple scanner change | **partial** | Adding one is a Settings change already (row 6). It has little effect today because of rows 7-9. |
| 27 | A log of why each engine rule or weight changed | **gap** | `src/engines/attribution/weights.ts:1-4` says "tune by data, not by decision prose". No engine changelog exists, and no rule version is stamped on suggestions. |
| 28 | Per-decision audit: why a suggestion was made, why I chose otherwise | **exists** | `dc_suggestions.reasons/evidence`; `attribution_outcomes` (shown target, chosen target, top reason, rule ids: `src/db/schema/attribution.ts:89-108`); change-set reasons; `scan:explain`; the rundown. |
| 29 | Balance against tokens | **exists** | The DC batch is deterministic (`dc.ts:1-5`). Discovery is capped at ≤ 20 lookups a day (AT-15). Every model call goes through one governor: estimate → hold → ask (D-80). |
| 30 | Re-check on events, not on a schedule | **partial** | The DC batch runs nightly at 02:50 and a minute after a correction (`src/worker/schedules.ts:70`, `opp-engagement.ts:7-8`). Discovery runs daily or weekly (`src/contract/settings.ts:467`). A new SFR, a new DC, a template change or a call is never an event. |

**Counts:** 5 exist · 16 partial · 9 gap (30 rows).

## 2. How it reasons today (one page)

**Inputs.**
- **The Org62 mirror:** my book (opp teams and my DCs), discovered opps (`via` = discovered or covered_ae), other architects' DCs on the opps the sweep sees, and line items for products.
- **My activity:** activity rows, Slack, mail, Drive and sessions feed `opp_engagement`. Per opp × ISO week it holds hours, meetings, Slack lines, mail threads, docs, sessions, and a fractional credit from the engine's alternates on rows without an opp (`src/engines/attribution/engagement.ts`).
- **Settings ▸ Time:** `coveredAes`, `dcProducts`, `dcSplit`, `discovery`.
- **Learned rules** (`mapping_rules`) and the persona threshold (`missedOppMinAmountUsd`, 10,000 for an SE, `src/personas/se.ts:71`).

**Opp attribution for a time row** (`score.ts`, `weights.ts:8-31`).
- Each evidence source adds a weight: explicit opp 0.9, a learned rule 0.9/0.7, a channel map 0.88, a title name 0.8, a domain 0.6, opp keywords 0.5/0.7, the AE in the room 0.5, a covered AE 0.3, recency 0.15.
- They combine as `1 − Π(1 − w)`. The top candidate settles at ≥ 0.75 with a 0.15 margin; otherwise the row asks and shows the rundown.
- Account evidence spreads to the account's open opps. With no single opp, the activity projection falls back to the account and flags it (`classify.ts:168`).

**DC suggestions** (`dc.ts:124-209`).
- **Eligible:** an open opp, worth more than the threshold, selling a `dcProducts` product, with no DC or live request of mine.
- **It qualifies when one of these holds:**
  - **team:** I'm on it;
  - **work** this quarter: ≥ 1 h logged, ≥ 2 customer meetings, or credit ≥ 3;
  - **covered:** its *owner* is a covered AE *and* I touched it;
  - **sweep:** the missed-opp sweep claims it.
- **Groups and split:** suggestions on one account form a group with evidence shares that add to 100. The split is 100% (or the evidence share). If another architect already holds a DC, the row becomes a split question with no default.
- **Pre-tick:** only with team or work evidence and a share of at least 15%.
- **Two other engines** also judge "should I have a DC here": the Deals DC gap (`needs.ts`) and the missed-opp sweep (`findings.ts`). They share inputs but keep their own rules and their own dismissals.

**Where the why is recorded.**
- On the row: `dc_suggestions.reasons` (a code and a sentence each) and `evidence` (up to 3 links).
- Per decision: `attribution_outcomes`, plus the change set's `reason` (with Undo).
- Per learned rule: hits and misses in Settings ▸ Time ▸ Learned rules.
- Per scan: `scan:trace` and `scan:explain`.
- **Not recorded:** which version of the rules produced a suggestion, and why a rule or weight changed.

**How the user overrides.**
- Accept, Edit (split, comment) or Reject on a suggestion.
- Not needed or Snooze on a gap; Dismiss with a reason on a finding.
- Pick another opp on a row: the pick becomes a learned rule, and the engine never overrides it (*tenet: Suggest, then learn*).
- Turn a covered AE off; change the products or the split default.

**When it re-evaluates.**
- **On a schedule:** engagement plus DC batch nightly at 02:50; discovery daily or weekly, ≤ 20 lookups; the book read on its scanner cadence; `vdp.specialist_aes` daily.
- **On one event:** a correction on a row, or Refresh, queues the engagement rebuild and the DC batch a minute later.
- Nothing else is event-driven.

## 3. The design: six general mechanisms

The principle: **the engines read facts, and every special case becomes data.** A coverage row, an event, a target kind, a dismissal baseline, a template version or a rule version. No case gets code of its own.

### (a) A coverage model

- **Builds on:** `CoveredAe` (`settings.ts:425`), the Settings list and lookup, discovery's team query, and the `covered_ae` reason.
- **Shape** (additive and optional, so saved settings still parse: a stored `coveredAes` entry reads as `kind: 'ae'`, share 100):
  ```ts
  Coverage = { name, org62UserId?, email?, enabled,
    kind: 'ae' | 'ooo' | 'sme',          // my AE · covering a TA who is out · an assist
    onBehalfOf?: string,                  // ooo: the TA covered
    from?: IsoDate, to?: IsoDate,         // ooo / sme windows; ae has none
    accountIds?: Id[], oppIds?: Id[],     // sme: scoped to these; empty = the person's deals
    creditShare: 100 | 50 | 25,           // the default DC split this coverage proposes
    source: 'settings' | 'learned' }      // learned rows arrive as suggestions, never applied for you
  ```
- **One matcher** replaces the owner-only checks: `coverageOf(opp, day)` → `{ coverage, via: 'owner' | 'team' | 'sfr' } | null`. A person matches as the opp owner, as an opp team member, or as the owner of a Specialist Forecast on the opp (a Data & AI forecast type). Both `dc.ts` and `score.ts` call it.
- **The rule change (amends AT-09 and rule 9):** a kind-`ae` coverage match is a reason on its own. The suggestion is **unticked** and reads "Covered AE Jane's deal (on its team)". A pre-tick still needs my own evidence (D-84: a pre-tick is not an approval). `ooo` and `sme` rows need a touch, as now, and propose their `creditShare` as the split.
- **Learned from Slack and Calendar (follow-on, B-116):** cheap patterns only ("OOO", "out of office", "cover for", "can you jump on", "SME") on items the scanners already read. A hit proposes a coverage row in Needs you ("Cover Sam's deals 12/1–12/12 at 50%?"). Accept adds it. No new reads.
- **Tokens:** 0. Matching is deterministic. The learned proposals use regex over stored items.
- **Does not try to:** read org charts or territory assignment, or decide a share on its own.

### (b) Event-driven re-evaluation with a cheap check first

- **Builds on:** the job queue's dedupe keys, the engagement → DC-batch chain, the `reeval` coalescing (`src/engines/reeval/generation.ts:1-8`), and the change sets.
- **Shape:** an `engine_events` table: `id, owner, kind, subject_kind (opp|account|all), subject_id, payload, created_at, handled_at, outcome, rule_version`. The kinds:
  - `template_changed` (subject: all my open DCs)
  - `time_logged` (an approved or logged row on an opp or account)
  - `sfr_seen` (a covered AE's new or changed Specialist Forecast)
  - `dc_seen` (a DC on an opp is new or changed, mine or another's, including manual ones)
  - `call_seen` (an external meeting the engine settles on an account or its opps)
  - `coverage_changed`
- **The handler, per subject, in order:**
  1. **Fingerprint:** hash(template version, my DC's `Comments__c`, the ids of logged and approved rows on the opp or account since the last check, the set of DCs and SFRs on the opp). If it equals the last *verified* fingerprint, stop. This answers the brief's "same template, already compliant, no new activity: don't rescan".
  2. **Deterministic rules:** re-plan this subject's DC suggestion (`planDcSuggestions` on one opp), the template check (below), and resurfacing (d).
  3. **Model call, only when needed:** when the DC comment fails the template, or new activity exists that the comment does not cite, one Haiku call drafts the updated comment. It is staged as an UPDATE row on the next canvas. Nothing is written until Apply (*tenet: Nothing leaves without approval*).
- **Schedules shrink to a safety net:** the nightly batch stays, deterministic only (0 tokens), and reconciles any missed events. The weekly LLM rescan the owner first imagined is not built.
- **Tokens:**
  - Fingerprint and rules: 0.
  - A draft: about 2k tokens in and 300 out on Haiku, roughly $0.003 each.
  - A template change over 50 open DCs: at most 50 drafts, roughly $0.15. It is estimated and shown first (D-80), and only failing comments are drafted.
- **Does not try to:** poll Org62 for DC changes outside the existing reads (`dc_seen` comes from the book read and the read-back), or rewrite a comment someone edited in Org62 (rule 7, external wins: it is flagged instead).

**The DC template that (b) checks.**
- **Shape:** kept in the team pack (D-28, *tenet: Config over code*), with a Settings ▸ Time override.
  ```ts
  dcTemplate = { version, sections: [{ key, label, hint, required, pattern? }], maxChars }
  ```
- **The trigger:** saving a new `version` emits `template_changed`.
- **The check is deterministic:** required section labels present, patterns met, length within the limit. A model drafts only the missing parts, from cited evidence.

### (c) Attribution target: Opportunity or Account, with the groundwork sentence

- **Builds on:** `Candidate.kind` 'account' (`src/engines/attribution/types.ts:198`), `what_kind` 'account', the canvas accepting a `001…` WhatId, the rundown, and `searchOrg62Opps`.
- **Shape:**
  - `ActivityPatch` gains `target?: { kind: 'opp' | 'account' | 'internal', id }`. `oppId` keeps working.
  - `Attribution` gains `groundwork: { code, text }`, one sentence computed from facts and never from a model:
    - `account_no_open_opp`: "No open opportunity on Acme, so I tied it to the account."
    - `opp_single`: "Acme's only open opportunity."
    - `opp_pick`: "3 open opps could take this; I think *Acme · Data 360* (you logged 4 h there this month)."
    - `rule`: "Learned 11/18 from your pick."
  - An account target with **zero open opps** is a settled state, not an issue. The "Pick the opportunity" flag appears only when the account has open opps.
  - Org62 search returns accounts as well (one more fixed SELECT on the same relay read, within the existing cap). A hit can set either target.
  - **"DCs on all N"** is one confirm on the row's rundown when the top candidates are N opps of one account. Hours stay on the chosen opp, and one change set creates N approved DC requests for the next canvas (the D-84 group, reached from the row).
- **Tokens:** 0, plus one relay read per manual search.
- **Does not try to:** invent a second logging mechanism for post-sale time (see J-2), or split hours across opps (rule 1 stands).

### (d) Dismissals with memory, and the one override

- **Builds on:** `need_decisions` (with baseline), `dc_suggestions.baseline`, and `missed_opps.status`.
- **Shape:** one resurface rule, `resurfaced(baseline, now)`, used by all three paths. The baseline gains `lastCallAt`. A dismissal hides the row until one of these happens:
  - 2 h more are logged (as now);
  - I join the opp team (as now);
  - **a `call_seen` on that account after the dismissal (new).** The row returns once, saying why ("You met Acme on 11/24, after you set this aside"). Dismissing it again moves the baseline. Slack and mail do not override it: the owner named calls.
- **Dismissed missed-opp findings** use the same rule instead of "never".
- **Tokens:** 0.
- **Does not try to:** merge the three surfaces (D-102 places them). It makes their memory agree.

### (e) Backfill mode: use cases from Drive and Slack, VDP optional, cost shown first

- **Builds on:** `planFindAssets` and `enqueueBackfill` (batch id, per-run cap, Allow: `src/server/datasource/db/store/vdp-candidates.ts:216`), the research runner, `use_case_candidates` (dedupe UC-14), and the D-80 governor.
- **Trigger:**
  - The user's "Backfill these accounts" on Deals, multi-select.
  - Or a suggestion when the DC read sees a burst ("You added 52 DCs on 11/20 on Jane's accounts: backfill them?"). A `dc_seen` count above a threshold in one day raises it.
- **Per account:**
  1. A read-only research run over Drive and Slack history (no meetings expected) for use cases. Results become candidates with origin `backfill`.
  2. **VDP asset scan: off by default**, one checkbox for the whole batch.
- **Before running:** the estimate is p50 and p90 from `llm_calls` for each skill, times the number of accounts: "52 accounts · use cases ≈ $3 (p90 $5) · VDP assets +$15 if ticked". It is held, it raises a hand at the hold, and it continues on Allow (*no arbitrary caps*: estimate → warn → pause → continue).
- **Tokens:** priced as above. Zero until the user starts it.
- **Does not try to:** create VDPs or use cases for you (Accept as today), or read meetings that do not exist.

### (f) An engine decision log, and a per-decision audit the UI can cite

- **Rule log:** `docs/engines/CHANGELOG.md`, one entry per change to a rule, weight or threshold: date, `rule_version` (e.g. `dc@3`), what changed, why, decision id, and the EDGE-CASES rows affected. The code holds the current version (`DC_RULE_VERSION` beside `DEFAULT_WEIGHTS`). A test fails when a weight or threshold changes without a version bump (a snapshot of the constants).
- **Stamped on every output:** `dc_suggestions.rule_version`, `attribution_outcomes.rule_version`, `engine_events.rule_version`.
- **The UI's why:**
  - The details fold of a suggestion or row shows its reasons (exists), its rule version with that changelog line ("dc@3, 11/24: covered AEs' deals suggested without a touch, D-103"), and its **event trail** from `engine_events` ("re-checked 11/25 because 1.5 h were logged; comment already compliant: no change").
  - The Assistant reads the same rows.
- **Tokens:** 0.
- **Does not try to:** auto-tune weights. The accept rate in `attribution_outcomes` informs a human edit, which gets a changelog line.

## 4. Conflicts and judgment calls (each resolved by a general rule)

| # | Situation | General rule that resolves it |
|---|---|---|
| J-1 | Two specialists on one account: an SE on the small deals, a distinguished SE on the big one | **Suggestions are per opp, never per account.** Each row carries context: the other Data & AI DCs (name, role, split) and the SFR specialists on it. A pre-tick needs *my* evidence on *that* opp. When someone else holds 100% and I have no evidence, the row is unticked: "Jane holds 100%". The dismissal is per opp. |
| J-2 | A call on an account that already bought, with no open opp | **The target follows the facts:** zero open opps means the account is the target, settled, with the groundwork sentence. No DC is suggested (no opp to hold it). When an opp opens later, account evidence spreads to it as today (`score.ts`). **Open question for the owner:** if the team logs post-sale time some other way (another Event record type, a task type, a Strategic Initiative or DSR record: `what_kind` already reserves `dsr` and `strategic_initiative`), name it. Then it becomes a third target kind, not a special case. |
| J-3 | A DC the manager asked for, with no activity | **External wins** (rule 7): it is read as mine and is never a gap. The template check may find the comment short of the template. The drafter cites only evidence, so a missing section becomes a hint the user fills ("Added at manager's request; covering Jane's book"). It never invents work. |
| J-4 | OOO cover or an SME assist on a deal outside my AEs | **The coverage row sets the default split** (`creditShare`). Evidence decides whether the row appears; coverage decides how much it claims. With no coverage row, the default stays 100% (D-63: a lower split keeps a use case off Org62). The row says so. |
| J-5 | Dismissed, then a call on that account | **Resurfaces once.** Dismissing it again moves the baseline past that call. |
| J-6 | The AE's SFR names an opp that is below the threshold or not a DC product | **Eligibility rules first, coverage second.** It is not suggested, and the event outcome records why. It stays visible in the audit trail. |
| J-7 | The template changes while a DC comment update waits on a canvas | **Preflight** (rule 5): the staged row drops, and the new check re-drafts against the new version. |
| J-8 | My covered AE leaves the opp, or the coverage window ends | **Stale, kept** (AT-10): a new suggestion that held only by coverage goes stale. Accepted DCs are never touched. A "remove me" is backlog (B-114). |
| J-9 | The covered AE is the owner on one opp and only an SFR owner on another | **One matcher, `via` recorded:** the reason text says which ("on its team", "their Specialist Forecast"). The weights are the same. |

## 5. Backlog (added to docs/BACKLOG.md)

- **B-114:** Compliance "remove me". An open opp where I'm on the team or hold a DC, with no covered AE on it, no evidence in two quarters, and no manager-requested marker, is suggested for removal as a draft handoff (never a write). Owner: low priority.
- **B-115:** A DC comment UPDATE row on the logging canvas (Slackbot updates `Deal_Contribution__c.Comments__c`). Verify live, as B-100 did for SFR updates.
- **B-116:** Coverage learned from Slack and Calendar (OOO and SME patterns → a proposed coverage row).
- **B-117:** Account-level time: confirm with SE Ops whether post-sale time logs to the Account (WhatId `001…`) or by another mechanism (J-2).
- **B-118:** One dismissal memory for the missed-opp sweep, DC gaps and DC suggestions (built in chunk 3; listed so the sweep's "never returns" is tracked until then).

## 6. Build plan (in order of value per token)

| # | Chunk (≤ 45 min) | `files:` | Owner examples it makes work |
|---|---|---|---|
| 1 | **coverage-match**: `Coverage` fields on `CoveredAe` (kind, window, creditShare; back-compatible); `coverageOf()` matching owner, team or SFR; a kind-`ae` match suggests unticked without a touch (amends AT-09 and rule 9); `creditShare` as the default split; Settings rows gain kind, window and share | `src/contract/settings.ts`, `src/engines/attribution/{dc,score,types,rundown}.ts`, `src/server/datasource/{db,mock}/attribution.ts`, `src/components/settings/TimeSection.tsx`, `tests/attribution/**`, `docs/EDGE-CASES.md`, `docs/UX.md` | "add the AEs I support", "be on any opp my AEs are on", OOO at 50%, SME at 25%. **This is the chunk that makes adding an AE actually work.** It is already a Settings field (not code, not `config/team.json`), but today it misses a specialist AE who isn't the owner. |
| 2 | **sfr-and-context**: one fixed SELECT for covered AEs' open Data & AI SFRs inside `org62.discover` (same cap); `otherDealContributions` on candidate opps; `DcSuggestion.context { dcs[], specialists[] }`; chips on the row | `src/engines/attribution/discover.ts`, `src/jobs/handlers/org62-discover.ts`, `src/engines/deals/soql.ts`, `src/contract/attribution.ts`, `src/components/time/DcSuggestions.tsx`, `src/server/datasource/{db,mock}/attribution.ts`, `tests/attribution/**` | "my AE claims it on their SFR", "context on which other Data & AI DCs are on it", two specialists on one AE |
| 3 | **dismissal-memory**: one `resurfaced()` with `lastCallAt`; the call override for all three paths; missed-opp dismissals stop being permanent | `src/lib/need-decisions.ts`, `src/engines/attribution/{dc,engagement}.ts`, `src/engines/deals/{needs,findings}.ts`, `src/server/datasource/{db,mock}/domains/deals.ts`, `tests/deals/**`, `tests/attribution/**` | "dismiss it, and don't bring it back unless I'm on a call" |
| 4 | **account-target**: `ActivityPatch.target`; zero-open-opps account settled; `groundwork` sentence; Org62 account search; "DCs on all N" from the rundown | `src/contract/{requests,time,attribution,routes}.ts` (+ `npm run gen:routes`), `src/engines/activity/classify.ts`, `src/lib/time-issues.ts`, `src/projections/matching.ts`, `src/engines/attribution/{score,rundown}.ts`, `src/components/time/**`, `src/server/datasource/{db,mock}/domains/time.ts`, `tests/time/**` | "no active opps, so I tied it to the account", "three opps, I think this one, DCs on all three?", Org62 search fallback |
| 5 | **engine-events + decision log + template check**: migration `engine_events` and `rule_version` columns; emitters (time approved, dc_seen, sfr_seen, call_seen, coverage_changed, template_changed); fingerprint skip; deterministic template check; `docs/engines/CHANGELOG.md`; constants snapshot test | `src/db/migrations/**`, `src/db/schema/attribution.ts`, `src/engines/attribution/**`, `src/jobs/handlers/{dc-suggest,opp-engagement}.ts`, `src/contract/settings.ts`, `src/worker/schedules.ts`, `docs/engines/CHANGELOG.md`, `tests/attribution/**` | "re-check only when required", "a template change scans all open deals", "time logged funnels it in", "a log of why each change was introduced" |
| 6 | **dc-comment drafter + backfill mode**: a Haiku drafter for failing or stale comments (governor hold, UPDATE canvas row, B-115); "Backfill these accounts" with use cases from Drive and Slack, VDP assets optional, estimate before start; the DC-burst prompt | `src/llm/research/**`, `skills/*.md`, `src/server/vdp/find.ts`, `src/server/datasource/{db,mock}/domains/{deals,vdp}.ts`, `src/engines/activity/canvas-workorder.ts`, `src/components/deals/**`, `tests/**` | "the DC comments update with my new time", "backfill VDPs for the 50 DCs I just added", "VDP scan optional; don't burn credits" |

Chunks 1-4 cost no tokens at run time. Chunk 5 costs none until a template fails. Chunk 6 is the only one that spends, and only behind an estimate. Chunk 5 touches a migration (`CONTRIBUTING.md`, D-96). Chunk 4 changes the contract, so it regenerates routes. Chunks 1 and 3 change rules 9 and AT-09/AT-13 in `docs/EDGE-CASES.md` first (D-85: a behaviour change changes a rule).
