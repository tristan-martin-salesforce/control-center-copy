---
name: nba-update-vdp
version: 2
verb: update_vdp
model: claude-sonnet-5-5
output: plan (vdp_patch), a dry-run patch for the VDP app; Org62 follow-ups as handoffs
primary: Review update
---

# NBA verb: update_vdp

This verb exists only while VDP is an active feature in the Persona block (an SE's duty; for other roles it is available, not preconfigured). Prepare an update to the deal's **Value Delivery Plan** (VDP) in the VDP app from what the evidence shows: notes, decks, Slack, and demo assets. The team process is **VDP first, then Org62**. The VDP generates the Deal Contribution notes and the use-case export (DC notes only matter when deal contributions are active too), and those flow to Org62 through Slackbot skills. You produce a reviewable patch. The outbox applies it after approval, or hands it off.

## When this verb fits

- He is engaged on an opportunity whose VDP is missing or incomplete (`verb_context.vdp.missingFields`), or new evidence adds a use case, a qualification fact, or an asset.
- A demo, deck or repo was built for the deal and isn't linked in the VDP assets yet.
- A deal closed or moved, and the DC notes need regenerating.

## What a VDP holds (field map)

| Section | Fields | Rules |
|---|---|---|
| `header` | Account Name, Company Website, Aligned AE(s), Aligned TA(s), fiscal period | The digest treats fiscal period, AE and at least one use case as de facto required. Pick the AE from people in the inputs, never a guess |
| `use_case` | Title, Priority (High/Medium/Low), Division, Persona, **Use Case Details** | Separate D360 and Agentforce lists. Details is one field with `CURRENT STATE:` and `DESIRED STATE:` sections of 3–6 sentences each. No placeholder titles ("Enter Use Case Name") |
| `qualification` | Business Win, Technical Win, Estimation Win, Post-Sale Success items (decision maker, KPIs/ROI, budget, timeline, tech stack, blockers, data volumes, …) | Fill **only** what the evidence states, and cite it. Unknown stays unknown. Don't write "TBD" into a field |
| `linkage` | Org62 Account ID, Opportunity ID | Only ids present in the inputs. They unlock the use-case export and DC notes |
| `assets` | Links to demos, decks, repos, architecture docs | Links only, never uploads. Every URL must appear in the inputs |
| `dc_notes` | Regenerate the Deal Contribution notes | A follow-up, not text you write |

## The plan (`plan.kind: "vdp_patch"`)

```json
{
  "kind": "vdp_patch",
  "vdp": { "id": "vdp_12", "url": "https://…", "accountName": "ACME" },
  "changes": [
    { "section": "use_case", "field": "D360: Unified member profile", "op": "add",
      "value": "Priority: High · Persona: Member services lead · CURRENT STATE: … DESIRED STATE: …", "evidenceIds": ["ev_31"] },
    { "section": "assets", "field": "Demo: unified profile", "op": "add", "value": "https://…", "evidenceIds": ["ev_33"] }
  ],
  "followUps": ["Regenerate DC notes in the VDP after saving", "Create the use cases in Org62 from the logging canvas (D-67: the SE owns them; the app queues them as rows on the next canvas you Apply)"]
}
```

- Each change cites the evidence ids it rests on. A change with no evidence doesn't belong in the patch.
- The `op` values:
  - `set` replaces a field;
  - `add` adds a use case, asset or AE;
  - `append` adds to a text field.

  Don't overwrite a non-empty field unless the evidence contradicts it, and then say so in `why`.
- CURRENT STATE / DESIRED STATE use the customer's words from the notes. Keep them concrete, and add no adjectives the customer didn't use.
- **followUps** are the next process steps, not things you've done:
  - regenerate the DC notes;
  - DC upload through the Slackbot skill, using the team's DC role and split from the team pack and with the VDP link in the comments;
  - share the use-case CSV with the AE.

## The card

- **title:** "Update VDP: ACME (add 1 use case, 2 assets)".
- **why:** e.g. "Engaged deal with no VDP use cases; discovery notes cover one".
- **effort:** `youMin` 10–20 to review; `agentMin` 0. Estimate hands-on minutes only, and err low; agent or background time goes in `agentMin`.
- **startBy:** before a deadline in the policy or evidence (an EOQ DC/VDP deadline), otherwise `null`.
- **asks:** for missing AE, fiscal period or linkage ids, and for unclear priority.

## Update rule specifics

- New notes may add a qualification fact or change a priority. Diff the affected `plan.changes` entries. If he has edited a value, keep his and propose the new one in `update.diff`.

## Safety specifics

- The VDP is internal, but it feeds Org62 and leadership dashboards, so treat accuracy as paramount. Qualification items are claims about the deal: cite or omit.
- Never invent KPIs, ROI, budgets or timelines. "Customer mentioned cost pressure" is not "ROI quantified".

## Worked example (placeholders)

Evidence:

- `[ev_31]` Gemini notes, ACME discovery: "Member services can't see claims and call history in one place; agents toggle 4 screens. Goal: one member view for service reps by Q2."
- `[ev_33]` Slack, his own message: "Demo for ACME: https://demo.example.com/acme-profile".

VDP: exists `[vdp_12]`, with no use cases, no assets, and linkage missing the opportunity.

Changes:

1. A `use_case` add: "D360: Unified member view for service reps". Priority High; Persona "Member services rep"; "CURRENT STATE: Service reps toggle four screens to see claims and call history … DESIRED STATE: One member view for service reps by Q2 …". Cites ev_31.
2. An `assets` add: the demo link. Cites ev_33.

followUps: regenerate DC notes; share the use-case CSV with the AE.

asks: `{question: "What's the ACME opportunity id for the VDP linkage?", to: "you", blocking: false}`.

confidence `likely`, because the use case's priority is inferred from "by Q2". Name that assumption in an ask, or lower confidence.
