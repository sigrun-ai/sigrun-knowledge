import { effectiveFields, } from "./schema.js";
const DAY_MS = 24 * 60 * 60 * 1000;
function parseObserved(observedAt) {
    const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(observedAt)
        ? `${observedAt}T00:00:00Z`
        : observedAt);
    return Number.isNaN(parsed) ? null : parsed;
}
function types(db, includeArchived = false) {
    // SAFETY: fixed schema columns; only the archived predicate is selected.
    // SAFETY: the result rows match TypeRow.
    const statement = includeArchived
        ? "SELECT id, name, description, parentId, fields, archived FROM types ORDER BY name, id"
        : "SELECT id, name, description, parentId, fields, archived FROM types WHERE archived = 0 ORDER BY name, id";
    return db.prepare(statement).all();
}
function descendantIds(rows, typeId) {
    const children = new Map();
    for (const row of rows) {
        if (row.parentId === null)
            continue;
        const siblings = children.get(row.parentId) ?? [];
        siblings.push(row.id);
        children.set(row.parentId, siblings);
    }
    const ids = new Set();
    const pending = [typeId];
    while (pending.length > 0) {
        const id = pending.pop();
        if (ids.has(id))
            continue;
        ids.add(id);
        pending.push(...(children.get(id) ?? []));
    }
    return ids;
}
export function typeTree(db, opts) {
    const rows = types(db, opts.includeArchived);
    // SAFETY: fixed schema columns; count is grouped by typeId.
    const counts = db
        .prepare("SELECT typeId, COUNT(*) AS count FROM entities WHERE archived = 0 GROUP BY typeId")
        .all();
    const countByType = new Map(counts.map((row) => [row.typeId, row.count]));
    const nodes = new Map();
    for (const row of rows) {
        nodes.set(row.id, {
            id: row.id,
            name: row.name,
            description: row.description,
            archived: row.archived !== 0,
            ownCount: countByType.get(row.id) ?? 0,
            totalCount: 0,
            children: [],
        });
    }
    const roots = [];
    for (const row of rows) {
        const node = nodes.get(row.id);
        const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
        if (parent === undefined)
            roots.push(node);
        else
            parent.children.push(node);
    }
    function total(node) {
        node.totalCount = node.children.reduce((sum, child) => sum + total(child), node.ownCount);
        return node.totalCount;
    }
    for (const root of roots)
        total(root);
    return roots;
}
/** Effective field definitions for a type, including archived ancestors. */
export function effectiveTypeFields(db, typeId) {
    return effectiveFields(new Map(types(db, true).map((type) => [type.id, type])), typeId);
}
export function entitiesOfType(db, typeId, opts) {
    const family = descendantIds(types(db, true), typeId);
    // SAFETY: fixed schema columns; search is bound and escaped.
    const rows = db
        .prepare(`SELECT e.id, e.name, e.cls, t.id AS typeId, t.name AS type
			 FROM entities e JOIN types t ON t.id = e.typeId
			 WHERE e.archived = 0 AND lower(e.name) LIKE ? ESCAPE '\\'
			 ORDER BY e.name, e.id`)
        .all(`%${opts.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return rows
        .filter((row) => family.has(row.typeId))
        .slice(0, opts.limit)
        .map((row) => ({
        id: row.id,
        name: row.name,
        type: row.type,
        localOnly: row.cls === "local-only",
    }));
}
export function displayValue(value) {
    if (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.amount === "number" &&
        typeof value.currency === "string") {
        const money = value;
        return `${money.amount.toFixed(2)} ${money.currency}`;
    }
    if (Array.isArray(value))
        return value.map(displayValue).join(", ");
    if (typeof value === "boolean")
        return value ? "yes" : "no";
    if (typeof value === "object" && value !== null)
        return JSON.stringify(value);
    return String(value);
}
function historyBlob(value) {
    if (value === null)
        return "";
    const parsed = JSON.parse(value);
    for (const key of ["fields", "attributes", "keys"]) {
        if (typeof parsed[key] === "string") {
            parsed[key] = JSON.parse(parsed[key]);
        }
    }
    return JSON.stringify(parsed, null, 2);
}
export function entityDetail(db, id, now) {
    // SAFETY: fixed schema columns; entity id is bound.
    const row = db
        .prepare(`SELECT e.id, e.name, e.typeId, e.fields, e.attributes, e.cls, t.name AS type
			 FROM entities e JOIN types t ON t.id = e.typeId
			 WHERE e.id = ? AND e.archived = 0`)
        .get(id);
    if (row === undefined)
        return undefined;
    const fields = effectiveTypeFields(db, row.typeId);
    const fieldViews = Object.entries(JSON.parse(row.fields)).map(([name, field]) => {
        const def = fields.find((candidate) => candidate.name === name);
        const observedMs = parseObserved(field.observedAt);
        return {
            name,
            value: displayValue(field.value),
            source: field.source,
            observedAt: field.observedAt,
            stale: def?.horizonDays !== undefined &&
                observedMs !== null &&
                now - observedMs > def.horizonDays * DAY_MS,
        };
    });
    // SAFETY: fixed schema columns; entity id is bound.
    const keys = db
        .prepare("SELECT key AS name, normalized FROM entity_keys WHERE entityId = ? ORDER BY key, normalized")
        .all(id);
    // SAFETY: fixed schema columns; entity id is bound.
    const roles = db
        .prepare(`SELECT i.id AS inquiryId, i.question, r.role, r.reason
			 FROM roles r JOIN inquiries i ON i.id = r.inquiryId
			 WHERE r.entityId = ? AND i.archived = 0 ORDER BY i.question, i.id`)
        .all(id);
    // SAFETY: fixed schema columns; table and row id are bound.
    const history = db
        .prepare('SELECT changeId, before, after, at FROM versions WHERE "table" = ? AND rowId = ? ORDER BY seq DESC LIMIT 20')
        .all("entities", id);
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        localOnly: row.cls === "local-only",
        keys,
        fields: fieldViews,
        attributes: Object.entries(JSON.parse(row.attributes)).map(([name, value]) => ({ name, value: displayValue(value) })),
        roles,
        history: history.map((version) => ({
            changeId: version.changeId,
            at: version.at,
            before: historyBlob(version.before),
            after: historyBlob(version.after),
            label: version.before === null
                ? "created"
                : version.after === null
                    ? "archived"
                    : JSON.parse(version.after).archived === 1 &&
                        JSON.parse(version.before).archived !== 1
                        ? "archived"
                        : "changed",
        })),
    };
}
export function inquiries(db, opts) {
    // SAFETY: fixed schema columns; only the archived predicate is selected.
    // SAFETY: the result rows match the inquiry row shape below.
    const statement = opts.includeArchived
        ? "SELECT id, question, why, outcome, startedAt, touchedAt, archived, conversations FROM inquiries ORDER BY touchedAt DESC, id DESC"
        : "SELECT id, question, why, outcome, startedAt, touchedAt, archived, conversations FROM inquiries WHERE archived = 0 ORDER BY touchedAt DESC, id DESC";
    const rows = db.prepare(statement).all();
    return rows.map((row) => {
        const entities = db
            .prepare(`SELECT e.id, e.name, r.role
				 FROM roles r JOIN entities e ON e.id = r.entityId
				 WHERE r.inquiryId = ? AND e.archived = 0 ORDER BY e.name, e.id`)
            .all(row.id);
        let conversations = [];
        try {
            const parsed = JSON.parse(row.conversations);
            if (Array.isArray(parsed)) {
                conversations = parsed.filter((value) => typeof value === "number");
            }
        }
        catch {
            conversations = [];
        }
        return {
            id: row.id,
            question: row.question,
            why: row.why,
            outcome: row.outcome,
            startedAt: row.startedAt,
            touchedAt: row.touchedAt,
            archived: row.archived !== 0,
            conversations,
            entities,
        };
    });
}
