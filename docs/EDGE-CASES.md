# Edge cases: the round trip between the app, Org62 and VDP

## The rules

How time, DCs and use cases behave, in ten rules. They are the readable spec ([D-85](decisions/0085-time-rules.md), from [lane 06 §5](reviews/2026-11-20-holistic/06-time-activity.md)); the decisions in brackets keep the history ([DECISIONS.md](DECISIONS.md)), and the tables below are these rules applied to cases. A behaviour change changes a rule here first.

1. **Your hours are what you did.** An accepted meeting always logs. Solo work is the time between your own actions and never double-counts a meeting. Agent time never logs. (D-17, D-18)
   - *Amended 2026-11-23 (D-103 (c)):* the hours go to one target, never split across opps: an opportunity, the account itself, or internal work. An account with **no open opportunity** is a settled target, not a problem: the row logs as a Solutions Event on the Account (WhatId `001…`, the one mechanism the code knows; `accountTargetWhat` decides it so B-117 can change it in one place) and says "No open opportunity on Acme, so I tied it to the account." The account fallback ("Pick the opportunity") asks only when the account has open opps. You can pick an account on purpose (Org62 search lists accounts too). Every row says in one sentence why it logs where it does, from facts only.
2. **Every row gets a ranked guess with reasons.** Rules first, then Org62 when nothing fits, then a cheap model only for close calls. Internal is one of the choices. (D-64, D-71; planned: one attribution engine, D-84)
3. **Your corrections become rules.** Each one is listed and removable. A rule never overrides something you set. (*tenet: Suggest, then learn*; planned with D-84)
4. **Nothing goes out until you press Apply.** Rows, DCs and use cases ride one canvas per batch. Slackbot executes it, and the app reads Org62 back. (D-47, D-67, D-72)
5. **A row on a waiting canvas is held.** Reject frees it. Apply hands it off. A change since staging drops it from the canvas. (D-47, D-65 preflight, D-68 DC-05)
6. **The link wins, then the key, then the closest match.** Org62 id, then `CC#`, then subject and time. (D-65, D-67)
7. **External wins, then flag.** A value someone changed in Org62 or VDP is adopted or shown side by side for you to pick. It is never overwritten or deleted. (D-65, D-67, D-68, D-70)
8. **Nothing stays stuck.** Every waiting or failed state has its next click: Log again, Leave out, Ask again, Not needed. (D-61, D-65, D-68)
9. **A DC is suggested where you did the work or cover the AE (an AE you support, an OOO cover or an SME assist).** One click claims a batch. Org62's read settles it. (D-61, D-68; "AEs I cover" built as coverage data, D-84, D-103 (a))
   - *Amended 2026-11-23 (D-103 (a)):* "cover the AE" is coverage as data. An AE I support (kind `ae`) who owns the opp, is on its team or owns its Specialist Forecast makes it a suggestion on its own, unticked, before I touch it. An OOO cover (`ooo`) or an SME assist (`sme`) still needs my work on it, and its credit share (50, 25) is the default split. A coverage change never changes an accepted DC (J-8). A suggestion held only by coverage goes stale when the window ends or the AE leaves (AT-10).
10. **A use case lives in both systems.** The app captures candidates, dedupes them against both, and adds to VDP and Org62 in one click. (D-67, D-70, D-72; candidates planned, D-84)

VDP writes and autopilot (D-46, D-59, D-60, D-63) follow rules 4, 7 and 8: one Outbox Apply per item (autopilot only within its policy and cap), a value someone changed in VDP is adopted or flagged, and a stuck push has its next click. Most of what reads as complexity in D-65..D-69 (twins, the slot rule, timezone shifts, duplicates, merges) is rules 6-8 applied to cases, which is what the Principles and the tables below record.

## The checklist

This is the checklist for handing the app to teammates. Every external change must flow in, and anything done in one system must show up in the other. Nothing may show as open once it's done. The rows come from three read-only audits of main at 28f6b2f on 2026-11-12, each of which ran the real code paths (pure engines probed with scratch scripts, targeted tests run).

**Status:**
- **OK**: handled and tested.
- **BUG**: wrong today.
- **GAP**: unhandled.
- **UNTESTED**: probably right, no test.

Every fix lands with a scenario test named after its row ID. A lane flips its rows to OK, with the test name, when it merges.

## Principles every lane follows
1. **The link beats heuristics.** Once a row is tied to an external record (an Org62 Event, DC, Use_Case__c, or a VDP company, VDP or use case), later passes match on that id first. Fallbacks come after: the `CC#` key, then subject and time, then name.
2. **External wins, then flag.** A value a person changed in Org62 or VDP is adopted (or flagged), never overwritten. A staged change whose `before` no longer matches is withdrawn or refused.
3. **Never hide a real external record.** A second Event in a slot, or an overlapping manual log, stays visible with a flag ("possible duplicate"). It is never silently excluded.
4. **Every stuck state has a way out.** Each terminal-looking state (verify_failed, handed_off, unconfirmed, waiting) offers its next action: Log again, Leave out, Withdraw or Re-check.
5. **Preflight before every write.** A canvas or VDP Apply re-checks the live state. It drops rows no longer approved, and it refuses when VDP or Org62 already has the value or something conflicts.
6. **One count map.** Time, quarter totals, receipts, Home and Deals read the same status → count rules.

## Time logging ↔ Org62 Events (lane: time-roundtrip)

Fixed by D-65 (time-roundtrip). Tests: `tests/time/roundtrip.test.ts` (engine, projection, preflight, counts, mock DataSource) and `tests/db/time/roundtrip-db.test.ts` (Postgres), each named after its row.

**Manual Org62 Events**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| TL-01 | Manual Event: different subject, same start (±5 min) | The proposal closes as its twin | OK (`TL-01 manual Event with another subject and the same start`) |
| TL-02 | Manual Event: start more than 5 min off, a short subject shifted ≤ 1 h, or a timezone shift (±7 h) | Same Related To or account, same day, ≥ 50% overlap counts as a twin, and the proposal closes | OK (`TL-02 start more than 5 min off, a short subject shifted, or a timezone shift`) |
| TL-03 | One Event covering two meetings | It closes every meeting it fully covers | OK (`TL-03 one Event covering two meetings closes every meeting it fully covers`) |
| TL-04 | Two Events for one meeting | Both stay logged; the second is flagged "possible duplicate in Org62" (today it's hidden as overlap; 11 live rows) | OK (`TL-04 two Events for one meeting`, pure and Postgres; migration 0022). Rows an older rule already hid get their week re-projected on the next pass: `TL-04b`, tests/db/projections/db.test.ts |
| TL-05 | Approved row, then logged manually with a different subject or start | Paired by slot; the approved row closes and never goes on a canvas | OK (`TL-05 approved row, then logged manually …`) |
| TL-06 | Row held on a staged canvas, then logged manually | Apply's preflight drops it (re-render) or refuses | OK (`TL-06 …`: preflight, mock Apply, Postgres Apply) |
| TL-07 | Overlapping meeting logged manually while another is approved in-app | The Org62 Event stays logged (D-18 rule 1; 2 live rows) | OK (`TL-07 overlapping meeting logged manually …`, `TL-04 / TL-07` on Postgres) |
| TL-08 | Non-internal task type with an empty Related To | Flag "Related To empty" | OK (`TL-08 a customer task type with Related To empty …`) |

**App-logged Events edited or deleted in Org62**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| TL-10 | Opp or task type edited in Org62 | Adopted; stays verified | OK |
| TL-11 | Duration, start or end edited in Org62 | Adopted, written once (no rewrite on every pass) | OK (`TL-11 duration, start or end edited in Org62 …`, `TL-11 / TL-13` on Postgres) |
| TL-12 | Subject and start edited in Org62 | Matched by `org62_event_row_id`, adopted, not counted twice | OK (`TL-12 subject and start edited in Org62 …`) |
| TL-13 | Related To cleared in Org62 | The row becomes what_kind none (internal) | OK (`TL-13 …`, `TL-11 / TL-13` on Postgres) |
| TL-14 | App-logged Event deleted in Org62 | "Deleted in Org62", with **Log again** / **Leave out** | OK (`TL-14 …`: derivation, mock and Postgres `resolveActivity`) |
| TL-15 | verify_failed, then fixed in Org62 | Moves back to verified; counted in logged hours | OK (`TL-15 verify_failed, then fixed in Org62 …`, pure and Postgres) |
| TL-16 | AE persona (Sales Events, no task type) | Verifies (today every AE row fails on `null !== ''`) | OK (`TL-16 AE persona …`) |

**Canvas outcomes**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| TL-20 | Canvas applied partially | Missing rows show "Not in Org62" on Time, with Log again | OK (`TL-20 canvas applied partially …`, `TL-14 / TL-20 Log again …`) |
| TL-21 | Slackbot creates a duplicate, or the canvas is executed twice | One verifies, the other is flagged as a duplicate | OK (`TL-21 …`) |
| TL-22 | Slackbot shifts times (UTC as local) | Joined on CC#, so the row verifies; a start difference over 5 min is flagged | OK (`TL-22 …`, `TL-23 / TL-22` on Postgres) |
| TL-23 | CC# key | Description is read back (SOQL), and the join is on `CC#<uuid>`; canvas-parse accepts a UUID | OK (`TL-23 the CC# key …`; scan-org62 1.7.0) |
| TL-24 | Canvas never applied, rows inside it later declined or cancelled | Preflight at Apply; stale canvases expire with a notice | OK (`TL-24 …`: preflight, mock Apply, the Postgres expiry sweep) |
| TL-25 | Rows edited after staging, or the canvas edited in Slack | Held rows are locked (edit = unstage), or the canvas is re-parsed before Apply | OK (`TL-25 …`: edit = unstage, preflight compares the staged cells; mock and Postgres) |
| TL-26 | Canvas applied twice | Only one set of Events (holds plus Slackbot's duplicate rule) | OK |

**Calendar changes**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| TL-30 | Meeting declined, before or after approve/stage/log | Removed, or flagged when logged (D-64) | OK |
| TL-31 | Meeting cancelled after approve or stage | Same as declined | OK (`TL-31 meeting cancelled after approve or stage …`) |
| TL-32 | Meeting rescheduled after approve or log | Re-keyed by event id: the row moves; no stale approved row and no new proposal | OK (`TL-32 …`, pure and Postgres) |
| TL-33 | Recurring exceptions; all-day, multi-day, cross-midnight and DST events; onsite days with accepted meetings | Per instance; every accepted meeting logs | OK |
| TL-34 | Week boundaries | Time reads weeks in the profile TZ, the same as projections | OK (`TL-34 week boundaries …`) |

**Counts, personas, failures**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| TL-40 | Evidence vs meetings, Gemini vs calendar, agent vs human time (engaged time: agent runs count only in part); no hour caps since 2026-11-14 | No double counting | OK |
| TL-41 | Legacy record-type Event | Closes the proposal but isn't counted until re-created | OK (`TL-41 a legacy record-type Event …`) |
| TL-42 | Every read-back batch fails (token expired) | Run failed, Health degraded; nothing inferred | OK (`TL-42 every read-back batch fails …`, Postgres) |
| TL-43 | Worker down for more than 14 days | A longer catch-up floor for org62:events | OK (`TL-43 …`: 120 days) |
| TL-44 | Concurrent passes | Per-week lock (landed with D-64), plus a concurrency test | OK (`TL-44 concurrent passes over one week …`, Postgres) |
| TL-45 | One status → count map across Time, quarter totals, receipts and Home | They agree | OK (`TL-45 one status → count map …`) |

## Deals and DCs ↔ Org62 (lane: dc-roundtrip)

**DC lifecycle**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| DC-01 | DC created manually for a flagged opp | The gap closes on the next read | OK (`DC-01 DC created manually for a flagged opp: the gap closes on the next read (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts; mock in tests/deals/dc-roundtrip.test.ts) |
| DC-02 | Waiting request, DC created manually at the same split | The request confirms | OK |
| DC-03 | Waiting add, DC created manually at another split | The request confirms (Org62 wins); no ADD on the canvas | OK (`DC-03 waiting add, DC created manually at another split: the request confirms (Org62 wins), no ADD on the canvas`, tests/deals/dc-roundtrip.test.ts, and its Postgres twin) |
| DC-04 | Waiting change 50→100, Org62 hand-edited to 75 | The change is withdrawn, never overwrites | OK (`DC-04 waiting change 50→100, Org62 hand-edited to 75: withdrawn, never overwrites`, tests/deals/dc-roundtrip.test.ts, and its Postgres twin) |
| DC-05 | Request on a pending canvas, DC lands before Apply | Preflight drops the row | OK (`DC-05 request on a pending canvas, DC lands before Apply: the preflight drops the row`, tests/deals/dc-roundtrip.test.ts; `dcRowStillNeeded`, registered in the canvas Apply preflight by the main session) |
| DC-06 | Canvas applied partially | After the next complete read with no DC: `not_created`, unlocked; the gap comes back; Chase works on Postgres | OK (`DC-06 canvas applied partially: after the next complete read with no DC, not_created and unlocked; the gap comes back; Chase works`, tests/deals/dc-roundtrip.test.ts, and `... Chase works on Postgres`, tests/db/deals/dc-roundtrip-db.test.ts) |
| DC-07 | Canvas applied twice | One DC (holds) | OK |

**DC changes in Org62**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| DC-10 | Split changed 100↔50 | Needs, VDP scope and pipeline follow; staged VDP items for an account that leaves scope withdraw | OK (`DC-10 split changed 100↔50: staged VDP items for an account that leaves the 100% scope are withdrawn`, tests/deals/dc-roundtrip.test.ts, and `... (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts) |
| DC-11 | DC removed (non-team opp) | `dcAssigned` clears; the gap and claim come back | OK (`DC-11 DC removed (non-team opp): dcAssigned clears; the gap and the claim come back`, tests/deals/dc-roundtrip.test.ts, and `... (Postgres)`) |
| DC-12 | Confirmed request, DC later removed | The opp can be a gap again (use the live request only) | OK (`DC-12 confirmed request, DC later removed: the opp can be a gap again (the live request only)`, tests/deals/dc-roundtrip.test.ts) |
| DC-13 | DC reassigned to another SE | Not mine any more (record `SE_Name__c`) | OK (`DC-13 DC reassigned to another SE: not mine any more (SE_Name__c recorded and read)`, tests/deals/dc-roundtrip.test.ts, and `... the gap is back (Postgres)`) |
| DC-14 | Two DCs of mine on one opp (Flex 50/50) | Splits summed per opp | OK (`DC-14 two DCs of mine on one opp (Flex 50/50): splits summed per opp`, tests/deals/dc-roundtrip.test.ts, and `... (Postgres)`) |

**Opps and accounts**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| DC-20 | Opp closed but seen only by the DC read-back; opp reopened but seen only by the book read | The newer source's open/closed state wins | OK (`DC-20 opp closed but seen only by the DC read-back; reopened but seen only by the book read: the newer source wins`, tests/deals/dc-roundtrip.test.ts) |
| DC-21 | Opp moved to another account | The old account's state is cleared | OK (`DC-21 opp moved to another account: the old account loses its state (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts; the move read in tests/deals/dc-roundtrip.test.ts) |
| DC-22 | Opp deleted in Org62 | Tombstoned; never a gap | OK (`DC-22 opp deleted in Org62: tombstoned, never a gap (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts: the read-back re-reads the opps of a DC question by Id) |
| DC-23 | Child accounts with " - org/product" suffixes under one parent | Read `Account.ParentId`; evidence matches the right child (today `nameCore` merges siblings) | OK without the hierarchy (`DC-23 child accounts with " - org/product" suffixes under one parent: evidence matches the right child`, tests/deals/dc-roundtrip.test.ts): full names match, a shared head picks no child; `MatchAccount.parentOrg62AccountId` is the seam for the vdp-roundtrip lane's Account.ParentId read |
| DC-24 | Account merged in Org62 | The surviving account takes over its links | OK (`DC-24 account merged in Org62: every opp it had moved to one survivor`, tests/deals/dc-roundtrip.test.ts, and `... the surviving account takes over its links (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts) |
| DC-25 | Hygiene | Sweeps stale `dcAssigned`, stale account dcStatus and stranded hand-offs | OK (`DC-25 hygiene: sweeps stale dcAssigned, stale account dcStatus and stranded hand-offs; a second sweep finds nothing (Postgres)`, tests/db/deals/dc-roundtrip-db.test.ts) |

**Set-asides, counts, evidence**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| DC-30 | Set-aside (D-61) across a quarter rollover | The baseline is per quarter | OK (`DC-30 set-aside across a quarter rollover: the baseline is per quarter`, tests/deals/dc-roundtrip.test.ts) |
| DC-31 | Home vs Deals DC counts | One source (`dealsNeeds`); Claim DC marks the finding claimed | OK (`DC-31 Home vs Deals DC counts: one source (dealsNeeds); Claim DC marks the finding claimed`, tests/deals/dc-roundtrip.test.ts, and `... (Postgres)`) |
| DC-32 | A VDP I'm on links an open opp with no DC of mine | Strong evidence: gap reason `vdp`; the VDP shows "Waiting for your DC" with Claim DC, not Past | OK for the gap reason (`DC-32 a VDP I am on links an open opp with no DC of mine: strong evidence, gap reason vdp`, tests/deals/dc-roundtrip.test.ts, and `... (Postgres)`); the VDP's "Waiting for your DC" state is VD-11 (vdp-roundtrip) |
| DC-33 | Meetings or Slack only on a non-team opp | Slack counts as evidence, within the strong-evidence rule | OK for Slack (`DC-33 meetings or Slack only on a non-team opp: Slack counts as evidence, within the strong-evidence rule`, tests/deals/dc-roundtrip.test.ts, and `DC-33 Slack as evidence ... (Postgres)`); a non-team opp on an account outside my book is still never read (no read covers it) |

## VDP ↔ app ↔ Org62 (lane: vdp-roundtrip)

**Company identity**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| VD-01 | Child account with a suffix whose parent company exists in VDP | Matched through the Org62 parent chain and VDP's own name rule (aliases too); no create | OK (tests/vdp/roundtrip.test.ts › VD-01) |
| VD-01b | VDP knows the company by its core ("Northwind" for "Northwind Health"); found live 2026-11-12 | The core is looked up too (a substring search never finds the shorter name) and offered as the best guess (Needs you), never a silent create | OK (`VD-01b …`, tests/vdp/roundtrip.test.ts) |
| VD-01c | A legal name trading as a brand ("… d/b/a Brand"); found live | Looked up by the brand; VDP's company by the brand is the match | OK (`VD-01c …`) |
| VD-01d | The judgment proposes a name to create that VDP already has; found live | The name is looked up before it is proposed; an existing company by VDP's rule becomes the match | OK (`VD-01d …`) |
| VD-01e | A subsidiary brand under a parent VDP knows by its core (a separate brand under a parent company) | The core rule stays inside the name family: the brand is never pre-selected as the parent; a parent-name variant ("… DC/AF") is | OK (`VD-01e …`) |
| VD-02 | Company lookups | Misses cached with a TTL and rotated oldest first; unlooked-up rows disabled ("Not looked up yet") | OK (tests/vdp/roundtrip.test.ts › VD-02; tests/vdp/status.test.ts › VD-02 lookups, VD-02 no company lookup yet) |
| VD-03 | Two child accounts under one parent | One VDP company (per the owner's decision) | OK (tests/vdp/roundtrip.test.ts › VD-03) |
| VD-04 | Sibling whose opps are already on the other sibling's VDP | No Create | OK (tests/vdp/roundtrip.test.ts › VD-04) |
| VD-05 | `create_company` returns created:false | One match: use its id. Several: failed. Never shown as applied | OK (tests/vdp/roundtrip.test.ts › VD-05; tests/vdp/autopilot.test.ts › VD-05) |
| VD-06 | Company merged in VDP | The cached match is invalidated on a dead-id error | OK (tests/vdp/roundtrip.test.ts › VD-06; tests/db/vdp/roundtrip-db.test.ts › VD-06) |
| VD-07 | A VDP I'm not on exists for the company | `get_company` vdp_count → "N VDPs you're not on"; no `create_vdp` | OK (tests/vdp/roundtrip.test.ts › VD-07) |

**VDP lifecycle**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| VD-10 | VDP made by hand in the VDP UI | Create items close; children re-home (incl. a VDP whose header carries the parent's account id) | OK (tests/vdp/roundtrip.test.ts › VD-10) |
| VD-11 | VDP exists before my 100% DC | "Waiting for your DC", not Past (with DC-32) | OK (tests/vdp/roundtrip.test.ts › VD-11; tests/vdp/gaps.test.ts › VD-11) |
| VD-12 | Opp on two VDPs | `create_vdp` warnings kept; a looks-wrong row | OK (tests/vdp/roundtrip.test.ts › VD-12; tests/vdp/status.test.ts › the summary) |
| VD-13 | Opp moved, deleted or closed while on a VDP | Flagged; dead ids flagged | OK (tests/vdp/roundtrip.test.ts › VD-13: moved, closed, and deleted in Org62 via the DC-22 tombstones) |
| VD-14 | VDP archived, or I'm removed from it | Tombstone "Archived in VDP"; Create never comes back | OK (tests/vdp/roundtrip.test.ts › VD-14) |

**Edits and push**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| VD-20 | Fields filled in VDP's UI | Items close, staged drafts withdraw | OK |
| VD-21 | Apply after a manual edit, before the next read | Adapter preflight (`get_vdp`/`get_use_case`): refuse on a conflict. Owners = live list ∪ new (`set_vdp_owners` replaces the list) | OK (tests/vdp/roundtrip.test.ts › VD-21) |
| VD-22 | Push on a mirror older than 30 min | A read first, or the push is refused | OK, refused (tests/vdp/roundtrip.test.ts › VD-22) |
| VD-23 | Create timed out, or its read-back unconfirmed | "Maybe made" plus a live check; never re-sent blind | OK (tests/vdp/roundtrip.test.ts › VD-23, VD-25) |
| VD-24 | A read withdraws children mid-push | Drafts of a running push are skipped by the withdraw | OK (tests/vdp/roundtrip.test.ts › VD-24; tests/db/vdp/roundtrip-db.test.ts › VD-24) |
| VD-25 | Parent created by hand mid-push | The live preflight finds it | OK (tests/vdp/roundtrip.test.ts › VD-25) |
| VD-26 | Values edited after staging | Restaged when they differ | OK (tests/db/vdp/roundtrip-db.test.ts › VD-26) |
| VD-27 | Big push vs VDP's limits (60 calls/min, 20 generations per 10 min, Generate takes 30-90 s) | Shared limiter, 120 s Generate timeout, at most 20 Generates per push | OK (tests/vdp/roundtrip.test.ts › VD-27) |
| VD-28 | Push while signed out | Push gated on sign-in | OK (tests/vdp/roundtrip.test.ts › VD-22 … VD-28) |
| VD-29 | Partial failure, re-push, dry run | Descendants skipped; no second create | OK |

**People, assets, detection**
| ID | Scenario | Expected | Status |
|---|---|---|---|
| VD-30 | Specialist Forecast owner changes after the AE is set | Looks-wrong row with an add suggestion (never a replace) | OK (tests/vdp/roundtrip.test.ts › VD-30) |
| VD-31 | Asset removed in VDP before the next read | Not re-added | OK (tests/vdp/roundtrip.test.ts › VD-31) |
| VD-32 | A required argument is added upstream | `required` is stored and checked | OK (tests/vdp/roundtrip.test.ts › VD-32) |
| VD-33 | Tool removed or added, VDP down | Feature detection; D-69: vdp-app #11 (entitlement leveraged, sales segment) is on while the list is unknown, and a stored list without it disables those items again | OK (tests/vdp/gaps.test.ts › the entitlement leveraged … disabled again when a stored list lacks it) |
| VD-34 | Use-case titles that differ only by a number or a letter ("Use case 1" / "Use case 2", "Agent – Phase 1" / "Phase 2") | Different use cases: `sameUseCaseTitle` matches numbers and other distinguishing tokens (every caller: the live check before create_use_case, the push's look before a create, the Use_Case__c lane's matching) | OK (tests/vdp/gaps.test.ts › VD-34) |
| VD-35 | The identity judgment and the VDP view compute a unit from different inputs (found live: the view had an ambiguous company the job thought judged) | The job takes its pending units from the view's own computation (`vdpIdentityPending`), so every judgment it stores is one the view applies | OK (`VD-35 …`, tests/db/vdp/roundtrip-db.test.ts) |
| VD-36 | A strong asset candidate links to a site the user does not trust (a crafted Slack post or doc carrying `https://anything/deck.pdf`), or an http link, a `user@host` link, a port or an IP address | Autopilot never adds it: it is an ordinary item that waits for your Apply, "Held for you: link is on <host>, not a trusted site"; trusted = https on a host in Settings ▸ Sending's list or a subdomain of one (D-60 amended, SEC-6); the Outbox re-checks before the write | OK (tests/vdp/asset-hosts.test.ts; tests/vdp/autopilot.test.ts › SEC-6) |

## Use cases in both VDP and Org62 (lane: the Use_Case__c session, D-67)
| ID | Scenario | Expected | Status |
|---|---|---|---|
| UC-01 | Match by VDP use-case id, else opp + normalized title | The link (VDP use case id ↔ Use_Case__c id) first, across renames; else any opp of the VDP + `ucSameTitle` (VDP's `sameUseCaseTitle`, and the same numbers: "Phase 1" is never "Phase 2") | OK (tests/time/use-cases.test.ts "UC-01 …") |
| UC-02 | VDP use case missing in Org62 → a canvas row | A USE CASES row (OwnerId me) on the next logging canvas, on the VDP's first open opp with my 100% DC; nothing before the first read | OK ("UC-02 …", tests/db/vdp/use-cases-db.test.ts) |
| UC-03 | `Use_Case__c` missing in VDP → a `create_use_case` item | A child under Use cases in the VDP tree (title and track from Org62, you type the rest, never autopilot); before a VDP lists the opp it waits on Time ▸ Log it ▸ Use cases in Org62; Leave it closes it | OK ("UC-03 …", tests/time/use-cases-mock.test.ts, db) |
| UC-04 | Drift (Stage, Go-Live, title) → both values shown, never auto-overwritten | Against the last agreed value: only VDP changed → Org62 follows on the canvas (Stage / Go-Live, records the app created that I own) or "change it in Org62"; only Org62 changed or VDP empty → an `update_use_case` item; both changed → you choose. Use_Case__c has no priority field (describe 2026-11-12), so priority can't drift | OK ("UC-04 …") |
| UC-05 | Deleted or inactive on one side | Deleted in Org62: Add it again / Leave it (decisions, Undo); deleted in VDP: Org62-only again (re-add to VDP or Leave it); archived or no-longer-mine VDP: quiet; U07 Lost: VDP is asked to go On Hold | OK ("UC-05 …", db "Add it again …") |
| UC-06 | Primary opp or VDP change → `Opportunity__c` | Opportunity__c / Account__c drift shown with "change it in Org62" (the app writes only Stage / Go-Live); a new row takes the opp's account (keyed by opp) | OK ("UC-06 …") |
| UC-07 | Duplicate `Use_Case__c` | The oldest of mine is the use case; the other is flagged "Duplicate in Org62: delete the extra one there" (never deleted, never linked) | OK ("UC-07 …") |
| UC-08 | Evidence of a new use case → check both systems (past and hidden VDPs included) before proposing | Every `create_use_case` (the tree's "Add a use case", an Org62 → VDP item, the Assistant, a push) is refused with 409 when a VDP of the company (past and gone included), the account's Use_Case__c or a staged VDP create / canvas row has it; hidden VDPs (`get_company` vdp_count) are said, not refused, once the mirror reads the count (VD-07) | OK ("UC-08 …", mock, db) |
| UC-09 | VDP made before my 100% DC; 50% / team-only / closed opps | "Waiting for your 100% DC on <opp>: Claim DC"; nothing is created or read until the DC reads 100% (D-63) | OK ("audit 8 / D-63 …", db "D-63: …") |
| UC-10 | Canvas applied partially; re-push | The next read links what landed; only the missing rows are offered again two days on (Slackbot's duplicate rule skips any that did land) | OK ("ordering: …") |

## Attribution, learned rules and DC suggestions (lane: p2-attribution-engine)
| ID | Scenario | Expected | Status |
|---|---|---|---|
| AT-01 | Nothing learned yet | Every meeting, channel and Time row gets the same account / opp the old mappers gave (sample-data parity: 138/138 events, every channel, 132/132 rows) | OK (tests/attribution/parity.test.ts) |
| AT-02 | A title names an account with several open opps | The account ranks first and the row asks (the rundown), never a guessed opp; an opp whose own words the text has takes the account's evidence | OK (tests/attribution/engine.test.ts "a meeting naming an account with three open opps…", "a distinctive word…") |
| AT-03 | A domain two accounts claim | Says nothing (no candidate from it) | OK (engine.test.ts "a domain two accounts claim…") |
| AT-04 | You correct a row's opp | A rule for its series / channel / domain / contact / word is written in the same change set (Undo reverts it); the next meeting of that kind is projected onto your opp | OK (tests/db/attribution/attribution-db.test.ts "a correction changes the next guess…", mock.test.ts) |
| AT-05 | Conflicting corrections | The rule decays (misses), then is replaced once misses reach hits; a channel or domain rule that sees a second opp of the same account generalizes to the account | OK (engine.test.ts "accept strengthens…", "generalizes…") |
| AT-06 | A rule you turned off or removed | Never read; Remove is undoable | OK (engine.test.ts "a disabled rule…", attribution-db.test.ts "rules: turn one off…") |
| AT-07 | A Slack burst spanning two accounts | Engagement credits both accounts' opps at their scores, neither in full; hours stay on the logged opp only | OK (tests/attribution/dc.test.ts) |
| AT-08 | Internal-only meetings | Credit no engagement, so never a DC | OK (dc.test.ts) |
| AT-09 | A covered AE's opp I never touched | *Amended 2026-11-23, D-103 (a):* kind `ae` (owner, opp team member or Specialist Forecast owner, inside the row's window) is suggested, unticked, "<AE>'s deal (AE you cover)"; kind `ooo` or `sme` is suggested only with my work on it, its split defaulting to the row's share ("covering for <TA> (OOO) · 50%", "assisting on <account>'s deal (SME) · 25%"). Before D-103: never suggested | OK (dc.test.ts "coverage as data…", mock.test.ts "coverage rows at scale 1…") |
| AT-10 | Reassigned opp (account or AE changed), or a coverage window ended | Regrouped under its new account; one suggested only for its coverage goes stale (kept); an accepted DC is never changed by a coverage change (J-8, D-103) | OK (dc.test.ts) |
| AT-11 | Closed-lost (or won) opp with a waiting suggestion | Stops being suggested; the row is kept as closed (history) | OK (dc.test.ts) |
| AT-12 | Several opps of one engagement | One group, evidence shares adding to 100; split 100% by default (or the share with dcSplit = evidence); another architect's DC = a split question, unticked | OK (dc.test.ts) |
| AT-13 | Rejected DC suggestion, a DC gap set aside (Not needed), a dismissed missed-opp finding (amended 2026-11-23, D-103 (d)) | One rule for all three (`src/engines/attribution/resurface.ts`): hidden until 2 h more are logged on the opp, I join its team, or a call on its account after the dismissal (a customer meeting on my calendar, or an Event read from Org62; Slack and mail never count). It comes back once, saying why ("You met Acme on Nov 24, after you set this aside"); dismissing it again hides it past that call. A dismissal stored before D-103 has no last call: only a call after its decision time counts | OK (dc.test.ts "one dismissal memory…", tests/deals/needs.test.ts "D-103 (d)…") |
| AT-14 | Accept a DC suggestion | A DC request (approved) rides the next logging canvas; nothing is sent; Undo restores the suggestion and removes the request | OK (attribution-db.test.ts, mock.test.ts) |
| AT-15 | A new deal the mirror lacks | org62.discover (fixed SELECTs, one-call read path) adds it with provenance (ext.via), its account out of my book, the covered AE's team row; it is a candidate the same day; ≤ 20 lookups a day, cadence from Settings | OK (attribution-db.test.ts "discovery…"; manual live check on the work machine) |
| AT-16 | A use case whose opp is not settled | The opps it can go on are ordered by the engine (its words, my engagement), the best first; never applied for you | OK (tests/attribution/prefill.test.ts) |
| AT-17 | Review with zero ticked rows (everything unticked, or only rows the app can't settle) | "Log these" is off and says why ("Tick at least one row to log. Nothing is logged until you do."); `a` does nothing; an unsure row can't be ticked until its opp is picked (the likely opps are inline). An empty pick never reaches the server, where no list means every ready row | OK (tests/time/review.test.ts "zero ticked…", src/components/time/__tests__/review.dom.test.ts "checkbox rows by day…") |
| AT-18 | A row's opp changes elsewhere (another tab, the Assistant, a re-projection) between opening Review and pressing Log these | Log these re-reads the ticked rows first: the changed one (or one dismissed, logged another way, already in a batch, or gone) is unticked and named ("1 row changed since you opened this page: … now goes to …"), nothing is staged, and the next press logs what is ticked then. A pick made on the page is mine, not a change (rule 3: never override what changed under you) | OK (review.test.ts "re-check…", review.dom.test.ts "an opp that changed…") |
| AT-19 | Undo on a History row after the batch was applied, or once the row is in Org62 | Undo opens why it can't be taken back (Slackbot may already have written it; the app never deletes or rewrites what is in Org62) and the correction instead: change it in Org62 and the app follows; a row Org62 lacks comes back under Needs you (Log again / Leave out). While the batch still waits for Apply, Undo takes the row out of it (undoable, nothing sent). A row read from Org62 has no Undo | OK (tests/time/history.test.ts, src/components/time/__tests__/log-view.test.ts "a past quarter…") |
| AT-20 | To log's Week toggle on a week with no rows | "Nothing found for this week" says what fills it (a meeting after it ends, Claude sessions, Drive edits, Slack bursts) and that nothing waits on me there; the List is one click back; the picker still steps weeks | OK (src/components/time/__tests__/to-log-view.test.ts "the Week toggle on a week with no rows…") |
| AT-21 | An old Activity link (`?view=needs`, `weeks`, `week`, `usecases`, `ledger`, `forecast` for an SE, any unknown view, an old `?week=`) | Lands on the nearest of To log · History · VDP with its anchor, the URL replaced; panel and History filters kept (docs/UX.md "Activity: old links") | OK (tests/time/views.test.ts, to-log-view.test.ts "old links land…") |

## Use cases to add (lane: p2-use-case-candidates)
Rule 10 applied: the app captures candidates, dedupes them against both systems, and adds to VDP and Org62 in one click (src/engines/use-cases, `use_case_candidates`, 0034). Tests: `tests/use-cases/engine.test.ts` (sample-data notes and the CAST storylines), `mock.test.ts`, `job.test.ts`, `use-cases-db.test.ts` (Postgres).
| ID | Scenario | Expected | Status |
|---|---|---|---|
| UC-11 | An internal-only meeting (SE team sync, a 1:1) says "we want to build …" | Never a candidate: a source needs a customer counterpart (an external participant, a mapped or shared channel) | OK (engine.test.ts "precision…", db "extract…") |
| UC-12 | Notes name a use case ("wants a working demo of order status", "agreed to prove claim status first", "the POC scope for the fraud agent") | A candidate with the problem, products (dcProducts + VDP's vocabulary), outcome, stage hint and the sentence as evidence, on the opp attribute() chose (the meeting's own opp first), with why | OK (engine.test.ts "recall…", db "extract…") |
| UC-13 | An unsure statement ("asked for follow-up question support") | One tool-less Haiku call per source through `complete()`, under one governor hold (ask at the hold, none on a day with no room), booked with its cassette hash; a "no" or a malformed answer drops it | OK (job.test.ts, db "extract…") |
| UC-14 | The same use case mentioned again, or already in VDP / Org62 / the app | Same opp (or same account when unsettled) and the same use case by VDP's title rule, the problem key or pg_trgm similarity ≥ 0.5 (numbers kept apart): its evidence is added to that row, never a second candidate; an existing one gets a landed evidence ledger | OK (engine.test.ts "dedupe…", db "pg_trgm agrees…") |
| UC-15 | The opp is unclear (an account with several open opps) | The candidate carries the rundown's top 3 to pick from; Accept waits for a pick; the pick (or Edit with an opp) is a correction the attribution engine learns | OK (engine.test.ts "unsure…", mock.test.ts "Accept on an unsure one…") |
| UC-16 | Accept | One change set: the VDP `create_use_case` Outbox item (D-49 path and its duplicate check) and the Org62 USE CASES row (`CC-UC#cand-<id>`) on the next logging canvas; dry run as set; nothing sent. No VDP for the account: Org62 only (staged_org62); the opp not in Org62: VDP only (staged_vdp). H-9: no 100% DC needed | OK (mock.test.ts "Accept drafts BOTH…", db "accept drafts BOTH…") |
| UC-17 | Undo an Accept, an Edit or a Reject | The candidate is back as it was, the VDP item is gone, learned rules are reverted | OK (mock.test.ts, db "accept…", "reject…") |
| UC-18 | Reject | Says why (not a use case, wrong opp, duplicate, already in Org62) and never comes back; wrong opp alone decays the rules that chose it; wrong opp with the right one moves it there (a correction: mapping_rules + attribution_outcomes) | OK (engine.test.ts "reject…", db "reject…") |
| UC-19 | VDP reads the new use case before Org62 reads the record | The round trip's own VDP → Org62 create for it is left out (the candidate's row is the one); a waiting canvas holds the candidate's row, a sent one hands it off | OK (engine.test.ts "the canvas row…") |
| UC-20 | The reads find it | Org62's record and VDP's use case (same opp / VDP, same title) set their ids; both found (or the one staged): landed. An accepted use case's canvas question carries the `suggested` marker and its opp as the pick_opp pre-fill | OK (engine.test.ts "the landing…", "suggested marker…", db "landing…") |

## The Needs-you queue (lane: p3-needs-queue)
One server-built queue (`GET /needs`, `src/engines/needs`, D-86): one row per fact, composed from the existing reads, decided through the routes the pages already call. Tests: `tests/needs/compose.test.ts`, `providers.test.ts`, `queue-mock.test.ts`, `tests/db/datasource/needs-parity.test.ts` (Postgres).
| ID | Scenario | Expected | Status |
|---|---|---|---|
| NQ-01 | You decide a row (Accept, Not mine, Confirm done, Reject, Claim, Later) | It leaves the queue and every count at once (optimistic), through `POST /needs/:id/decide`, which runs the page's own route with its payload; the toast's Undo reverts that route's change set and the row is back | OK (queue-mock.test.ts "runs the row's route…", "Later…"; needs-parity "a decide…") |
| NQ-02 | A read or a provider fails (a source is down, a payload the provider did not expect) | That kind shows no rows and is named in `partial`; one `BUG.NEEDS_PROVIDER` log line (ids and codes only); the rest of the queue and the page render | OK (compose.test.ts "a provider that throws…", queue-mock.test.ts "a read that fails…") |
| NQ-03 | A row whose verb the persona disables (an AE has no DCs, no VDP) | Never shown: a kind the persona lacks has no provider run, a verb that needs a missing feature is dropped, and a row left without its primary verb is dropped | OK (compose.test.ts "the persona gate…", providers.test.ts "a persona that does not claim DCs…") |
| NQ-04 | Closed rows (Closed for you, a sent or scheduled draft, a decided DC suggestion, a done reopened item) | Never in the queue, so never counted | OK (compose.test.ts "counts never include closed rows") |
| NQ-05 | The same thing from two providers (a guess and its draft; a missed opp and its DC suggestion) | One row, the more urgent one, with the other's verbs after its own (`also` names the other kind); the count counts it once | OK (compose.test.ts "the same work item…") |
| NQ-06 | The sidebar, Home and Activity say how much needs you | One number: the queue's `total` (`needsCount`); Activity's slice is part of it | OK (queue-mock.test.ts "the sidebar count is the queue's total") |
| NQ-07 | Nothing may leave from the queue | No verb sends or applies: approving a draft is Review (the Outbox's preview, confirm and undo window), a VDP push and a canvas Apply stay on Activity; the decide route is deny for the Assistant | OK (queue-mock.test.ts "the routes", providers.test.ts "outbox_draft") |

## The bundled database and the 1.x move (lane: p4-bundled-postgres, D-98)
Command Center's own Postgres 17 under the state folder ([D-98](decisions/0098-bundled-postgres.md)). Tests: `tests/ops/ensure-db.test.ts`, `migrate-cluster.test.ts`, `doctor-db-cluster.test.ts`, `pg-url.test.ts`, `pg-cluster.test.ts`, and the real servers in `pg-cluster.e2e.test.ts` (Homebrew always; the whole move with `CC_PG_E2E=1`).
| ID | Scenario | Expected | Status |
|---|---|---|---|
| PG-01 | Fresh Mac, no `DATABASE_URL` anywhere | The installer copies the engine, initdbs once, starts `com.commandcenter.db`, creates `command_center`, writes the socket URL; no Homebrew step | OK (`a fresh Mac (no DATABASE_URL anywhere)…`; e2e) |
| PG-02 | 1.x install, data in Homebrew | `update` / the installer moves it after the backup: precheck → dump → restore → verify → migrator `match` → switch; the Homebrew copy untouched | OK (`moves it: dump → restore …`, e2e: 128 tables, 16,677 rows; `after the backup and before the new build migrates`) |
| PG-03 | Migration refused: the source holds rows a restore would reject (overlaps an exclusion constraint forbids, orphaned FKs) | Stops at the precheck with the constraint and the count; nothing dumped, nothing switched, the env file still on Homebrew; asks for a report | OK (`a source a restore would refuse is refused` on the sample database: activity_entries_no_overlap_excl ×14; `a precheck hit stops before anything is dumped`) |
| PG-04 | The copy does not match (a table, a sequence, the migrations), or the migrator does not say `match` | Stops at verify; the restored copy is dropped; nothing switched | OK (`a table differs`, `a sequence differs`, `the migrations differ`, `one changed row does not`) |
| PG-05 | Any step of the move fails (no 17 client tools, cluster won't start, dump, restore, env file write) | Nothing switched; the update puts the previous build back and restarts it; the next update tries again | OK (`moveToBundled` failure table; `a failed move undoes like a failed migration`) |
| PG-06 | Homebrew Postgres stopped during the move | Stops with `brew services start postgresql@17` (the data is there); nothing switches | OK (`1.x with Homebrew stopped`) |
| PG-07 | 1.x default URL but no Homebrew Postgres, or no database in it | Nothing to move: the bundled one takes over | OK (`nothing to move, the bundled one takes over`) |
| PG-08 | User-set `DATABASE_URL` (environment, or another value in the env file) | Left alone by install, update and move; doctor `db-url` reports it (DEP.DB.URL_OVERRIDDEN) | OK (`a DATABASE_URL you set …` in ensure-db and doctor tests) |
| PG-09 | Keep Homebrew on purpose | `CC_DB_ENGINE=homebrew` in the env file, or `npm run update -- --keep-homebrew` | OK (`CC_DB_ENGINE=homebrew keeps Homebrew`; `--keep-homebrew` in update.test) |
| PG-10 | Cluster down | Web and worker wait for its socket; doctor `postgres` fails DEP.DB.DOWN with `launchctl kickstart -k gui/$UID/com.commandcenter.db` (the DB-down page and Health ▸ Setup show it); a socket ENOENT reads as DEP.DB.DOWN, never raw | OK (`set up but down`, `the bundled cluster's socket is gone`) |
| PG-11 | Not set up yet | DEP.DB.NOT_SET_UP → `npm run ops:install` | OK (`not set up yet`) |
| PG-12 | Major mismatch (data folder from 16, an 18 engine, a server answering 18) | Nothing starts; doctor `db-major` DEP.DB.MAJOR_MISMATCH → rollback and report | OK (`a major mismatch`; `realPrepare` refuses) |
| PG-13 | Data folder owned by another user, or mode looser than 700 | Doctor `db-cluster` DEP.DB.CLUSTER_PERMS with the chown / chmod | OK (`the data folder owned by someone else …`) |
| PG-14 | A second cluster on the same data folder | pg-cluster's lock refuses a second lifecycle step; Postgres refuses a second postmaster; `start` on a running one leaves it as it is | OK (`one holder at a time`; e2e `a second postmaster on the same folder is refused`) |
| PG-15 | Socket path over macOS's 103 bytes (a very long user name) | initdb is refused with DEP.DB.SOCKET_TOO_LONG's fix: `CC_PG_SOCKET_DIR` | OK (`fits the 103-byte macOS limit …`) |
| PG-16 | "Application Support" has a space | The socket URL is percent-encoded; node-postgres, libpq (psql, pg_dump, pg_restore) and run-service read it | OK (`the socket URL parses back`; e2e socket folder with a space) |
| PG-17 | 14 days after the move, Homebrew's copy still there | Doctor `db-homebrew` warns DEP.DB.HOMEBREW_LEFTOVER with `dropdb` + `brew services stop`; before that it says until when | OK (`the Homebrew copy: kept 14 days in silence …`) |
| PG-18 | 1.x source checkout | The first `npm run update` brings 2.0 (still Homebrew), the second moves; doctor says DEP.DB.MOVE_PENDING in between | OK (`a 1.x install still on Homebrew is told …`) |
| PG-19 | Backup / restore on the bundled cluster | Base backup (`.base.tgz`), 7 daily + 4 weekly; restore starts a copy to look at, `--replace` swaps the data folder (the old kept) | OK (e2e `a base backup … restores into a copy that starts`; retention tests) |

## Data model 2.0: the kv side-car → columns (lane: p4-sidecar-to-columns, D-99)
Migration 0036 and the `kv.backfill` job ([DATA-MIGRATIONS.md](DATA-MIGRATIONS.md)). Tests: `tests/db/data/sidecar-db.test.ts` (Postgres), `tests/data/sidecar.test.ts` (pure).
| ID | Scenario | Expected | Status |
|---|---|---|---|
| DM-01 | A database from before 0036: an opp's next step and products only in `cc.ext/opportunities/<id>` | Reads the same as from the column (the kv is the fallback, counted); Doctor `data:kv-fallback` warns with the count; the backfill copies it; a second run copies nothing; the kv is kept (rollback) | OK ("dual read: a legacy kv-only opp…") |
| DM-02 | The backfill is stopped mid-way (worker restart, a laptop asleep) | The cursor (family, last row) is in `data_backfills`; the next run continues there and finishes; counts add up | OK ("resumable…") |
| DM-03 | Snooze or Not needed on a Needs-you row | One `need_decisions` row in the change set, no kv key; Undo removes it; a decision still in the kv reads until the backfill copies it; Back on the list deletes both | OK ("need decisions…", "a legacy kv decision…") |
| DM-04 | A canvas row edit before Apply | `canvas_row_overrides` rows; the old `canvas.row_overrides` map reads as the fallback and goes on the next write | OK ("canvas row overrides…") |
| DM-05 | An 18-character opp id in Org62, the 15-character form on a DC's row, a VDP or a link | Matched through the `*_id15` columns (SQL) or `sameOrg62Id` (TypeScript): the opp is engaged, the covered AE matches | OK ("Org62 ids…", sidecar.test.ts "Org62 ids…") |
| DM-06 | A VDP read | Use cases, assets and people are rows (`mirrored_at`), the read is one `mirror_reads` row, the snapshot reads back the same; a use case's phase change appends stage history; a row mirrored before 0036 reads its blob until the backfill writes its children | OK ("VDP child tables…") |
| DM-07 | A Slack reply or Gmail reply the user Applied (live) | A `record_landings` row (kind `message`, destination slack / gmail) and one `landing_writes` row per attempt, in the delivery change set: ids, target, mode, never the text, subject or an address. A dry run records none. A delivery from before 0036 gets one from the backfill (origin `backfill`) | OK ("an Applied Slack draft and Gmail send…", "a delivery from before 0036…") |
| DM-08 | Rolling back to a build before 0036 after a good update | Restore the pre-migrate backup (the old worker refuses a newer journal); the kv was never deleted. `CC_KV_DUAL_WRITE=1` keeps the kv a full copy during a trial | UNTESTED (manual: docs/DATA-MIGRATIONS.md "Rollback") |

## The folder migration: Control Center 1.x -> Command Center (lane: p4-rename-command-center, D-101)
The 1.x state folder, its LaunchAgents, its logs and its database move to the new names once. Tests: `tests/ops/migrate-state.test.ts` (temp HOME, fakes for launchctl and plutil), `tests/db/ops/rename-db.test.ts` (a throwaway database), `tests/ops/rename-grep.test.ts`.

| ID | Scenario | Expected | Status |
|---|---|---|---|
| MG-01 | 1.x install, bundled database, three agents running | Agents stopped (web, worker, db), folder renamed, env file socket path and cluster config rewritten, new plists, database renamed, agents started again, 1.x plists gone, marker complete | OK (`a 1.x bundled install`) |
| MG-02 | 1.x install on Homebrew (TCP URL) | Same move; the URL keeps host and port, only the database name changes; no database agent | OK (`a 1.x Homebrew (TCP) install`) |
| MG-03 | `DATABASE_URL` you set (another host, user, database) | Left alone, its database never renamed, one note | OK (`a custom DATABASE_URL`) |
| MG-04 | Both folders exist | The new one is used, one line says so; the 1.x one is untouched, nothing merged or deleted | OK (`both folders`) |
| MG-05 | Only the new folder, or neither | Nothing happens | OK (`only the new folder`) |
| MG-06 | The run dies after the folder rename (power cut, closed lid) | Marker is open and says what was running; the next start of any entry point finishes: plists, database, agents, cleanup | OK (`a failure right after the folder rename`; `an interrupted run`) |
| MG-07 | The database cannot be renamed now (server down, sessions, both names exist) | Old name and URL kept, one plain line, the app starts; setup/install/update/doctor retry, a service start does not | OK (`a database rename that fails`, `both database names`) |
| MG-08 | An old agent will not stop, or its database server keeps running | Nothing moved; the stopped agents start again; a line says what to run | OK (`will not stop`, `still running`) |
| MG-09 | The folder rename itself fails (another volume, permissions) | Nothing moved, old agents started again | OK (`a folder rename that fails`) |
| MG-10 | Two entry points start at once (web and worker agents, `npm run dev`) | A lock file (pid) lets one migrate; the other stops (an agent waits up to 3 minutes for it) | OK (`holding the lock`) |
| MG-11 | An old agent restarts on the new code (the 1.x updater's last step) | `run-service.mjs` sees the 1.x folder, hands the move to a detached process and ends; the move starts the new services | manual: see the chunk's `manual_checks` |
| MG-12 | Backups and restore | `control_center-<stamp>.dump|.base.tgz` are listed next to the new names (ordered by timestamp); `restore` into any name works; a restored 1.x base backup is renamed by `ensureAppDatabase` | OK (`backups made under the old name`; `rename-db.test.ts`) |
| MG-13 | `CC_STATE_DIR` set (tests, a scratch install) | No migration: there is no 1.x folder to move | OK (`CC_STATE_DIR skips`) |
| MG-14 | The 1.x updater's restart loop spawns the move from the web agent before it bootstraps the worker (`wasLoaded` is only `web`) | `finish()` starts every kind whose new plist exists (web, worker, db), loaded before or not; an already loaded one is skipped; the old labels are booted out last. An orphan old-label service whose env file vanished with the old folder exits 0 with one line instead of looping | OK (`migrate-state-service.test.ts`, W34-1) |

## Release items in the Outbox (D-90, W12-7)
`npm run release -- --publish` makes the Drive upload hand-off and the Slack announcement two Outbox drafts the user Approves (docs/RELEASING.md "The Approve step"; `src/outbox/release.ts`, `scripts/release/{publish,outbox}.ts`). Tests: `tests/outbox/release-items.test.ts`, `release-relay.test.ts`, `release-rows.test.ts`, `release-items.db.test.ts` (Postgres), `tests/release/publish-outbox.test.ts`.
| ID | Scenario | Expected | Status |
|---|---|---|---|
| RL-01 | The app is not running at publish | The build, feed and `outbox-<v>.json` are written as before; the output says "not in the Outbox yet" and `npm run release:outbox -- dist/releases/outbox-<v>.json`, which creates the same two drafts once the app runs (and fails with "nothing staged" while it doesn't) | OK (publish-outbox.test.ts "app not running…") |
| RL-02 | A second publish of the same version | Pending items are rewritten in place (same ids, new version) or left alone when unchanged; an item already applied or handed off is kept; never a second pair. Another version is its own pair | OK (release-items.test.ts "…never duplicates", "Mark uploaded…"; release-items.db.test.ts; publish-outbox.test.ts) |
| RL-03 | The announcement fails (Slack refuses, the relay can't reach Slack) | The row is under Retry with the reason; Retry is a fresh preview and confirm, never a re-post of the spent one | OK (release-items.test.ts "a failed announcement comes back as Retry…") |
| RL-04 | No announcement channel (or Drive folder) set | The item is still staged; its row says what to set (`distributionAnnounceChannel` / `distributionDriveFolderId` in config/team.json, or the `distribution` settings key) once (no chip, title or change line repeats it) and its verb is off, as is the Details panel's Apply (its pill reads "Set up first"); a dispatch anyway is refused with "Not sent: no announcement channel is set (the announcement’s row in the Outbox says what to set)" (the upload alike), nothing recorded or called | OK (release-items.test.ts "channel unset…", release-rows.test.ts) |
| RL-05 | Undo inside the window on the announcement | Nothing is dispatched; the item stays pending | OK (release-items.test.ts "Undo inside the window…") |
| RL-06 | Mark uploaded | No tool call in any mode, no delivery job; status sent ("Handed off"), one `record_landings` row of kind `release` (destination `drive`, record = the version) and its write; a second mark refuses | OK (release-items.test.ts "Mark uploaded…", release-items.db.test.ts) |
| RL-07 | Dry run on (the default) | Approving the announcement renders the payload only; no post, no job | OK (release-items.test.ts "…dry run renders and calls nothing", release-items.db.test.ts) |
| RL-08 | The live announcement on the work machine | One post, only to the configured channel, through the worker's release relay | UNTESTED live (manual: dry run off, Approve the announcement in a test channel, check it in Slack) |

## Home as the briefing (lane: p3-home-briefing)
Home answers "what do I do now" with Today folded in as Home ▸ Plan (docs/UX.md "Home: the briefing, and Plan"; `src/engines/home/briefing.ts`, `src/components/home`). Tests: `tests/home/briefing.test.ts`, `tests/home/briefing-actions.test.ts`, `tests/ui/home-briefing.test.ts`, `tests/ui/home-plain-words.test.ts`.
| ID | Scenario | Expected | Status |
|---|---|---|---|
| HM-01 | An empty day: nothing ranked, no drafts, nothing in the queue | Do now says what the app is watching ("Watching Slack, Gmail and Calendar; anything new lands here"), or that no source is connected yet with where to connect one; never a blank card | OK (home-briefing.test.ts "HM-01…", briefing.test.ts "watchingOf…") |
| HM-02 | The day is overbooked and nothing can move (all of it pinned or due today) | The briefing line says "Overbooked by N min" and that nothing here can move, with what to do instead; no Move it button | OK (briefing.test.ts "HM-02…", home-briefing.test.ts "HM-02…") |
| HM-03 | Every draft failed to send | Respond shows each as "Reply to … · Retry" (opens its Outbox row, where Retry lives) and one line "All N drafts failed to send"; nothing is offered as Send | OK (briefing.test.ts "HM-03…", home-briefing.test.ts "Respond chips…") |
| HM-04 | Plan toggled after the working day is over | Home ▸ Plan is Today's own tree, so its meter counts the next working day (MIN-22) and says "The working day is over"; Home's own toggle still plans the next day | OK (same component as `/today`: home-briefing.test.ts "…mount the same Today tree") |
| HM-05 | A Top-3 item is closed for you while Home is open | Its card stays in its slot with "✓ Closed for you", the reason and Undo (the reopen Triage runs); it goes when you leave Home or the item comes back | OK (home-briefing.test.ts "HM-05…", briefing.test.ts "closedNowOf…") |
| HM-06 | Overbooked with something movable | "Move “X” to Monday to fit" names makeRoom's first row; Move it is the existing snooze to the next working day's start, audited; the toast's Undo puts it back in today's load | OK (briefing-actions.test.ts "moves the first makeRoom item…") |
| HM-07 | priority@2 is the shown ranking and an admin item is due today | It never takes a Do-now slot or a section row; it is in the one Admin row (promoted to "part of today" when due within 48 h); with priority@1.1 the row lists admin by the persona's rules | OK (briefing.test.ts "with priority@2 shown…", "priority@1.1 shown…") |

## Page-scoped reads (lane: p4-page-scoped-reads)
Every page loads the read model for one named scope (`src/server/datasource/db/reads/scope.ts`; the windows in `reads/rows.ts`): Home and Today the briefing (open work ± 14 days), every other page only what it renders. Measured in [15-page-reads.md](reviews/2026-11-20-holistic/15-page-reads.md). Tests: `tests/reads/scope.test.ts`, `tests/reads/scope-lint.test.ts`, `tests/db/reads/page-reads.test.ts`.
| ID | Scenario | Expected | Status |
|---|---|---|---|
| RD-1 | Open work made 60 days ago and never touched, due today; or a close made while the user was away for 70 days | In the briefing: status decides, not age (every non-terminal item is in, plus anything due, closed or changed since the window start), and the window starts at the earlier of now − 14 days and the last-active time, so "closed since you left" stays whole. A close 60 days old (user active today) is out | OK (page-reads.test.ts "RD-1 / RD-2…", scope.test.ts "briefing window (RD-1)") |
| RD-2 | A page opened for an id outside its window (a to-do closed 60 days ago, an item serving a meeting 3 weeks back) | One targeted read by id: `item:<id>` loads the item, its initiative's items and what it points at; the briefing adds the meetings its items serve by id. The window never widens | OK (page-reads.test.ts "RD-1 / RD-2…") |
| RD-3 | The first-scan backfill day (thousands of rows in one window) | Pagination, never a cap: Deals pages with the additive `cursor`/`limit` (no `limit` = every row, as before; the summary and needs always count every account); History pages by month and day, the Ledger by quarter (their existing keys), each loading only its window | OK (scope.test.ts "paging…", page-reads.db.test.ts "RD-3…") |
| RD-4 | A page reads a collection its scope left out (a new code path) | Tests (strict): a ScopeMissError fails the test. Runtime: rendered once more from every collection and logged `BUG.READ_SCOPE_MISS` (scope and collection only): slower, never broken. The web process also counts the misses per scope (ids-free) and the doctor's `data:read-scopes` row and Health ▸ Setup show the count since start (W34-4). `CC_READ_SCOPES=off` turns scoping off entirely (the 1.x reads) | OK (scope.test.ts "scope misses") |
| RD-5 | A decision, then an immediate re-read (Today, Home, Needs) | Shows it: there is no cross-request read-model cache; GET /needs shares one model only inside its own request, and writers load their own inside their transaction | OK (page-reads.test.ts "cache honesty…") |
| RD-6 | The Work list over a year of closed work (the open tab, a filter, a search, the Closed tab) | The `work` scope loads what the list can show: the open tab loads no closed item, and every tab's count is one SQL query over the same filters (exact: state, kind and their kv overrides as the loader maps them; the tab rule is generated from the view's). A text or source filter loads a SQL superset over every tab and the view filters and counts exactly. The Closed tab pages with the additive `cursor`/`limit` (in SQL, in the view's order; no `limit` = every row, as before); `total` is the tab's rows over every page. A failed window or count query reads every item (WL-3) | OK (work-list.test.ts, work-scope.test.ts, parity-reads.test.ts) |

## Corrections (W0-3)
| ID | Scenario | Expected | Status |
|---|---|---|---|
| CR-01 | You Undo a close for you (a reopen), then change your mind | "Why is this still open?" says "You reopened it" with Undo reopen (an undo of your own Undo, `POST /audit/:id/undo`, a redo); the item is closed again as the engine left it and it is no longer a correction, so the check may close it again | OK (tests/db/reeval/correction.spec.ts "Undo reopen…", tests/detail/why-open.test.ts, parity-reads getResolutionCheck) |

## Worker: crashes, sleep and outages (lane: post-crash-resume, ask #14)
A teammate's Mac sleeps, loses Wi-Fi, runs out of disk, or the worker is killed mid-scan: nothing is lost, duplicated or silently stuck, and Health says what happened in plain words. The rules, in the shape of the time rules above; the table below is them applied to cases. Report: [28-crash-resume.md](reviews/2026-11-20-holistic/28-crash-resume.md). Tests: `tests/db/worker/crash-resume.test.ts` (a real worker process killed with SIGKILL at each point, then a new worker on the same Postgres), `tests/scanner/runtime/crash-safety.test.ts`, `tests/worker/db-wait.test.ts`.

1. **A run that stops is closed, never left running.** The next worker start closes every run its predecessor left `running` (`cancelled`, "worker stopped before the run finished"); an error that escapes a run while the worker lives closes it `failed` at once. The window is read again from the cursor, which never moved for it. (W-3, `src/worker/recovery.ts`)
2. **The cursor moves only with what was written.** Coverage and the cursor commit in one transaction at the end of a run (S8, S9). A kill before or inside that transaction leaves the cursor where it was. A message a stopped run stored but nobody judged (no verdict, no evidence) counts as unread when the window is read again, on every path (fetch-then-interpret, linking deferred at the hard cap, LLM linking off).
3. **Reading a window again never duplicates.** Source items dedupe on their key, asks on their kind and origin messages (S4), links and verdicts are idempotent: the re-run ends in the same state as one run would have.
4. **Money spent is booked once.** At the next start, every paid model call of a stopped run whose `pass` row reached the database (within the trace sink's 500 ms) is booked on that run, one llm_calls row each; a second start finds none to book. The stopped run's and dead jobs' spend holds stop holding today's money at once (`abandoned`, with what they spent), not after the 6 h sweep. A model job that fails after spending keeps its booked calls, settles its hold with them, and is queued again after its backoff.
5. **What a committed run owes still happens.** Its work items' re-evaluations ride the scope's `handoff` (scan_cursors): a worker killed between the commit and the enqueue hands them back at the scope's next finish in the new process; an enqueue that failed in a live worker retries with the scope's next successful run. Jobs a dead worker held are put back at once (a dead pid on this Mac ends its leases at start; an Outbox delivery is resolved without sending again, B3), not after the 90 s lease.
6. **A full disk is a retry, never a crash or a stop.** A state-folder write that fails is skipped (first-scan progress, the cadence snapshot stay in memory). A scan whose write fails (ENOSPC, or Postgres's disk_full) fails `transient` with DEP.DISK.LOW and backs off; it is never counted as an unknown failure that stops the scope. One Health row, at most every 10 minutes.
7. **No database, no crash loop.** A worker that starts while Postgres is not answering waits (2 s, doubling, at most 1 min), its heartbeat `starting` with DEP.DB.DOWN (or DEP.DB.MISSING), and starts when it answers; one Health row then says how long it waited. A lost lock connection drains the worker and launchd starts it into that wait, instead of an unhandled error.
8. **Sleep is one catch-up, not every missed tick.** After a gap (3 h asleep) each scope plans one bounded catch-up over [cursor, now] (head first, then backfill in chunks; planning again adds nothing while those are pending), the timers fire once, and maintenance schedules run once per missed slot (`run_once`). A wake over 30 min also queues one reconcile.
9. **Health says it in the user's words.** "Inbox: a scan stopped when the app closed; it picks up where it left off." (one row per scope, closed as "…picked up where it left off." when the scope's next run succeeds); "A background job stopped when the app closed; it runs again now."; "The database was not answering when the background worker started; it waited 3 min and started once it answered. Nothing was lost."; "The disk is full: Command Center could not save first-scan state. Scans retry once there is room; nothing already saved is lost."

| ID | Scenario | Expected | Status |
|---|---|---|---|
| WK-01 | Killed after the run row is created, before the first page (a) | Next start: the run `cancelled` and the job re-queued at once; the window read again; 6 messages, 6 asks, cursor at now, no coverage hole; the open hold `abandoned`; Health row closed as "picked up" | OK (crash-resume.test.ts "(a) after the run row is created…") |
| WK-02 | Killed mid-page: messages written, the watermark not advanced (b) | As WK-01; the cursor never passed what was written; the page's messages, stored and unjudged, are interpreted on the re-read (no lost asks, none twice) | OK ("(b) mid-page…") |
| WK-03 | Killed after the watermark committed, before re-evaluations and the next page are queued (c) | The linked work item is still re-evaluated (the scope's handoff hands it back at the next finish); the rest of the window continues from the cursor | OK ("(c) after the watermark committed…") |
| WK-04 | Killed during classification, after a paid model call (d) | The paid call booked on the stopped run once (its `pass` row → one llm_calls row); the re-run books only its own calls; the hold released | OK ("(d) during classification…") |
| WK-05 | Killed inside the finish transaction (e) | Postgres rolls the transaction back: cursor and coverage unmoved; as WK-01 | OK ("(e) inside the finish step…") |
| WK-06 | Killed after the run finished, before its job row is marked done (e) | The job re-queued at once and read again: no duplicate items or asks; nothing else to put right | OK ("(e) after the run finished…") |
| WK-07 | A model job spends, then its call fails | Its call booked (the user sees the cost), the job `queued` again with backoff, its hold settled with what it spent | OK ("a model job that spent and then failed…") |
| WK-08 | A model job is running when the worker dies | Its lease ends at start, the reaper re-queues it, its hold `abandoned`, one "A background job stopped…" row | OK ("a model job the kill left running…") |
| WK-09 | An error escapes a run while the worker lives (Postgres drops while it books the run's spend) | The run closed `failed` at once, not `running` until the next start | OK (crash-safety.test.ts "an error that escapes the run…") |
| WK-10 | The re-evaluation enqueue fails after the run committed | The run stays `succeeded`; no failure counted; the ids go with the scope's next successful run | OK ("a re-evaluation enqueue that fails after the commit…"; WK-03) |
| WK-11 | Disk full on the state folder or the database | Runs fail `transient` with DEP.DISK.LOW and back off (never "stopped"); state writes skipped, not thrown; one Health row per 10 min | OK ("a full disk…" in crash-safety.test.ts and crash-resume.test.ts) |
| WK-12 | Postgres not answering when the worker starts | Waits with backoff, heartbeat `starting` + DEP.DB.DOWN / MISSING, SIGTERM answered during the wait; a Health row once it starts | OK (db-wait.test.ts) |
| WK-13 | The Mac sleeps 3 h | One bounded catch-up per scope tiling [cursor, now]; a second plan adds nothing | OK (crash-safety.test.ts "a clock jump…") |
| WK-14 | `npm run doctor` after a kill | Doctor's `postgres` and `heartbeat` checks name DEP.DB.DOWN / a dead worker; it does not list interrupted scans yet | GAP (doctor lives in `src/ops`; the check to add is in 28-crash-resume.md) |
| WK-15 | A scan runner killed mid-run (FTI or agentic) | FTI: each relay read and classifier call traces and flushes its `pass` row as it returns (`src/scanner/interpret/runner.ts`). Agentic: each SDK turn's usage is traced and flushed as a `turn` row before the next tool runs (`src/llm/skill-runner.turns.ts`); a query that ends books through its `pass` row, and recovery books the turns of a query that never reached it, once. Either way a call paid before the kill is booked once at the next start, and the run's open hold is settled with that amount (28-crash-resume.md, Remaining 4) | OK (crash-resume.test.ts "crash-resume drill on the real FTI runner" and "… on the real Agent SDK runner") |
| WK-16 | One database, two users' due jobs on the same queue (the sample and test databases) | Each user's worker claims only its own user's jobs (`claimJobs` filters on `owner_user_id`) and runs them as that user; the other's stay queued for their worker | OK (worker.spec.ts "claims only its own user's jobs…"; relay-holds.spec.ts's stranger jobs on the real queues) |
