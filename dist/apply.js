import { randomUUID } from "node:crypto";
import { TYPE_NAME_PATTERN, validateValue, } from "./schema.js";
const MAX_TYPES_PER_RECORD = 10;
const MAX_ENTITIES_PER_RECORD = 50;
const ENTITY_ROLES = ["candidate", "shortlisted", "rejected", "chosen"];
/** Marker thrown inside the transaction to roll back on validation errors. */
class RecordInvalid extends Error {
}
/** Normalize an identity key value for matching within a type family. */
export function normalizeKey(key, value) {
    if (/phone|tel|fax|mobile/i.test(key)) {
        return value.replace(/\D/g, "");
    }
    if (/^https?:\/\//i.test(value) || /(^|\s)www\./i.test(value)) {
        return value
            .trim()
            .replace(/^https?:\/\//i, "")
            .replace(/^www\./i, "")
            .replace(/\/+$/, "")
            .toLowerCase();
    }
    return value.toLowerCase().trim().replace(/\s+/g, " ");
}
function loadTypes(db) {
    const rows = db
        .raw()
        .prepare("SELECT id, name, description, parentId, fields, version, archived FROM types WHERE archived = 0")
        .all();
    const map = new Map();
    for (const row of rows) {
        map.set(row.name, {
            ...row,
            fields: JSON.parse(row.fields),
        });
    }
    return map;
}
/** The topmost ancestor type id: one identity family per hierarchy. */
function familyRootId(typesById, typeId) {
    let current = typeId;
    for (;;) {
        const type = typesById.get(current);
        if (type === undefined || type.parentId === null)
            return current;
        current = type.parentId;
    }
}
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
 * Apply one knowledge record atomically. Any validation error rolls the
 * whole record back and is reported in `errors`. Replaying an already
 * applied `callId` returns the stored result unchanged.
 */
export function applyRecord(db, input, ctx) {
    const replayed = db
        .raw()
        .prepare("SELECT result FROM applied WHERE callId = ?")
        .get(ctx.callId);
    if (replayed !== undefined) {
        return JSON.parse(replayed.result);
    }
    const errors = [];
    let result;
    try {
        db.transaction(() => {
            const applied = applyValidating(db, input, ctx, errors);
            if (applied === undefined)
                throw new RecordInvalid();
            result = applied;
            db.raw()
                .prepare("INSERT INTO applied (callId, changeId, result) VALUES (?, ?, ?)")
                .run(ctx.callId, result.changeId, JSON.stringify(result));
        });
    }
    catch (error) {
        if (error instanceof RecordInvalid) {
            return { changeId: "", summary: "", touched: [], errors };
        }
        throw error;
    }
    if (result === undefined) {
        throw new Error("applyRecord: transaction finished without a result");
    }
    return result;
}
function applyValidating(db, input, ctx, errors) {
    if (input.types !== undefined && input.types.length > MAX_TYPES_PER_RECORD) {
        errors.push(`record declares ${input.types.length} types (max ${MAX_TYPES_PER_RECORD})`);
    }
    if (input.entities.length > MAX_ENTITIES_PER_RECORD) {
        errors.push(`record carries ${input.entities.length} entities (max ${MAX_ENTITIES_PER_RECORD})`);
    }
    if (errors.length > 0)
        return undefined;
    const changeId = randomUUID();
    const typesByName = loadTypes(db);
    let typesById = new Map();
    for (const type of typesByName.values())
        typesById.set(type.id, type);
    // Types: create, or extend by adding fields (never remove or retype).
    // A parent may be declared later in the same record, so resolve the
    // hierarchy in a fixpoint pass over the unresolved defs.
    const typeErrors = [];
    for (const def of input.types ?? []) {
        validateTypeDef(def, typeErrors);
        if (typeErrors.length > 0)
            break;
        const seen = new Set();
        const declared = new Map((input.types ?? []).map((d) => [d.name, d]));
        let cursor = def;
        while (cursor?.parent !== undefined) {
            if (seen.has(cursor.name)) {
                typeErrors.push(`type "${def.name}" has a parent cycle`);
                break;
            }
            seen.add(cursor.name);
            cursor = declared.get(cursor.parent);
        }
    }
    if (typeErrors.length > 0) {
        errors.push(...typeErrors);
        return undefined;
    }
    // Create/extend in a fixpoint pass so a parent declared later in the
    // same record resolves before its children are created.
    const pending = new Map((input.types ?? []).map((def) => [def.name, def]));
    for (;;) {
        let progressed = false;
        for (const def of pending.values()) {
            if (pending.has(def.parent ?? ""))
                continue;
            applyTypeDef(db, def, typesByName, typesById, errors, changeId, ctx.now);
            pending.delete(def.name);
            progressed = true;
            if (errors.length > 0)
                break;
        }
        if (!progressed || errors.length > 0)
            break;
    }
    for (const def of pending.values()) {
        errors.push(`type "${def.name}" has unknown parent "${def.parent}"`);
    }
    if (errors.length > 0)
        return undefined;
    function applyTypeDef(db, def, typesByName, typesById, errors, changeId, now) {
        const existing = typesByName.get(def.name);
        if (existing === undefined) {
            const parentId = def.parent === undefined
                ? null
                : (typesByName.get(def.parent)?.id ?? null);
            const inserted = db
                .raw()
                .prepare("INSERT INTO types (name, description, parentId, fields, version) VALUES (?, ?, ?, ?, 1)")
                .run(def.name, def.description, parentId, JSON.stringify(def.fields));
            const stored = {
                id: Number(inserted.lastInsertRowid),
                name: def.name,
                description: def.description,
                parentId,
                fields: def.fields,
                version: 1,
                archived: 0,
            };
            typesByName.set(def.name, stored);
            typesById.set(stored.id, stored);
            writeVersion(db, changeId, "types", String(stored.id), null, stored, now);
            return;
        }
        // Extending an existing type: every stored field must be present
        // with the same type; new fields append.
        const merged = [...existing.fields];
        const byName = new Map(merged.map((field) => [field.name, field]));
        for (const field of def.fields) {
            const stored = byName.get(field.name);
            if (stored === undefined) {
                merged.push(field);
            }
            else if (stored.type !== field.type) {
                errors.push(`type "${def.name}" retypes field "${field.name}" (${stored.type} -> ${field.type})`);
            }
        }
        for (const stored of existing.fields) {
            if (!def.fields.some((field) => field.name === stored.name)) {
                errors.push(`type "${def.name}" update drops field "${stored.name}"`);
            }
        }
        if (errors.length > 0)
            return;
        if (merged.length !== existing.fields.length) {
            const next = {
                ...existing,
                fields: merged,
                version: existing.version + 1,
            };
            writeVersion(db, changeId, "types", String(existing.id), existing, next, now);
            db.raw()
                .prepare("UPDATE types SET fields = ?, version = version + 1 WHERE id = ?")
                .run(JSON.stringify(merged), existing.id);
            existing.fields = merged;
            existing.version += 1;
        }
    }
    typesById = new Map();
    for (const type of typesByName.values())
        typesById.set(type.id, type);
    // Inquiry: match by question, else create.
    let inquiryId;
    if (input.inquiry !== undefined) {
        inquiryId = applyInquiry(db, input.inquiry, ctx, changeId);
    }
    const touched = [];
    const touchedTypeNames = [];
    for (const entityInput of input.entities) {
        const type = typesByName.get(entityInput.type);
        if (type === undefined) {
            errors.push(`entity "${entityInput.name}" has unknown type "${entityInput.type}"`);
            continue;
        }
        if (entityInput.role !== undefined &&
            !ENTITY_ROLES.includes(entityInput.role)) {
            errors.push(`entity "${entityInput.name}" has invalid role "${entityInput.role}"`);
            continue;
        }
        if (entityInput.role !== undefined && inquiryId === undefined) {
            errors.push(`entity "${entityInput.name}" carries a role but the record has no inquiry`);
            continue;
        }
        for (const [fieldName, field] of Object.entries(entityInput.fields)) {
            const def = type.fields.find((candidate) => candidate.name === fieldName);
            if (def === undefined) {
                errors.push(`entity "${entityInput.name}" field "${fieldName}" is not declared on type "${type.name}"`);
                continue;
            }
            const invalid = validateValue(def, field.value);
            if (invalid !== undefined) {
                errors.push(`entity "${entityInput.name}" field "${fieldName}": ${invalid}`);
            }
        }
        if (errors.length > 0)
            continue;
        const entityId = applyEntity(db, entityInput, type, typesById, changeId, ctx.now, errors);
        if (entityId === undefined)
            continue;
        touched.push(entityId);
        if (!touchedTypeNames.includes(type.name))
            touchedTypeNames.push(type.name);
        if (entityInput.role !== undefined && inquiryId !== undefined) {
            applyRole(db, inquiryId, entityId, entityInput.role, entityInput.reason, changeId, ctx.now);
        }
    }
    if (errors.length > 0)
        return undefined;
    const subject = input.inquiry?.question ?? "facts";
    const typeSummary = touchedTypeNames.map((name) => `${name}s`).join(", ");
    return {
        changeId,
        summary: `recorded ${subject}: ${touched.length} ${typeSummary}`,
        touched,
        errors: [],
    };
}
function validateTypeDef(def, errors) {
    if (!TYPE_NAME_PATTERN.test(def.name)) {
        errors.push(`type name "${def.name}" is not a lowercase singular phrase`);
    }
    if (typeof def.description !== "string" || def.description === "") {
        errors.push(`type "${def.name}" needs a description`);
    }
    if (def.parent !== undefined &&
        (def.name === def.parent || !TYPE_NAME_PATTERN.test(def.parent))) {
        errors.push(`type "${def.name}" has an invalid parent "${def.parent}"`);
    }
}
function applyInquiry(db, inquiry, ctx, changeId) {
    const existing = db
        .raw()
        .prepare("SELECT id, conversations, outcome, archived FROM inquiries WHERE question = ?")
        .get(inquiry.question);
    if (existing === undefined) {
        const conversations = ctx.conversationId === undefined ? [] : [ctx.conversationId];
        const inserted = db
            .raw()
            .prepare("INSERT INTO inquiries (question, why, startedAt, touchedAt, conversations, outcome) VALUES (?, ?, ?, ?, ?, ?)")
            .run(inquiry.question, inquiry.why ?? null, ctx.now, ctx.now, JSON.stringify(conversations), inquiry.outcome === undefined
            ? null
            : JSON.stringify(inquiry.outcome));
        const stored = {
            id: Number(inserted.lastInsertRowid),
            question: inquiry.question,
            why: inquiry.why ?? null,
            startedAt: ctx.now,
            touchedAt: ctx.now,
            conversations: JSON.stringify(conversations),
            outcome: inquiry.outcome === undefined
                ? null
                : JSON.stringify(inquiry.outcome),
            archived: 0,
        };
        writeVersion(db, changeId, "inquiries", String(stored.id), null, stored, ctx.now);
        return stored.id;
    }
    if (existing.archived !== 0) {
        // An archived inquiry matching this question is revived by the
        // record, not duplicated (undo archives; a re-apply unarchives).
        const revived = { ...existing, archived: 0, touchedAt: ctx.now };
        writeVersion(db, changeId, "inquiries", String(existing.id), existing, revived, ctx.now);
        db.raw()
            .prepare("UPDATE inquiries SET archived = 0, touchedAt = ? WHERE id = ?")
            .run(ctx.now, existing.id);
        existing.archived = 0;
    }
    // Existing inquiry: only record a version when something changed.
    const conversations = JSON.parse(existing.conversations);
    const conversationAdded = ctx.conversationId !== undefined &&
        !conversations.includes(ctx.conversationId);
    const outcomeChanged = inquiry.outcome !== undefined &&
        existing.outcome !== JSON.stringify(inquiry.outcome);
    if (conversationAdded || outcomeChanged) {
        const next = {
            conversations: conversationAdded
                ? [...conversations, ctx.conversationId]
                : conversations,
            outcome: outcomeChanged ? inquiry.outcome : existing.outcome,
        };
        writeVersion(db, changeId, "inquiries", String(existing.id), {
            conversations: existing.conversations,
            outcome: existing.outcome,
            touchedAt: ctx.now,
        }, {
            conversations: JSON.stringify(next.conversations),
            outcome: typeof next.outcome === "string"
                ? next.outcome
                : next.outcome === undefined || next.outcome === null
                    ? null
                    : JSON.stringify(next.outcome),
            touchedAt: ctx.now,
        }, ctx.now);
        db.raw()
            .prepare("UPDATE inquiries SET conversations = ?, outcome = ?, touchedAt = ? WHERE id = ?")
            .run(JSON.stringify(next.conversations), typeof next.outcome === "string"
            ? next.outcome
            : next.outcome === undefined || next.outcome === null
                ? null
                : JSON.stringify(next.outcome), ctx.now, existing.id);
    }
    return existing.id;
}
function applyRole(db, inquiryId, entityId, role, reason, changeId, now) {
    const existing = db
        .raw()
        .prepare("SELECT id, role, reason FROM roles WHERE inquiryId = ? AND entityId = ?")
        .get(inquiryId, entityId);
    if (existing === undefined) {
        const inserted = db
            .raw()
            .prepare("INSERT INTO roles (inquiryId, entityId, role, reason) VALUES (?, ?, ?, ?)")
            .run(inquiryId, entityId, role, reason ?? null);
        writeVersion(db, changeId, "roles", String(inserted.lastInsertRowid), null, { id: Number(inserted.lastInsertRowid), inquiryId, entityId, role, reason: reason ?? null }, now);
        return;
    }
    if (existing.role === role && existing.reason === (reason ?? null))
        return;
    writeVersion(db, changeId, "roles", String(existing.id), existing, { ...existing, role, reason: reason ?? null }, now);
    db.raw()
        .prepare("UPDATE roles SET role = ?, reason = ? WHERE id = ?")
        .run(role, reason ?? null, existing.id);
}
function applyEntity(db, input, type, typesById, changeId, now, errors) {
    const rootId = familyRootId(typesById, type.id);
    // Match: explicit id, else any identity key within the type family.
    // Name similarity never matches.
    let existing;
    if (input.id !== undefined) {
        existing = db
            .raw()
            .prepare("SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ? AND archived = 0")
            .get(input.id);
        if (existing === undefined) {
            errors.push(`entity "${input.name}" references unknown id "${input.id}"`);
            return undefined;
        }
    }
    else {
        for (const [key, value] of Object.entries(input.keys)) {
            const normalized = normalizeKey(key, value);
            if (normalized === "")
                continue;
            // Deliberate: the key NAME and the normalized value must both
            // match. `phone:555-0100` and `tel:555-0100` are different
            // claims and never merge an entity on their own.
            const match = db
                .raw()
                .prepare(`SELECT e.id, e.typeId, e.name, e.keys, e.fields, e.attributes, e.cls, e.indexedAt, e.archived
					 FROM entity_keys k JOIN entities e ON e.id = k.entityId
					 WHERE k.typeFamilyRoot = ? AND k.key = ? AND k.normalized = ? AND e.archived = 0`)
                .get(rootId, key, normalized);
            if (match !== undefined) {
                existing = match;
                break;
            }
        }
    }
    if (existing === undefined) {
        const id = randomUUID();
        const keyNames = Object.keys(input.keys);
        db.raw()
            .prepare("INSERT INTO entities (id, typeId, name, keys, fields, attributes, indexedAt) VALUES (?, ?, ?, ?, ?, ?, NULL)")
            .run(id, type.id, input.name, JSON.stringify(keyNames), JSON.stringify(input.fields), JSON.stringify(input.attributes ?? {}));
        for (const [key, value] of Object.entries(input.keys)) {
            insertKey(db, id, rootId, key, value);
        }
        const stored = {
            id,
            typeId: type.id,
            name: input.name,
            keys: JSON.stringify(keyNames),
            fields: JSON.stringify(input.fields),
            attributes: JSON.stringify(input.attributes ?? {}),
            cls: "normal",
            indexedAt: null,
            archived: 0,
        };
        writeVersion(db, changeId, "entities", id, null, stored, now);
        return id;
    }
    // Update: merge fields, add any new identity keys.
    const storedFields = JSON.parse(existing.fields);
    const nextFields = { ...storedFields, ...input.fields };
    const storedAttributes = JSON.parse(existing.attributes);
    const nextAttributes = { ...storedAttributes, ...(input.attributes ?? {}) };
    const storedKeyNames = new Set(JSON.parse(existing.keys));
    for (const [key, value] of Object.entries(input.keys)) {
        storedKeyNames.add(key);
        const normalized = normalizeKey(key, value);
        const present = db
            .raw()
            .prepare("SELECT id FROM entity_keys WHERE entityId = ? AND key = ? AND normalized = ?")
            .get(existing.id, key, normalized);
        if (present === undefined) {
            const row = insertKey(db, existing.id, rootId, key, value);
            writeVersion(db, changeId, "entity_keys", String(row.id), null, row, now);
        }
    }
    const next = {
        ...existing,
        typeId: type.id,
        name: input.name,
        keys: JSON.stringify([...storedKeyNames]),
        fields: JSON.stringify(nextFields),
        attributes: JSON.stringify(nextAttributes),
        // indexedAt is the mirror's stamp (recall.index succeeded at that
        // instant): a new version leaves it BEHIND so the next idle pass
        // retries the index. Never stamped here.
        indexedAt: existing.indexedAt,
    };
    const changed = next.fields !== existing.fields ||
        next.attributes !== existing.attributes ||
        next.keys !== existing.keys ||
        next.name !== existing.name ||
        next.typeId !== existing.typeId;
    if (changed) {
        writeVersion(db, changeId, "entities", existing.id, existing, next, now);
        db.raw()
            .prepare("UPDATE entities SET typeId = ?, name = ?, keys = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?")
            .run(next.typeId, next.name, next.keys, next.fields, next.attributes, next.indexedAt, existing.id);
    }
    return existing.id;
}
function insertKey(db, entityId, rootId, key, value) {
    const normalized = normalizeKey(key, value);
    const inserted = db
        .raw()
        .prepare("INSERT INTO entity_keys (entityId, typeFamilyRoot, key, normalized) VALUES (?, ?, ?, ?)")
        .run(entityId, rootId, key, normalized);
    return {
        id: Number(inserted.lastInsertRowid),
        entityId,
        typeFamilyRoot: rootId,
        key,
        normalized,
    };
}
/**
 * Move entities to a different type: field values the new type does not
 * declare move into attributes, and identity keys re-root at the new
 * type's family.
 */
export function retypeEntities(db, entityIds, toType, changeId, now) {
    db.transaction(() => {
        const typesByName = loadTypes(db);
        const target = typesByName.get(toType);
        if (target === undefined) {
            throw new Error(`retypeEntities: unknown type "${toType}"`);
        }
        const typesById = new Map();
        for (const type of typesByName.values())
            typesById.set(type.id, type);
        const rootId = familyRootId(typesById, target.id);
        const declared = new Set(target.fields.map((field) => field.name));
        for (const entityId of entityIds) {
            const entity = db
                .raw()
                .prepare("SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ?")
                .get(entityId);
            if (entity === undefined)
                continue;
            const fields = JSON.parse(entity.fields);
            const attributes = JSON.parse(entity.attributes);
            const kept = {};
            for (const [name, field] of Object.entries(fields)) {
                if (declared.has(name)) {
                    kept[name] = field;
                }
                else {
                    attributes[name] = field;
                }
            }
            const next = {
                ...entity,
                typeId: target.id,
                fields: JSON.stringify(kept),
                attributes: JSON.stringify(attributes),
                // re-typing leaves indexedAt behind: the next idle pass re-indexes.
                indexedAt: entity.indexedAt,
            };
            writeVersion(db, changeId, "entities", entity.id, entity, next, now);
            db.raw()
                .prepare("UPDATE entities SET typeId = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?")
                .run(next.typeId, next.fields, next.attributes, next.indexedAt, entity.id);
            db.raw()
                .prepare("UPDATE entity_keys SET typeFamilyRoot = ? WHERE entityId = ?")
                .run(rootId, entity.id);
        }
    });
}
