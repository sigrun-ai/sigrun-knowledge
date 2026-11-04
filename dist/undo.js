function writeVersion(db, changeId, table, rowId, before, after, at) {
    db.raw()
        .prepare('INSERT INTO versions (changeId, "table", rowId, before, after, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(changeId, table, rowId, before === undefined || before === null
        ? null
        : JSON.stringify(before), after === undefined || after === null
        ? null
        : JSON.stringify(after), at);
}
/**
 * Undo a change: walk its versions newest-first and restore each row's
 * `before` state — but only while the row still equals the change's
 * `after`. A row a later change edited is skipped, so undo restores only
 * what the change last wrote. Every restore is itself recorded as a
 * version under `undo:<changeId>`, so nothing is lost.
 */
export function undoChange(db, changeId, now) {
    return db.transaction(() => {
        const undoId = `undo:${changeId}`;
        const versions = db
            .raw()
            .prepare('SELECT seq, changeId, "table", rowId, before, after, at FROM versions WHERE changeId = ? ORDER BY seq DESC')
            // SAFETY: the versions table columns are fixed by db.ts's schema;
            // node:sqlite only types rows generically.
            .all(changeId);
        let restored = 0;
        const skipped = [];
        const touched = new Set();
        for (const version of versions) {
            switch (version.table) {
                case "entities": {
                    const outcome = undoEntity(db, version, undoId, now);
                    if (outcome === "restored") {
                        restored += 1;
                        touched.add(version.rowId);
                    }
                    else if (outcome !== "unchanged") {
                        skipped.push(outcome);
                    }
                    break;
                }
                case "roles": {
                    const outcome = undoRole(db, version, undoId, now);
                    if (outcome === "restored")
                        restored += 1;
                    else if (outcome !== "unchanged")
                        skipped.push(outcome);
                    break;
                }
                case "inquiries": {
                    const outcome = undoInquiry(db, version, undoId, now);
                    if (outcome === "restored")
                        restored += 1;
                    else if (outcome !== "unchanged")
                        skipped.push(outcome);
                    break;
                }
                case "types": {
                    // Type rows are shared schema, not records: their versions
                    // exist for audit, but undo never rewrites schema.
                    skipped.push(`type ${version.rowId}: type schema changes are not reverted`);
                    break;
                }
                case "entity_keys": {
                    const outcome = undoEntityKey(db, version, undoId, now);
                    if (outcome === "restored")
                        restored += 1;
                    else if (outcome !== "unchanged")
                        skipped.push(outcome);
                    break;
                }
            }
        }
        return { restored, skipped, touched: [...touched] };
    });
}
function undoEntity(db, version, undoId, now) {
    const row = db
        .raw()
        .prepare("SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ?")
        .get(version.rowId);
    if (row === undefined) {
        return `entity ${version.rowId}: no longer present`;
    }
    if (version.before === null) {
        // The change created this entity: undo archives it — but only
        // while the row still equals what the change wrote; a later
        // change's edits (rename, new fields, new keys) stand.
        if (Number(row.archived) !== 0)
            return "unchanged";
        const afterCreate = JSON.parse(version.after ?? "null");
        const differs = afterDiffersFromRow(afterCreate, row, [
            "name",
            "keys",
            "fields",
            "attributes",
            "typeId",
        ]);
        if (differs !== null) {
            return `entity "${String(row.name)}" (${version.rowId}): ${differs}`;
        }
        writeVersion(db, undoId, "entities", version.rowId, row, { ...row, archived: 1 }, now);
        db.raw()
            .prepare("UPDATE entities SET archived = 1 WHERE id = ?")
            .run(version.rowId);
        return "restored";
    }
    const before = JSON.parse(version.before ?? "null");
    const after = JSON.parse(version.after ?? "null");
    // Whole-row equality: a later change touching anything the change
    // wrote (name, keys, attributes, type — not just fields) blocks the
    // undo, so undoing A can never silently revert B's rename.
    const differs = afterDiffersFromRow(after, row, [
        "name",
        "keys",
        "fields",
        "attributes",
        "typeId",
    ]);
    if (before === null || after === null || differs !== null) {
        return `entity "${String(row.name)}" (${version.rowId}): ${differs ?? "changed by a later change"}`;
    }
    const restoredRow = { ...row, ...before, id: row.id, archived: row.archived };
    writeVersion(db, undoId, "entities", version.rowId, row, restoredRow, now);
    db.raw()
        .prepare("UPDATE entities SET typeId = ?, name = ?, keys = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?")
        .run(restoredRow.typeId, restoredRow.name, restoredRow.keys, restoredRow.fields, restoredRow.attributes, restoredRow.indexedAt, version.rowId);
    return "restored";
}
/**
 * JSON-stable compare of a version's `after` against the current row for
 * the given columns. Returns null when equal, otherwise a short text
 * naming the first differing column.
 */
function afterDiffersFromRow(after, row, columns) {
    if (after === null)
        return "changed by a later change";
    for (const column of columns) {
        // Absent key = the version blob doesn't carry that column (partial
        // blobs, e.g. inquiry updates store only conversations/outcome);
        // undefined can only mean missing — a stored null is "null".
        if (after[column] === undefined)
            continue;
        if (JSON.stringify(after[column]) !== JSON.stringify(row[column])) {
            return `${column} changed by a later change`;
        }
    }
    return null;
}
function undoRole(db, version, undoId, now) {
    const row = db
        .raw()
        .prepare("SELECT id, inquiryId, entityId, role, reason FROM roles WHERE id = ?")
        .get(Number(version.rowId));
    if (row === undefined)
        return "unchanged";
    if (version.before === null) {
        // The change created this role: undo deletes it.
        const after = JSON.parse(version.after ?? "null");
        const differs = afterDiffersFromRow(after, row, ["role", "reason"]);
        if (differs !== null) {
            return `role ${version.rowId}: ${differs}`;
        }
        writeVersion(db, undoId, "roles", version.rowId, row, null, now);
        db.raw().prepare("DELETE FROM roles WHERE id = ?").run(Number(version.rowId));
        return "restored";
    }
    const before = JSON.parse(version.before ?? "null");
    const after = JSON.parse(version.after ?? "null");
    const differs = afterDiffersFromRow(after, row, ["role", "reason"]);
    if (before === null || after === null || differs !== null) {
        return `role ${version.rowId}: ${differs ?? "changed by a later change"}`;
    }
    writeVersion(db, undoId, "roles", version.rowId, row, { ...row, ...before, id: row.id }, now);
    db.raw()
        .prepare("UPDATE roles SET role = ?, reason = ? WHERE id = ?")
        .run(before.role, before.reason ?? null, Number(version.rowId));
    return "restored";
}
function undoInquiry(db, version, undoId, now) {
    const row = db
        .raw()
        .prepare("SELECT id, question, why, startedAt, touchedAt, conversations, outcome, archived FROM inquiries WHERE id = ?")
        .get(Number(version.rowId));
    if (row === undefined)
        return "unchanged";
    if (version.before === null) {
        // The change created this inquiry: undo archives it (records are
        // never deleted). Only while the row still equals what the change
        // wrote.
        if (Number(row.archived) !== 0)
            return "unchanged";
        const after = JSON.parse(version.after ?? "null");
        const differs = afterDiffersFromRow(after, row, [
            "question",
            "why",
            "outcome",
            "conversations",
        ]);
        if (differs !== null) {
            return `inquiry "${String(row.question)}" (${version.rowId}): ${differs}`;
        }
        writeVersion(db, undoId, "inquiries", version.rowId, row, { ...row, archived: 1 }, now);
        db.raw()
            .prepare("UPDATE inquiries SET archived = 1, touchedAt = ? WHERE id = ?")
            .run(now, Number(version.rowId));
        return "restored";
    }
    const before = JSON.parse(version.before ?? "null");
    const after = JSON.parse(version.after ?? "null");
    const differs = afterDiffersFromRow(after, row, [
        "question",
        "why",
        "outcome",
        "conversations",
    ]);
    if (before === null || after === null || differs !== null) {
        return `inquiry "${String(row.question)}" (${version.rowId}): ${differs ?? "changed by a later change"}`;
    }
    const restored = { ...row, ...before, id: row.id };
    writeVersion(db, undoId, "inquiries", version.rowId, row, restored, now);
    db.raw()
        .prepare("UPDATE inquiries SET conversations = ?, outcome = ?, archived = ?, touchedAt = ? WHERE id = ?")
        .run(restored.conversations, restored.outcome ?? null, Number(restored.archived ?? 0), now, Number(version.rowId));
    return "restored";
}
function undoEntityKey(db, version, undoId, now) {
    // applyRecord only ever creates key rows; undo removes them.
    if (version.before !== null)
        return "unchanged";
    const row = db
        .raw()
        .prepare("SELECT id, entityId, typeFamilyRoot, key, normalized FROM entity_keys WHERE id = ?")
        .get(Number(version.rowId));
    if (row === undefined)
        return "unchanged";
    writeVersion(db, undoId, "entity_keys", version.rowId, row, null, now);
    db.raw()
        .prepare("DELETE FROM entity_keys WHERE id = ?")
        .run(Number(version.rowId));
    return "restored";
}
