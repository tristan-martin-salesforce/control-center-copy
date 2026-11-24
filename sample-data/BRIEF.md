# Sample-data brief (for generator agents; becomes the dataset README's backbone)

## Goal
A **synthetic but realistic** copy of the Command Center Postgres database, large enough that an LLM reading it can
learn (a) the shape of every table, (b) how tables join, and (c) the day-to-day scenarios the app handles. The owner
is a fictional Solutions Engineer at a fictional software vendor. **Nothing may come from real data.**

## Hard privacy rules (a reviewer will check every one)
1. No real customer, prospect, partner or competitor-of-the-owner company names. Use invented names, or the
   conventional placeholders (Acme, Globex, Initech, Umbrella, Hooli, Contoso, Fabrikam, Northwind, Wingtip, Tailspin).
   Do not use a name you believe is a real, well-known company.
2. No real people, colleagues, executives or public figures. Invent names. Never reuse a name of someone famous.
3. Emails: `@example.com`, `@example.org` or `@<invented>.example` only. URLs: `https://example.com/...` or
   `https://<invented>.example/...` only. Phone numbers: `555-01xx` only.
4. External ids carry the marker `SMPL`: Salesforce/Org62 ids via `sfId('006', n)`, Slack ids via `slackUser(n)`,
   `slackChannel(n)`, `slackDm(n)`. Gmail/Drive/Calendar external ids: invent opaque strings that include `smpl`.
5. No credentials or tokens of any shape (not even fake-looking `xoxb-...`/`ghp_...`). Connector `config` holds only
   non-secret placeholders.
6. Product vocabulary of the app (Slack, Gmail, Drive, Calendar, Org62, VDP, Data 360, Agentforce, Gemini notes) is fine.
   The owner's employer is never named; say "the vendor" or use generic team words.
7. Do not read the real database, `~/Library/Application Support/command-center/` (`control-center/` on a 1.x install), `docs/research/`, or any
   `private/` folder. You do not need them. Everything you need is listed below.

## What to read (all safe)
- `src/db/schema/*.ts` (Drizzle: columns, enums, `$type` unions, check constraints) and `src/db/migrations/*.sql`.
- Column dump: `<SCRATCH>/columns.txt` (`table|column|data_type|udt|nullable|default`), constraints `<SCRATCH>/constraints.txt`,
  enum values `<SCRATCH>/enums.txt`, FK summary `<SCRATCH>/fks.txt`.
- **Shape of JSON columns** (key paths and value types only): `<SCRATCH>/jsonb-shapes.txt`. Match these shapes.
- **Real-world distributions** of enum/status/boolean columns (aggregate counts only): `<SCRATCH>/distributions.txt`.
  Mirror the proportions (scaled down), including the awkward ones (lots of failed scan runs, mostly-warn app events).
- Docs: `docs/ARCHITECTURE.md`, `docs/TENETS.md`, `docs/UX.md`, `docs/DECISIONS.md`, `README.md`, `src/personas`,
  `skills/*.md` (the prompts the app uses: they show what a Slack scan, a triage or a brief looks like).
- Realistic *synthetic* examples already in the repo: `tests/fixtures/**`, `src/mock/seed.example.json`, `src/mock/*.ts`.
  Read these for tone and structure; do not copy their id values.
  (`<SCRATCH>` = `<build-notes folder>`)

## Mechanics
- Work in `<repo root>`. Import helpers from `sample-data/lib/kit.ts`
  (`uid`, `OWNER`, `at`, `day`, `NOW`, `rng`, `sfId`, `slackUser`, `writeTable`, `readTable`, …). Read that file first.
- Row ids: `uid('<table_name>', '<stable-slug-key>')`. This is how generators reference each other's rows **without
  coordination**: if a table you do not own needs a row of yours, reference it by the key from `sample-data/WORLD.md`.
  Never invent a key for another domain's table unless WORLD.md lists the key convention and range.
- "Now" = Wed 2026-11-18 09:00 MST. Data spans roughly 2026-10-19 → 2026-11-18, calendar events up to 2026-11-25.
  Use `at(offset, 'HH:MM')`. Working hours 07:30-17:30 MT, weekdays; a few evening/weekend bursts are realistic.
- Output: one generator per domain, `sample-data/generators/NN-<domain>.ts`, run with `npx tsx <file>`; it writes
  `sample-data/tables/<table>.json` (array of rows, DB column names, omit columns you want defaulted, jsonb as plain
  JSON values). Hand-written, content-rich rows (real-sounding Slack text, email bodies, notes) go in data modules
  next to the generator (`sample-data/generators/data/<domain>-*.ts`); bulk log-style rows use `rng('<seed>')` loops.
  Every row of a table must be JSON-valid for its column types (timestamps ISO strings, bigint ids as numbers, arrays as arrays).
- Own only your tables. Do not edit `kit.ts`, the scripts, other generators, or other domains' JSON. If you need a
  change to a shared file, say so in your final report instead.
- Verify as you go, using YOUR OWN scratch database (never the shared one; other agents run in parallel):
  ```
  createdb -T control_center_sample control_center_sample_<domain>      # once (template DB is already migrated)
  npm run -s sample:load -- --db control_center_sample_<domain>          # loads every table in sample-data/tables
  npm run -s sample:validate -- --db control_center_sample_<domain>      # every FK resolves? (orphans from tables not built yet are expected; yours must be zero)
  npm run -s sample:lint -- --lines                                      # privacy lint: must be clean
  ```
  When finished, `dropdb control_center_sample_<domain>`.
- Realism > volume, but be extensive. Targets are in WORLD.md ("volumes"). Real data is messy: include nulls where the
  real column is mostly null, failed/dead/retried rows, superseded rows, duplicates the dedupe logic would catch, items
  the user ignored, things overdue. A dataset of only happy paths is a failure.
- Cross-table consistency matters as much as per-table realism: a draft's `work_item_id` points at a work item about the
  same account; timestamps respect causality (created ≤ updated ≤ resolved); counters (`use_case_count`, `asset_count`)
  agree with child rows; `content_hash` columns are `sha()` of the content; `changed_fields` match before/after.
- Final report (≤ 250 words): tables written with row counts, keys other domains may reference (and where they are
  documented), anything skipped and why, any change you need from shared files, and a one-line privacy self-check.

## Cross-domain rules (see WORLD.md)
- Read `sample-data/WORLD.md` (domains, order, fixed id ranges, volumes, storylines) and, once it exists, `sample-data/CAST.md`.
- Earlier domains' tables: `readTable()` them. Fixed ranges in WORLD.md: `uid('scan_runs', n)` etc. need no lookup.
- A row of a LATER domain's table that you must point at: `ref('<table>', '<key>', 'why')` instead of `uid()`, then
  `flushRefs('<your-domain>')` at the end. Conversely, if you own table T, first `reservedFor('T')` and create each
  reserved row with exactly `uid('T', key)`, shaped by the note, before adding your own.
- All table names in `uid()` / `ref()` are the real plural DB names: `uid('accounts', 'brightwater')`, `uid('users', 'owner')`.

## Contract-valid rows (read models must load)
`tool_adapters.key` is the manifest id (`^[a-z0-9-]+$`, hyphens not underscores) and `version` is an integer string
(`"1"`, `"2"`: what the app writes via `String(manifest.version)`), never semver. Checks: `npx vitest run --project unit tests/data`
(every adapter row) and `CC_TEST_DB_SUFFIX=<x> npx vitest run --project db tests/db/data/sample-db` (loads the sample DB, builds a read model).
