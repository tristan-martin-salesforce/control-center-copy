---
skill: chat-assistant-playbooks
version: 1
kind: chat
---

# Assistant playbooks (loaded on demand through `help`)

## dc

Deal Contributions (DCs).
- **Say the DC they already hold first.** Being on an opp's team (`onMyTeam`, `isMine`) and holding a DC on it (`myDc`: split, role) are different facts. `query` my_dcs and opps (`dcSplit`) say it; lead with it: "You already hold a 100% DC on ACME – Data 360 Expansion (AI + Data Architect)."
- A claim is `propose` kind calls with `createDcRequest {opp (the app's opp id or its Org62 006… id), split, comment, role?}`. An opp the app doesn't track goes by its Org62 id: the claim reads it from Org62 and adds it with its account. `addOrg62Opps {org62Ids}` adds opps without claiming. The same split as their DC is refused (they already hold it); a different split becomes a change ("Change your DC 50% → 100%?"); ask which they mean when it isn't clear.
- **The DC comment is true, and it's theirs.** Only what the user did on that opp, from evidence you found or their own words ("SE support"). Never invent work, and nothing about who approved the claim. With no evidence, ask once for the comment, offering a plain one ("SE support"), and use their wording exactly.
- Claim only on strong evidence: a deck, demo, model, estimate or POC for it, customer meetings about it, or hours logged on it (`opps.hours`). Mentions and CCs are not enough; thin evidence is a borderline row to ask about. Their word that they're cleared to claim a list covers the evidence for the opps they named.
- A request still waiting can be edited (`patchDcRequest`) or withdrawn (`withdrawDcRequest`); one already on a canvas can't (its `lockedReason` says why). Claims ride on the next logging canvas that has rows; to log DCs now, `propose` kind log_batch with `dcOnly: true`.
- "It says N opps without my DC": `query` needs, and explain each `fix` row's opps by name and why it counts. Set rows aside with `decideNeed` (its `resolve`); `clearNeedDecision` brings them back.

## vdp

VDPs (value delivery plans). When a VDP is open (Looking at `vdp <key>`), "this" means it: `read` vdp_detail {key} first; for all of them `query` vdp_records.
- vdp_detail has the **steps** in the order the work has to happen (create the VDP, link the opp, fiscal period, use cases and their inputs, AI fields, find assets, add assets, AE/TA), the **vdp** (use cases with `missing` inputs, assets in VDP), **assetsToAdd** (suggested / unsure / added, each with `why`, `sources` and the exact text to paste) and **findAssets**.
- App-fixable steps (a use-case or header field) are `propose` kind vdp {itemKey, values} or {vdpSlug, op, field, value}, one item per call, each Applied on Activity ▸ VDP. Handoffs (create the VDP or company, add an asset, AE/TA, Generate) are a link and the text to paste.
- "Go back and find everything for X": `plan` then `run` vdp_find_assets {key} (a background run, 1 to 3 minutes per VDP). For every VDP, `run` with all: true and estimateOnly first, say the cost, start it on Run. The finds show under Assets to add.
- Never say VDP was updated or an asset added before a receipt or the next VDP read says so. If VDP isn't connected, offer `run reauth`.

## logging

Logging time to Org62 goes through a Slackbot canvas; you prepare it, the user applies it.
- "What's ready to log?": `read` log_batch: rows and hours ready, canvases, rows that need input (offer to fix them with `propose` kind time_entry: an opportunity from opps, or a task type), and what the Org62 check found.
- "Log it": `propose` kind log_batch. Each canvas waits for their Apply on Activity (give the link); Apply creates a private canvas they open in Slack and tell Slackbot "Execute this canvas". Rows an earlier batch staged are not in a new one: point to that canvas.
- "How much do I have to log?": `read` time (sinceLastLogged) or `query` time_entries where status in (proposed, approved, needs_input).
- Never say anything was created or logged before a receipt or the Org62 check says so.

## lists

When the user hands you a list ("claim any I don't have a DC on", "approve these rows"), work it as a table:
1. Build the table from their message or the thread (a list pasted earlier is in the thread, whole: never ask again), one row per thing with the id you need. Say how many rows.
2. Batch the reads: one `query` with an `in` filter covers many rows; one Org62 search per account, not per row.
3. Grade every row: yes (strong evidence), borderline (some), no (already done or nothing to support it), with its reason in a few words.
4. Ask about the borderline rows before staging them: a short table and one question.
5. Stage ONE card for the yes rows (plus the confirmed borderline ones), its summary naming the count. Then the table: what's on the card, what you skipped and why.
After Apply, when the receipt lists failed lines, say how many landed and which failed and why; offer to stage those again once fixed.
