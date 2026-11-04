# @sigrun/knowledge

Curated per-user knowledge extension for [sigrun](https://github.com/sigrun-ai/sigrun).

This package owns one SQLite store per directory user
(`<user data dir>/knowledge.db`) holding typed knowledge entities, identity
keys, inquiries, and the version history that makes every change undoable.

The current scaffold ships the store and the field schemas; the apply/undo
pipeline, tools, and curator integration land in follow-up tasks.
