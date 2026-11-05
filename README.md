# @sigrun/knowledge

Curated per-user knowledge extension for [sigrun](https://github.com/sigrun-ai/sigrun).

This package owns one SQLite store per directory user
(`<user data dir>/knowledge.db`) holding typed knowledge entities, identity
keys, inquiries, and the version history that makes every change undoable.

## Tools

- **`knowledge_record`** (curation target tool, `replay: "safe"`,
  idempotent by call id): one call carries the whole update from a review —
  the inquiry (question, why, outcome), any new or extended types, and the
  entities with identity keys, cited fields (`{value, source, observedAt}`
  where `source` is a recall handle), and per-inquiry roles. Applied
  atomically; validation errors roll everything back and are reported as
  text with no `details.curation`. Success returns the one-line summary
  (`recorded Biscuit's knee: 3 vet clinics`) as the output text and
  `details.curation: { changeId, summary }` — the undo unit.

  The user is the conversation's acting user (the review fork's owner).
  The inquiry records the *reviewed parent* conversation, resolved by
  paging the fork's entries newest-first until an entry stamped with a
  different conversation id appears.

- **`knowledge_find`** (read tool, never a target tool): batched queries
  (≤ 10) by `type` (child types included), by `field` comparison
  (`eq`/`lt`/`gt`/`contains`; money compares amounts within one currency
  only), by `inquiry` question text, or by free `text`. Text search goes
  through the optional `recall.search` hook (keeping only knowledge's own
  hits) and falls back to a `LIKE` scan when recall is absent or fails.
  Entities with class `local-only` are never shown.

  The audience rule (spec delta 7) runs first: in a shared conversation
  the tool answers "Not available here." unless every reader may see the
  user's knowledge — the user's own records are private to their
  conversations.

## The curation target

The factory result declares one target:
`{ name: "knowledge", tools: ["knowledge_record"], readTools: ["knowledge_find"] }`.

- `guidance` — the review prompt bullets (record the inquiry and its why;
  find before creating; cite every field; give fields that go out of date a
  `horizonDays` — prices ~30, opening hours ~180, addresses none; record
  the user's verdicts, never the agent's guesses).
- `undo` — reverts a change (row-level equality: only rows still equal to
  what the change wrote are restored) and re-mirrors every touched entity.
- `wantsReview` / `reviewed` — drive the research flag (below).
- `maintain` — the idle pass: re-indexes up to 50 pending or
  horizon-stale entities (mirroring them into recall), continues an
  unfinished re-typing before proposing anything new, and proposes at
  most ONE generalization per pass — ≥ 3 sibling types whose field
  names overlap (pairwise Jaccard ≥ 0.5) become children of a new shared
  parent type; a child left with no distinct fields is folded (its
  entities re-typed, ≤ 50 per pass, extra values preserved in
  `attributes`); identity-key rows re-root (versioned) so records keep
  merging; declined groups are remembered for 30 days. The digest-run
  budget bounds the pass and its runs.

## The research trigger

An `afterTool` hook watches non-internal conversations with an owner: when
a tool whose name matches the owner's `researchTools` globs (defaults to
web search/fetch/crawl tool names) runs, the conversation is flagged in
`<user state>/research.json`. The curator asks `wantsReview` at settle;
a flag with no request in the last 15 minutes answers true once (stamping
the request), `reviewed` clears it, and a review that never completes is
re-requested after the window. Errors are logged, never thrown, and the
hook never alters tool results.

The glob list is the per-user `researchTools` setting (`*` is the only
wildcard), e.g. `["searxng/search*", "web_fetch"]`.

## Recall mirroring (optional dependency)

After each apply or undo, every touched entity is mirrored into recall
through the published `recall.index` hook (`kind: "record"`, id = entity
id, title/text/date/sources from the review card); archived entities are
removed through `recall.remove`. On `ok` the returned class and the index
instant are stored; on `absent` nothing happens (knowledge works fully
without recall); on `failed`/`rejected` the entity's `indexedAt` stays
behind its last version so the next idle pass retries.
