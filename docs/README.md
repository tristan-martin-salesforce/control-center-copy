# Docs: start here

Four kinds of doc ([D-94](decisions/0094-docs-tiers-and-adrs.md)). **Living** docs change in the same commit as the
behaviour they describe. **Decisions** say why. **Reference** specs are stable detail. The **archive** is history
and is not maintained.

## Living
| Read | For |
|---|---|
| [../README.md](../README.md) | Install, run, personas, update, where your data lives |
| [INSTALL.md](INSTALL.md) | For teammates: installing and updating the compiled build through Claude Code, and the move from 1.x |
| [UPGRADING.md](UPGRADING.md) | 1.x to 2.0 end to end: the three starting points, what runs by itself, what does not (rescan, projections, attribution), verify, rollback, the agent's runbook, the open gaps |
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Where code goes (layers), the rules, tests (the vitest projects; `tests/<module>/`, Postgres tests in `tests/db/<module>/`), which docs to update |
| [../AGENTS.md](../AGENTS.md) | Building with Claude sessions: chunk briefs, `files:` globs, lane ports, the return format |
| [../CLAUDE.md](../CLAUDE.md) | Hard invariants and the command table |
| [TENETS.md](TENETS.md) | North stars and design tenets; cite them by name; a conflict is a blocker |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Processes, layers, connectors, engines, Outbox, security, distribution (as built and as decided) |
| [UX.md](UX.md) | What is on screen and how it behaves (live updates, the component kit, each page) |
| [EDGE-CASES.md](EDGE-CASES.md) | The ten time / DC / use-case rules, then the Org62 and VDP round-trip checklist |
| [ENGINES.md](ENGINES.md) · [engines/CHANGELOG.md](engines/CHANGELOG.md) | The ten rules every reasoning engine follows (facts as data, event-driven, why always, overrides remembered, estimate first, logged changes), how to add a rule, and the log of why each engine rule changed |
| [BACKLOG.md](BACKLOG.md) | Ideas and their phase |
| [RELEASING.md](RELEASING.md) | Semver, the release command, the update path |
| [FEEDBACK-INTAKE.md](FEEDBACK-INTAKE.md) | The weekly feedback intake: labels, triage rule, replies |
| [CONNECTORS.md](CONNECTORS.md) | How a source is read (manifest, runtime, parsers) and how to add one |
| [DATA-MIGRATIONS.md](DATA-MIGRATIONS.md) | How a data change ships safely: expand, backfill, dual read, verify, drop (D-96) |
| [../CHANGELOG.md](../CHANGELOG.md) | What shipped, per release |

## Decisions
| Read | For |
|---|---|
| [DECISIONS.md](DECISIONS.md) | One line per decision (101: D-1..D-75 archived, D-76..D-101 as files, plus D-60's own file since its 2026-11-21 amendment), with status and link |
| [decisions/](decisions/) | ADR-lite files, one per decision from D-76 on, and a row's file when it is next touched (D-60); at most 30 lines; supersede or amend, never rewrite |

## Reference
| Read | For |
|---|---|
| [reference/SCANNER.md](reference/SCANNER.md) | The scanner runtime, scopes, skills, completion |
| [reference/WORKER.md](reference/WORKER.md) | The worker: lifecycle, job queue, schedules, wake |
| [reference/OPS.md](reference/OPS.md) | Setup, doctor, backups and restore, LaunchAgents |
| [reference/CONTRACT.md](reference/CONTRACT.md) | The route table and contract-first API |
| [reference/ENGINES.md](reference/ENGINES.md) | The priority, closure and re-eval engines in detail |
| [reference/DATA-MODEL.md](reference/DATA-MODEL.md) | Tables, ownership, migration rules |
| [reference/DB-NOTES.md](reference/DB-NOTES.md) | How to use the data layer, and where the code differs from DATA-MODEL |

These were written during the build; where one disagrees with the code or a living doc, the code and the living doc win.

## Reviews and archive
| Read | For |
|---|---|
| [reviews/](reviews/) | Dated audits and reviews: [2026-11-13-app-audit.md](reviews/2026-11-13-app-audit.md), and the holistic review below |
| [archive/2026-build/](archive/2026-build/) | Build-era plans and specs (PLAN, BUILD-PLAN, BUILD-V2, UI-SPEC, REQUIREMENTS, …). Historical |
| [archive/decisions-2026-10..11.md](archive/decisions-2026-10..11.md) | The D-1..D-75 decision table, verbatim |
| [archive/ARCHITECTURE-2026-10-proposed.md](archive/ARCHITECTURE-2026-10-proposed.md) | The October architecture proposal |
| [design/](design/) | Design notes ([landings.md](design/landings.md)) |

### The holistic review (2026-11-20, `reviews/2026-11-20-holistic/`)
| Read | For |
|---|---|
| [README.md](reviews/2026-11-20-holistic/README.md) | The plan: findings, phases, the binding decisions (§8) |
| [00-brief.md](reviews/2026-11-20-holistic/00-brief.md) … [12-pglite-spike.md](reviews/2026-11-20-holistic/12-pglite-spike.md) | The brief and the eleven lane reports (UI, scanners, LLM cost, Assistant, time, priority, connectors, data model, engineering, packaging) and the PGlite spike |
| [BUILD-BRIEF.md](reviews/2026-11-20-holistic/BUILD-BRIEF.md) · [CHUNKS.md](reviews/2026-11-20-holistic/CHUNKS.md) | What every builder reads first; the chunk ledger |
| [13-wave0-review.md](reviews/2026-11-20-holistic/13-wave0-review.md) | Review of wave 0 (phase 0 fixes and the spike) |
| [14-wave12-review.md](reviews/2026-11-20-holistic/14-wave12-review.md) | Review of waves 1 and 2 (foundations, intelligence) |
| [15-page-reads.md](reviews/2026-11-20-holistic/15-page-reads.md) | Page-scoped reads, Home SQL and the Work list scope: before and after |
| [16-wave34-review.md](reviews/2026-11-20-holistic/16-wave34-review.md) | Review of waves 3 and 4 and the 2.0 release; the original asks audit |
| [STATUS-2.0.md](reviews/2026-11-20-holistic/STATUS-2.0.md) | The 2.0 build status and the work-machine checklist, with the post-2.0 addendum (same release) |
| [17-security-review.md](reviews/2026-11-20-holistic/17-security-review.md) | Security review before sharing 2.0 (SEC-1..15) |
| [18-ui-polish.md](reviews/2026-11-20-holistic/18-ui-polish.md) | The UI polish pass and its leftovers, page by page |
| [19-read-twins.md](reviews/2026-11-20-holistic/19-read-twins.md) | The last read twins (Today, Triage, Time week, Work lists): each difference and its rule |
| [20-onboarding-dry-run.md](reviews/2026-11-20-holistic/20-onboarding-dry-run.md) | The install followed as a teammate would, against the built tarball (salvaged: what was fixed, what is still owed) |
| [21-engine-fanout.md](reviews/2026-11-20-holistic/21-engine-fanout.md) | Engine barrels and test fan-out (ENG-5) |
| [22-max-lines.md](reviews/2026-11-20-holistic/22-max-lines.md) | Splitting the files over the length limit into `<name>.<part>` siblings; the long-file grandfather list emptied |
| [23-docs-coherence.md](reviews/2026-11-20-holistic/23-docs-coherence.md) | The living docs and the 2.0 CHANGELOG checked against the code after the post-release chunks |
| [24-visual-qa.md](reviews/2026-11-20-holistic/24-visual-qa.md) | Visual QA of the post-2.0 surfaces at 1440, light and dark |
| [25-post20-review.md](reviews/2026-11-20-holistic/25-post20-review.md) | Review of the post-2.0 wave (P25-1..11) |
| [26-caps-audit.md](reviews/2026-11-20-holistic/26-caps-audit.md) | Every fixed number that limits what the app does, classified; the arbitrary ones paged, counted or lifted |
| [27-read-profile.md](reviews/2026-11-20-holistic/27-read-profile.md) | Every page read profiled on the sample database; scopes, repeats, the 0039 index, the budget test |
| [28-crash-resume.md](reviews/2026-11-20-holistic/28-crash-resume.md) | The worker killed mid-scan: recovery, Health rows, the database wait, a full disk |
| [29-persona-qa.md](reviews/2026-11-20-holistic/29-persona-qa.md) | Every page as the Specialist AE, then the SE's persona branches |
| [30-a11y.md](reviews/2026-11-20-holistic/30-a11y.md) | Keyboard, screen reader and axe on every page in both themes; the baseline and `npm run test:a11y` |
| [31-eval-goldens.md](reviews/2026-11-20-holistic/31-eval-goldens.md) | Assistant goldens for the post-2.0 behaviours, both personas; the router faults they found and their fixes |
| [32-docs-coherence-2.md](reviews/2026-11-20-holistic/32-docs-coherence-2.md) | The second docs pass: living docs, CHANGELOG 2.0.0 and the STATUS-2.0 addendum after chunks 23–31 |
| [33-post20-review-2.md](reviews/2026-11-20-holistic/33-post20-review-2.md) | Review of the second half of the post-2.0 wave (P33-1..4) |
| [34-post20-review-3.md](reviews/2026-11-20-holistic/34-post20-review-3.md) | Review of the late merges (P34-1..4): the port rule, recovery booking, install errors |
| [35-post20-review-4.md](reviews/2026-11-20-holistic/35-post20-review-4.md) | The last delta review (P35-1..3): the axe scanner's timeouts, the install's instance check, the scan's checksum rule |

Reports marked "in progress" are linked once their lane lands.

`docs/research/` holds the evidence behind the early decisions. It is **private** (Org62 ids and customer names) and
is not part of shared copies of the repo.
