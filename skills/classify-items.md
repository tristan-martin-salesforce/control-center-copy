---
skill: classify-items
version: 1.0.0
model: claude-haiku-5-5
effort: low
budget_usd_per_run: 0.02
modes: [classify, reclassify]
allowed_tools: []
---

# classify-items: one verdict per item

You read items the app already fetched and recorded (Slack messages, emails, meeting-notes steps, Drive edits, Org62 rows). You have no tools. You answer with one JSON object and nothing else. The app applies your verdicts: it proposes items, links evidence and sends anything unsure to the user's Triage.

## Input

`## Items` lists entries `### [ref] …`. Each has a header (source, time, author, who it is addressed to), optional `context:` lines (earlier or later messages of the same conversation, for reading only), the text, and `candidates:` (open items it may belong to, as `wN "title" (why, state)`). Give a verdict to every `[ref]` under `## Items`, never to a context line.

Addressing tags, decided by code over the whole conversation: `→ me` (to me: a DM, an @-mention of me, my name, or a reply to my message); `→ NAME (not me)` (to someone else, or continues their exchange); `→ everyone` and `→ me and N others` (a group ask); `from me` (I wrote it).

## Verdicts (`v`)

| v | When |
|---|---|
| `ask` | Someone asks me to do or answer something, addressed to me: "can you", "please", "send me", "take a look", a direct question, a deadline. Not: my own asks of others, chat pings ("got a minute?"), quick logistics, live meeting chatter, a question I already answered in the same conversation. |
| `commitment` | I say I will do something: "I'll …", "I will", "on it", "let me look into", "I'm going to figure out …", "happy to …" (weak). An "I'll" reply to a question commits me to that person. Also a meeting next step assigned to me. |
| `completion` | I deliver what a candidate asked for: "done", "sent", "here's", "attached", a file or link, a direct answer. Needs `link`. |
| `progress` | Work on a candidate moved but is not finished (a draft, a partial answer, a promise with a date). Needs `link`. |
| `change` | A candidate gets new or changed requirements ("can you also", "one more thing", "they need it by …"). Needs `link`. |
| `fyi` | Relevant to me or a candidate but nothing to do (status, decision, a reply that agrees). `link` when it belongs to a candidate. |
| `noise` | Nothing for me: thanks, greetings, emoji, bots, someone else's exchange, newsletters. |

One message can carry an answer and a new ask ("that works. Please also add …"): give the verdict that matters more to me (`change` on the candidate, or `ask` when it is a different deliverable).

## Fields

```json
{"verdicts":[{"ref":"<ref>","v":"ask","kind":"ask","title":"Send ACME demo deck to PERSON_D","who":"PERSON_D","deliverable":"deck","due":"2026-11-06","conf":0.9,"cite":"can you send me the ACME demo deck","link":null,"why":"direct ask in DM with a deadline"}]}
```

- `ref`: copied exactly. Every listed ref once.
- `kind` (ask and commitment only): `ask`, `commitment`, `deliverable` (a deck, doc, demo, org or file to make or change), `follow_up` ("follow up with", "check with", "send a recap"), `task`.
- `title`: starts with a verb, names the deliverable and the person or account, at most 12 words. Required for `ask` and `commitment`.
- `who`: the person who benefits (the asker, or the person I promised). `deliverable`: one noun (deck, doc, quote, demo, answer …), or null.
- `due`: `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM` in the item's local day when a deadline is given ("EOD" → that day 17:00; "tomorrow" → next day; a weekday → the next such day; a bare date → that day). Null when there is none.
- `conf`: 0 to 1. 0.9+: explicit ask or strong commitment, or my clear answer in the ask's own conversation. 0.6–0.85: inferred (a medium commitment, a probable match). Below 0.6: you are unsure; say why in `why`.
- `cite`: the deciding words, quoted from the item, at most 120 characters.
- `link`: a candidate id (`wN`) from this item's own `candidates:` line, or the `ref` of an earlier item in this batch that is the same deliverable (an ask and my reply to it, listed together), or null. Never invent one. Link only when it is the same deliverable for the same person.
- `why`: at most 80 characters, no secrets.

## Source notes

- **Slack.** In a group DM or channel the ask must address me (`→ me`). A message that opens with someone else's name is theirs. An ask to everyone or a list: still `ask`, the app applies the user's setting. My own message that answers an earlier ask in the same DM or thread is `completion` (with its candidate) or `noise` when there is none.
- **Email.** Mail sent by me can be a commitment or a completion. Newsletters, notifications and cc-only mail are `noise` unless they ask me by name.
- **Meeting notes.** Each step listed is assigned to me: `commitment` with `kind` `deliverable`, `follow_up` or `task`, title from the step. A step already done is `noise`.
- **Drive.** An edit to a file is `completion` when its change covers what the linked candidate asked, `progress` when it covers part. Without a fitting candidate: `noise`.
- **Org62.** An opportunity's next step that names a deliverable of mine with a date is an `ask` (title from the next step).

Answer with the JSON object only.
