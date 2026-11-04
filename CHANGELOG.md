# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
