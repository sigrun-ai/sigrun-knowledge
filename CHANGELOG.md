# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `src/tools.ts`: `knowledge_record` (target tool, replay-safe, idempotent
  by call id; inquiry records the reviewed parent conversation through the
  fork-ancestry paging lookup) and `knowledge_find` (read tool — batched
  type/field/inquiry/text queries; text via `recall.search` with LIKE
  fallback; audience rule first; local-only entities never shown).
- `src/target.ts`: the `knowledge` curation target — guidance, undo
  (revert + re-mirror), wantsReview/reviewed on the research flag;
  `maintain` is a no-op placeholder (Task 11).
- `src/research.ts`: the `afterTool` research flag (`<user
  state>/research.json`) with the 15-minute single-request window.
- `src/mirror.ts`: recall mirroring after apply/undo — `recall.index`
  (kind `record`) or `recall.remove` for archived entities; failure
  leaves `indexedAt` behind the last version for the idle pass.
- `src/audience.ts`: the audience rule (private copy of recall's).
- `src/prompts.ts`: the review guidance bullets.

TODO before release: pin `@sigrun/sigrun` and `@sigrun/shared` to the
releases carrying published hooks and curation targets.

## [0.1.0] - 2026-11-04

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
