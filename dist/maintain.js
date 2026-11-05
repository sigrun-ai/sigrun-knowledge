import { randomUUID } from "node:crypto";
import { mirrorEntities } from "./mirror.js";
import { retypeEntities } from "./apply.js";
import { effectiveFields, TYPE_NAME_PATTERN, } from "./schema.js";
const REINDEX_LIMIT = 50;
const RETYPE_LIMIT = 50;
const DECLINED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_GROUP_SIZE = 3;
const MIN_JACCARD = 0.5;
function writeVersion(db, changeId, table, rowId, before, after, at) {
    db.raw()
        .prepare('INSERT INTO versions (changeId, "table", rowId, before, after, at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(changeId, table, rowId, before === undefined || before === null ? null : JSON.stringify(before), after === undefined || after === null ? null : JSON.stringify(after), at);
}
/** Jaccard similarity of two field-name sets. */
export function jaccard(a, b) {
    const setA = new Set(a);
    const setB = new Set(b);
    let common = 0;
    for (const name of setA)
        if (setB.has(name))
            common += 1;
    const union = setA.size + setB.size - common;
    return union === 0 ? 0 : common / union;
}
function loadLiveTypes(db) {
    return db
        .raw()
        .prepare(`SELECT DISTINCT t.id, t.name, t.description, t.parentId, t.fields, t.archived
			 FROM types t
			WHERE t.archived = 0 AND NOT EXISTS (
			   SELECT 1 FROM types c
			   WHERE c.archived = 0 AND c.parentId = t.id)`)
        // SAFETY: the types table columns are fixed by db.ts's schema; node:sqlite
        // types rows generically.
        .all();
}
function entityCount(db, typeId) {
    const row = db
        .raw()
        .prepare("SELECT COUNT(*) AS n FROM entities WHERE typeId = ? AND archived = 0")
        .get(typeId);
    return row.n;
}
function entityIdsOf(db, typeId) {
    return db
        .raw()
        .prepare("SELECT id FROM entities WHERE typeId = ? AND archived = 0 ORDER BY id")
        .all(typeId).map((row) => row.id);
}
/** The group key for the 30-day declined memory. */
function groupKey(names) {
    return [...names].sort().join("|");
}
function isDeclined(db, key, now) {
    // Expired declines are pruned as they age out.
    db.raw()
        .prepare("DELETE FROM maintenance WHERE kind = 'declined-generalization' AND at < ?")
        .run(now - DECLINED_TTL_MS);
    const rows = db
        .raw()
        .prepare("SELECT payload, at FROM maintenance WHERE kind = 'declined-generalization'")
        .all();
    // The group's most recent decline within the TTL wins; an older
    // expired decline is a re-ask.
    let declinedAt;
    for (const row of rows) {
        const payload = JSON.parse(row.payload);
        if (payload.group === key) {
            declinedAt = declinedAt === undefined ? row.at : Math.max(declinedAt, row.at);
        }
    }
    return declinedAt !== undefined && now - declinedAt <= DECLINED_TTL_MS;
}
function rememberDeclined(db, key, now) {
    db.raw()
        .prepare("INSERT INTO maintenance (kind, changeId, payload, cursor, at) VALUES ('declined-generalization', NULL, ?, NULL, ?)")
        .run(JSON.stringify({ group: key }), now);
}
/** node:sqlite reports a UNIQUE violation as a message match. */
function isUniqueKeyViolation(error) {
    return (error instanceof Error &&
        /UNIQUE constraint failed/.test(error.message) &&
        error.message.includes("entity_keys"));
}
/**
 * Drop the entity's key rows whose (key, normalized) already exists at
 * the target family's root — the normalized identity is already keyed
 * there, so our row is a duplicate. Each drop is versioned (before,
 * after null) so undo can restore it. Returns true when every
 * conflicting row was dropped.
 */
function dropConflictingKeys(db, entityId, targetTypeName, changeId, now) {
    // Resolve the target family's root id.
    const rootRow = db
        .raw()
        .prepare("SELECT id, parentId FROM types WHERE name = ? AND archived = 0")
        .get(targetTypeName);
    if (rootRow === undefined)
        return false;
    let rootId = rootRow.id;
    let guard = 0;
    while (guard++ < 32) {
        const next = db
            .raw()
            .prepare("SELECT id, parentId FROM types WHERE id = ?")
            .get(rootId);
        if (next === undefined || next.parentId === null)
            break;
        rootId = next.parentId;
    }
    const mine = db
        .raw()
        .prepare("SELECT id, entityId, typeFamilyRoot, key, normalized FROM entity_keys WHERE entityId = ?")
        .all(entityId);
    for (const keyRow of mine) {
        const collision = db
            .raw()
            .prepare("SELECT id FROM entity_keys WHERE typeFamilyRoot = ? AND key = ? AND normalized = ? AND id != ?")
            .get(rootId, keyRow.key, keyRow.normalized, keyRow.id);
        if (collision === undefined)
            continue;
        writeVersion(db, changeId, "entity_keys", String(keyRow.id), keyRow, null, now);
        db.raw()
            .prepare("DELETE FROM entity_keys WHERE id = ?")
            .run(keyRow.id);
    }
    return true;
}
function loadContinuation(db) {
    const row = db
        .raw()
        .prepare("SELECT changeId, payload FROM maintenance WHERE kind = 'retype-continuation' ORDER BY id DESC LIMIT 1")
        .get();
    if (row === undefined || row.changeId === null)
        return undefined;
    const payload = JSON.parse(row.payload);
    if (payload.parentType === undefined)
        return undefined;
    return {
        changeId: row.changeId,
        parentType: payload.parentType,
        remaining: payload.remaining ?? [],
    };
}
function saveContinuation(db, changeId, parentType, remaining, now) {
    const existing = db
        .raw()
        .prepare("SELECT id FROM maintenance WHERE kind = 'retype-continuation' ORDER BY id DESC LIMIT 1")
        .get();
    if (existing !== undefined) {
        db.raw()
            .prepare("DELETE FROM maintenance WHERE id = ?")
            .run(existing.id);
    }
    db.raw()
        .prepare("INSERT INTO maintenance (kind, changeId, payload, cursor, at) VALUES ('retype-continuation', ?, ?, NULL, ?)")
        .run(changeId, JSON.stringify({ parentType, remaining }), now);
}
function dropContinuation(db) {
    db.raw()
        .prepare("DELETE FROM maintenance WHERE kind = 'retype-continuation'")
        .run();
}
function generalizePrompt(types) {
    const lines = types
        .map((type) => `- ${type.name}: fields ${type.fields.map((field) => field.name).join(", ") || "(none)"}`)
        .join("\n");
    return [
        "These knowledge types look like siblings. Decide whether they are kinds of ONE general type.",
        lines,
        "",
        'Answer ONLY JSON: {"general": true, "name": string, "description": string, "fields": [{"name": string, "type": "string"|"number"|"boolean"|"date"|"url"|"money"|"enum"|"list", "horizonDays"?: number}]} — the parent name (a lowercase singular phrase), description, and the shared fields each child already carries.',
        'Or {"general": false}.',
    ].join("\n");
}
function parseAnswer(text) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(text.slice(start, end + 1));
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== "object" || parsed === null)
        return undefined;
    const raw = parsed;
    if (raw.general !== true)
        return { general: false };
    if (typeof raw.name !== "string" || raw.name.trim() === "")
        return undefined;
    if (typeof raw.description !== "string")
        return undefined;
    if (!Array.isArray(raw.fields))
        return undefined;
    const fields = [];
    for (const field of raw.fields) {
        if (typeof field.name !== "string" || typeof field.type !== "string") {
            return undefined;
        }
        const def = { name: field.name, type: field.type };
        if (typeof field.horizonDays === "number")
            def.horizonDays = field.horizonDays;
        if (typeof field.description === "string")
            def.description = field.description;
        if (typeof field.identity === "boolean")
            def.identity = field.identity;
        if (field.type === "list" && typeof field.item === "string") {
            def.item = field.item;
        }
        if (Array.isArray(field.values)) {
            def.values = field.values.filter((v) => typeof v === "string");
        }
        fields.push(def);
    }
    return {
        general: true,
        name: raw.name.trim(),
        description: raw.description,
        fields,
    };
}
/**
 * The idle pass, in order, stopping at the deadline:
 * 1. re-index up to 50 pending/stale entities (not reported);
 * 2. continue an unfinished re-typing before proposing anything new;
 * 3. propose one generalization via budget.run (needs runs >= 1);
 * 4. apply it as a hierarchy in one change, folding field-less children
 *    (<= 50 entities per pass; the rest continue next pass under the
 *    same change id, reported with more: true).
 * At most one generalization per pass.
 */
export async function maintain(user, ctx, budget, deps) {
    void ctx;
    const db = deps.dbForUser(user);
    const changes = [];
    let more = false;
    // 1. Re-index pending entities: indexedAt behind their last version,
    //    never indexed, or whose card text changed because a field
    //    crossed its horizon since the index stamp.
    const now = deps.now();
    const pending = db
        .raw()
        .prepare(`SELECT e.id, e.typeId, e.fields, e.indexedAt FROM entities e
			 WHERE e.archived = 0 AND (
			   e.indexedAt IS NULL OR e.indexedAt < COALESCE((
			     SELECT MAX(v.at) FROM versions v
			     WHERE v."table" = 'entities' AND v.rowId = e.id
			   ), 0))
			 ORDER BY e.id LIMIT ?`)
        .all(REINDEX_LIMIT);
    const pendingIds = new Set(pending.map((row) => row.id));
    if (pendingIds.size < REINDEX_LIMIT) {
        // Horizon-crossed: a field went stale (or came back) since the
        // index, so the mirrored card text no longer matches.
        const typeRows = db
            .raw()
            .prepare("SELECT id, parentId, fields FROM types")
            // SAFETY: types columns are fixed by db.ts's schema.
            .all();
        const typesById = new Map(typeRows.map((type) => [type.id, type]));
        const candidates = db
            .raw()
            .prepare("SELECT id, typeId, fields, indexedAt FROM entities WHERE archived = 0 AND indexedAt IS NOT NULL ORDER BY id")
            .all();
        for (const candidate of candidates) {
            if (pendingIds.size >= REINDEX_LIMIT)
                break;
            if (pendingIds.has(candidate.id))
                continue;
            const defs = new Map(effectiveFields(typesById, candidate.typeId).map((def) => [
                def.name,
                def,
            ]));
            const fields = JSON.parse(candidate.fields);
            for (const [fieldName, field] of Object.entries(fields)) {
                const def = defs.get(fieldName);
                if (def?.horizonDays === undefined)
                    continue;
                const observedMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(field.observedAt)
                    ? `${field.observedAt}T00:00:00Z`
                    : field.observedAt);
                if (Number.isNaN(observedMs))
                    continue;
                const staleAt = observedMs + def.horizonDays * 24 * 60 * 60 * 1000;
                // The horizon sits between the index stamp and now: the card
                // gained (or would lose) its stale mark since indexing.
                if (candidate.indexedAt < staleAt && now >= staleAt) {
                    pendingIds.add(candidate.id);
                    break;
                }
            }
        }
    }
    if (pendingIds.size > 0) {
        await mirrorEntities(deps.host, db, user, [...pendingIds], now);
    }
    if (deps.now() > budget.deadline) {
        return { changes, ...(more ? { more: true } : {}) };
    }
    // 2. Continue an unfinished re-typing before proposing anything new.
    const continuation = loadContinuation(db);
    if (continuation !== undefined) {
        const batch = continuation.remaining.slice(0, RETYPE_LIMIT);
        const rest = continuation.remaining.slice(RETYPE_LIMIT);
        if (batch.length > 0) {
            const typeExists = db
                .raw()
                .prepare("SELECT 1 AS x FROM types WHERE name = ? AND archived = 0")
                .get(continuation.parentType);
            if (typeExists === undefined) {
                // The fold target vanished (archived/renamed mid-fold): the
                // continuation can never finish — drop it rather than throw
                // forever.
                console.error(`knowledge: dropping re-type continuation into "${continuation.parentType}" (type no longer live)`);
                dropContinuation(db);
                return { changes, ...(more ? { more: true } : {}) };
            }
            try {
                retypeEntities(db, batch, continuation.parentType, continuation.changeId, deps.now());
            }
            catch (error) {
                // One bad row (a key collision with the new family root)
                // must not block the other 49: retry per entity.
                console.error("knowledge: continuation re-type batch failed", error);
                for (const entityId of batch) {
                    try {
                        retypeEntities(db, [entityId], continuation.parentType, continuation.changeId, deps.now());
                    }
                    catch (single) {
                        // The entity must not park the continuation forever.
                        // A key collision with a row already at the new root
                        // (same normalized identity, e.g. another folded
                        // sibling's entity) resolves by dropping OUR duplicate
                        // key row (versioned, mirroring the step-4 retyped
                        // loop) and retrying. Any other failure removes the
                        // entity from the continuation with a log line.
                        if (!isUniqueKeyViolation(single) || !dropConflictingKeys(db, entityId, continuation.parentType, continuation.changeId, deps.now())) {
                            console.error(`knowledge: re-type of entity ${entityId} failed; removing it from the continuation`, single);
                            continue;
                        }
                        try {
                            retypeEntities(db, [entityId], continuation.parentType, continuation.changeId, deps.now());
                        }
                        catch (retry) {
                            console.error(`knowledge: re-type of entity ${entityId} failed after key drop; removing it from the continuation`, retry);
                        }
                    }
                }
            }
            await mirrorEntities(deps.host, db, user, batch, deps.now());
        }
        const remaining = rest;
        if (remaining.length > 0) {
            saveContinuation(db, continuation.changeId, continuation.parentType, remaining, deps.now());
            more = true;
        }
        else {
            dropContinuation(db);
            changes.push({
                changeId: continuation.changeId,
                summary: `re-typed remaining entities into ${continuation.parentType}`,
            });
        }
        return { changes, ...(more ? { more: true } : {}) };
    }
    // 3. Propose (needs budget).
    if (budget.runs < 1)
        return { changes, ...(more ? { more: true } : {}) };
    if (deps.now() > budget.deadline) {
        return { changes, ...(more ? { more: true } : {}) };
    }
    // Find sibling groups: same parent (or both root), not archived,
    // >= 3 types, pairwise field-name Jaccard >= 0.5. Groups remembered
    // as declined are filtered BEFORE picking the max so a declined best
    // group doesn't starve the others.
    const types = loadLiveTypes(db);
    const siblings = new Map();
    for (const type of types) {
        const key = type.parentId === null ? "root" : String(type.parentId);
        const list = siblings.get(key) ?? [];
        list.push(type);
        siblings.set(key, list);
    }
    let best;
    for (const group of siblings.values()) {
        if (group.length < MIN_GROUP_SIZE)
            continue;
        const names = group.map((type) => JSON.parse(type.fields).map((field) => field.name));
        let ok = true;
        for (let i = 0; i < group.length && ok; i++) {
            for (let j = i + 1; j < group.length; j++) {
                if (jaccard(names[i], names[j]) < MIN_JACCARD) {
                    ok = false;
                    break;
                }
            }
        }
        if (!ok)
            continue;
        if (isDeclined(db, groupKey(group.map((type) => type.name)), now))
            continue;
        const count = group.reduce((sum, type) => sum + entityCount(db, type.id), 0);
        if (best === undefined || count > best.entities)
            best = { group, entities: count };
    }
    if (best === undefined)
        return { changes, ...(more ? { more: true } : {}) };
    const run = await budget.run(generalizePrompt(best.group.map((type) => ({
        name: type.name,
        fields: JSON.parse(type.fields),
    }))), ["knowledge_find"]);
    // A run that fails to produce a clean answer leaves the schema
    // untouched; a JSON {general:false} or unparseable text is remembered
    // for 30 days so the group isn't re-asked every pass. A dead/failed
    // run is not remembered (transient).
    if (run.status !== "completed") {
        return { changes, ...(more ? { more: true } : {}) };
    }
    const answer = parseAnswer(run.text);
    if (answer === undefined || answer.general === false) {
        rememberDeclined(db, groupKey(best.group.map((type) => type.name)), deps.now());
        return { changes, ...(more ? { more: true } : {}) };
    }
    // The answer must not rename onto ANY types row (the name column is
    // UNIQUE across archived rows too) and must be a valid type name;
    // decline in either case.
    const nameTaken = db
        .raw()
        .prepare("SELECT 1 AS x FROM types WHERE name = ?")
        .get(answer.name);
    if (nameTaken !== undefined || !TYPE_NAME_PATTERN.test(answer.name)) {
        rememberDeclined(db, groupKey(best.group.map((type) => type.name)), deps.now());
        return { changes, ...(more ? { more: true } : {}) };
    }
    // 4. Apply as a hierarchy in ONE change.
    if (deps.now() > budget.deadline) {
        // A deadline is not an answer: keep the group's candidacy (and the
        // paid run) by asking again next pass, without remembering a
        // decline.
        return { changes: [], more: true };
    }
    const changeId = `maintain:${randomUUID()}`;
    const group = best.group;
    const answerFieldNames = new Set(answer.fields.map((field) => field.name));
    const folded = [];
    const retyped = [];
    for (const type of group) {
        const own = JSON.parse(type.fields);
        const distinct = own.filter((field) => !answerFieldNames.has(field.name));
        if (distinct.length === 0)
            folded.push(type);
        else
            retyped.push(type);
    }
    const foldedEntities = [];
    db.transaction(() => {
        // The parent. Shared fields come from the answer.
        const parentDef = {
            name: answer.name,
            description: answer.description,
            fields: answer.fields,
        };
        const inserted = db
            .raw()
            .prepare("INSERT INTO types (name, description, parentId, fields, version) VALUES (?, ?, NULL, ?, 1)")
            .run(parentDef.name, parentDef.description, JSON.stringify(parentDef.fields));
        const parentId = Number(inserted.lastInsertRowid);
        writeVersion(db, changeId, "types", String(parentId), null, {
            id: parentId,
            name: parentDef.name,
            description: parentDef.description,
            parentId: null,
            fields: JSON.stringify(parentDef.fields),
            version: 1,
            archived: 0,
        }, now);
        for (const type of retyped) {
            const own = JSON.parse(type.fields);
            const distinct = own.filter((field) => !answerFieldNames.has(field.name));
            const before = {
                id: type.id,
                name: type.name,
                description: type.description,
                parentId: type.parentId,
                fields: type.fields,
                archived: type.archived,
            };
            const after = {
                ...before,
                parentId,
                fields: JSON.stringify(distinct),
            };
            writeVersion(db, changeId, "types", String(type.id), before, after, now);
            db.raw()
                .prepare("UPDATE types SET parentId = ?, fields = ?, version = version + 1 WHERE id = ?")
                .run(parentId, JSON.stringify(distinct), type.id);
            // Re-parenting changes the child's identity family: its key
            // rows must re-root at the new parent or the next record for
            // the same key would duplicate the entity (apply matches by
            // family root). A collision with a key row already at the
            // parent root (a folded sibling's key) resolves by keeping the
            // folded sibling's row and moving ours — both point at the
            // same normalized identity, and the unique index is on
            // (root, key, normalized), so identical normalized values
            // would collide: drop the child's duplicate row instead.
            const keyRows = db
                .raw()
                .prepare("SELECT id, entityId, typeFamilyRoot, key, normalized FROM entity_keys WHERE typeFamilyRoot = ?")
                .all(type.id);
            for (const keyRow of keyRows) {
                const collision = db
                    .raw()
                    .prepare("SELECT id FROM entity_keys WHERE typeFamilyRoot = ? AND key = ? AND normalized = ? AND id != ?")
                    .get(parentId, keyRow.key, keyRow.normalized, keyRow.id);
                if (collision !== undefined) {
                    // Same normalized identity already keyed at the new root:
                    // the child's row is a duplicate; drop it (versioned).
                    // The incumbent keeps its key row — a later record for the
                    // shared key merges into the incumbent, never into an
                    // entity the fold touched.
                    writeVersion(db, changeId, "entity_keys", String(keyRow.id), keyRow, null, now);
                    db.raw()
                        .prepare("DELETE FROM entity_keys WHERE id = ?")
                        .run(keyRow.id);
                    continue;
                }
                writeVersion(db, changeId, "entity_keys", String(keyRow.id), keyRow, { ...keyRow, typeFamilyRoot: parentId }, now);
                db.raw()
                    .prepare("UPDATE entity_keys SET typeFamilyRoot = ? WHERE id = ?")
                    .run(parentId, keyRow.id);
            }
        }
        for (const type of folded) {
            const ids = entityIdsOf(db, type.id);
            foldedEntities.push(...ids);
            const before = {
                id: type.id,
                name: type.name,
                description: type.description,
                parentId: type.parentId,
                fields: type.fields,
                archived: type.archived,
            };
            const after = { ...before, archived: 1 };
            writeVersion(db, changeId, "types", String(type.id), before, after, now);
            db.raw()
                .prepare("UPDATE types SET archived = 1, version = version + 1 WHERE id = ?")
                .run(type.id);
        }
    });
    const summary = `generalized ${group.map((type) => type.name).join(", ")} into ${answer.name}`;
    changes.push({ changeId, summary });
    // Fold: re-type up to 50 entities this pass; the rest continue next
    // pass under the same change id.
    const batch = foldedEntities.slice(0, RETYPE_LIMIT);
    const rest = foldedEntities.slice(RETYPE_LIMIT);
    if (batch.length > 0) {
        try {
            retypeEntities(db, batch, answer.name, changeId, now);
        }
        catch (error) {
            // A re-type can fail when two sibling roots co-held the same
            // identity key (the family-root UNIQUE constraint collides at
            // the new parent). Keep the full remainder for the next pass
            // rather than dropping the hierarchy half-applied.
            console.error("knowledge: fold re-type failed", error);
            saveContinuation(db, changeId, answer.name, foldedEntities, deps.now());
            return { changes, more: true };
        }
        await mirrorEntities(deps.host, db, user, batch, deps.now());
    }
    if (rest.length > 0) {
        saveContinuation(db, changeId, answer.name, rest, deps.now());
        more = true;
    }
    return { changes, ...(more ? { more: true } : {}) };
}
