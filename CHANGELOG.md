# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-11-08

- CI: test against the latest released core (core-ref: release). No code change.

## [0.1.2] - 2026-11-07

## [0.1.3] - 2026-11-07

### Added

- Read-only Knowledge view: type hierarchy, searchable entities, entity details
  and history, inquiries, conversation links, and an archived-type/inquiry
  toggle. Type pages identify and describe the selected type, inquiry details
  include dates, archived types are badged, and the search box retains the
  applied query. Views are scoped to the calling principal and never create a
  store.

### Changed

- peer pi-durable/pi-ai/chord ~1.5.0 (requires sigrun 0.11.0).

### Fixed

- afterTool skips results of calls that never ran (pi-durable 1.5.0 hook semantics).

### Also in this line (0.1.0 content, restated)

- Everything below, released as 0.1.0: the full knowledge extension —
  store, atomic versioned apply/undo, tools, the curation target, the
  research flag, recall mirroring and the idle pass.

### Fixed (post-merge follow-ups)

- Idle pass: a kept child type's identity-key rows re-root by its
  entities, not by the child's own type id — a child type's rows live at
  its family root (the grandparent), so the old select missed them and a
  later record for the same key minted a duplicate entity.
- Mirroring: a rejected `recall.index` call logs one line (the silent
  skip hid every mirror failure — including the card-date format bug the
  e2e later caught).

## [0.1.1] - 2026-11-05

### Fixed

- First registry release. 0.1.0 was consumed by the npm stage
  bootstrap (the name-claiming placeholder) and never published; 0.1.1
  is the identical tree.

### Added

- Package scaffold: `createKnowledge(host, deps?)` factory returning
  `defineExtension({ name: "@sigrun/knowledge" })`, arity 1, with lazily
  opened per-user databases closed on `harnessShutdown`.
- `src/schema.ts`: the field-schema subset (`FieldType`, `FieldDef`,
  `TypeDef`, `TypeDefSchema`, `validateValue`).
- `src/db.ts`: `KnowledgeDb` — types / entities / entity_keys / inquiries /
  roles / versions / applied / maintenance tables plus
  `transaction` (BEGIN IMMEDIATE / COMMIT / ROLLBACK) and `close`.
- `src/config.ts`: `resolveUserSettings` (researchTools glob list with
  warn-once fallback) and `matchesGlob` (`*` only).
- `src/apply.ts` / `src/undo.ts` / `src/card.ts`: `applyRecord` (one
  transaction, whole-record validation, entity de-duplication by
  identity-key pairs within a type family, idempotent replay by call id),
  `undoChange` (newest-first row-equality restores, versioned under
  `undo:<changeId>`, create-archive and skip reporting), `retypeEntities`,
  and `renderCard` (stale marks past `horizonDays`).
- `src/tools.ts`: `knowledge_record` (target tool, replay-safe, idempotent
  by call id; inquiry records the reviewed parent conversation through the
  fork-ancestry paging lookup) and `knowledge_find` (read tool — batched
  type/field/inquiry/text queries; text via `recall.search` with LIKE
  fallback; audience rule first; local-only entities never shown).
- `src/target.ts`: the `knowledge` curation target — guidance, undo
  (revert + re-mirror), wantsReview/reviewed on the research flag,
  `maintain` (the idle pass: re-index pending/stale entities, continue
  unfinished re-typing, propose one generalization per pass — ≥3
  overlapping siblings into a shared parent, folding field-less
  children, ≤50 retypes per pass).
- `src/research.ts`: the `afterTool` research flag (`<user
  state>/research.json`) with the 15-minute single-request window.
- `src/mirror.ts`: recall mirroring after apply/undo — `recall.index`
  (kind `record`) or `recall.remove` for archived entities; failure
  leaves `indexedAt` behind the last version for the idle pass.
- `src/audience.ts`: the audience rule (private copy of recall's).
- `src/prompts.ts`: the review guidance bullets.
- `src/maintain.ts`: the idle pass implementation (generalize sibling
  types into a hierarchy with versioned key re-roots, declined-group
  memory, collision-drop cleanup).

### Dependencies

- `@sigrun/shared` peer accepts `0.5.0 || 0.6.0 || 0.6.1 || 0.7.0 ||
  0.8.0` (the runtime value imports landed on 0.5.0; recall made the
  same widening).

<!-- TODO at release time: pin `@sigrun/sigrun` and `@sigrun/shared` to
     the releases carrying published hooks and curation targets (core
     0.9.0 line, when cut). -->
