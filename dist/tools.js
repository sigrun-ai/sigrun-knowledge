import { Type } from "@earendil-works/pi-ai";
import { defineTool, } from "@earendil-works/pi-durable";
import { audienceCovers } from "./audience.js";
import { applyRecord } from "./apply.js";
import { TypeDefSchema } from "./schema.js";
import { effectiveFields } from "./schema.js";
import { mirrorEntities } from "./mirror.js";
const MAX_QUERIES = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
function output(text) {
    return { output: [{ type: "text", text }] };
}
function error(text) {
    return { isError: true, output: [{ type: "text", text }] };
}
/** The fork-ancestry lookup: page the fork's entries newest-first until
 * an entry stamped with a DIFFERENT conversation id appears — that is the
 * reviewed parent. None (a plain conversation) → the id itself. */
async function parentConversation(host, conversationId) {
    let cursor;
    for (;;) {
        const page = await host.conversations.entries(conversationId, { order: "descending" }, 50, cursor);
        for (const entry of page.items) {
            if (entry.conversationId !== conversationId) {
                return entry.conversationId;
            }
        }
        if (page.next === undefined)
            return conversationId;
        cursor = page.next;
    }
}
function loadEntities(db) {
    return db
        .raw()
        .prepare(`SELECT e.id, e.typeId, e.name, e.keys, e.fields, e.attributes, e.cls, e.indexedAt, e.archived,
			        t.name AS typeName, t.parentId AS typeParentId, t.fields AS typeFields
			   FROM entities e JOIN types t ON t.id = e.typeId
			  WHERE e.archived = 0`)
        // SAFETY: the SELECT column list is fixed by the SQL literal above and
        // matches StoredEntity's fields exactly; node:sqlite types rows
        // generically.
        .all();
}
/** All type ids in the family rooted-or-descended from `typeName`
 * (type includes child types). */
function familyTypeIds(db, typeName) {
    const types = db
        .raw()
        .prepare("SELECT id, parentId FROM types WHERE archived = 0")
        .all();
    const root = db
        .raw()
        .prepare("SELECT id FROM types WHERE name = ? AND archived = 0")
        .get(typeName);
    if (root === undefined)
        return new Set();
    const result = new Set([root.id]);
    for (;;) {
        let grew = false;
        for (const type of types) {
            if (type.parentId !== null &&
                result.has(type.parentId) &&
                !result.has(type.id)) {
                result.add(type.id);
                grew = true;
            }
        }
        if (!grew)
            return result;
    }
}
function formatValue(value) {
    if (typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof value.amount === "number") {
        const money = value;
        return `${money.amount} ${money.currency}`;
    }
    if (Array.isArray(value))
        return value.map(formatValue).join(", ");
    return String(value);
}
function compareField(field, op, want) {
    if (field === undefined)
        return false;
    const value = field.value;
    // Money compares amounts within one currency only: a different
    // currency never satisfies lt/gt/eq (a 30 USD fee is not under 50 CAD).
    const isMoney = (v) => typeof v === "object" &&
        v !== null &&
        !Array.isArray(v) &&
        typeof v.amount === "number";
    if (isMoney(value) || isMoney(want)) {
        if (!isMoney(value) || !isMoney(want))
            return false;
        if (value.currency.toUpperCase() !== want.currency.toUpperCase())
            return false;
        switch (op) {
            case "eq":
                return value.amount === want.amount;
            case "lt":
                return value.amount < want.amount;
            case "gt":
                return value.amount > want.amount;
            case "contains":
                return false;
        }
    }
    switch (op) {
        case "eq":
            return JSON.stringify(value) === JSON.stringify(want);
        case "lt":
            return (typeof value === "number" &&
                typeof want === "number" &&
                value < want);
        case "gt":
            return (typeof value === "number" &&
                typeof want === "number" &&
                value > want);
        case "contains": {
            if (Array.isArray(value)) {
                return value.some((item) => JSON.stringify(item) === JSON.stringify(want));
            }
            if (typeof value === "string" && typeof want === "string") {
                return value.toLowerCase().includes(want.toLowerCase());
            }
            return false;
        }
    }
}
function likeFallback(db, text) {
    const pattern = `%${text.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    const rows = db
        .raw()
        .prepare(`SELECT e.id FROM entities e
			  WHERE e.archived = 0 AND (
			        e.name LIKE ? ESCAPE '\\' OR
			        e.keys LIKE ? ESCAPE '\\' OR
			        e.fields LIKE ? ESCAPE '\\')`)
        .all(pattern, pattern, pattern);
    return new Set(rows.map((row) => row.id));
}
function renderEntity(db, row, now) {
    // Inherited fields carry their defs (horizonDays) down the hierarchy.
    const typeRows = db
        .raw()
        .prepare("SELECT id, parentId, fields FROM types")
        // SAFETY: the types table columns are fixed by db.ts's schema;
        // node:sqlite types rows generically.
        .all();
    const typeFields = effectiveFields(new Map(typeRows.map((type) => [type.id, type])), row.typeId);
    const fields = JSON.parse(row.fields);
    const lines = [`${row.typeName} — ${row.name}`];
    for (const [name, field] of Object.entries(fields)) {
        const def = typeFields.find((candidate) => candidate.name === name);
        const observedDate = field.observedAt.slice(0, 10);
        const observedMs = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(field.observedAt)
            ? `${field.observedAt}T00:00:00Z`
            : field.observedAt);
        let observed = `observed ${observedDate}`;
        if (def?.horizonDays !== undefined &&
            !Number.isNaN(observedMs) &&
            now - observedMs > def.horizonDays * DAY_MS) {
            observed += ", stale";
        }
        lines.push(`  ${name}: ${formatValue(field.value)} (${observed}, ${field.source})`);
    }
    const roles = db
        .raw()
        .prepare(`SELECT i.question AS question, r.role AS role, r.reason AS reason
			   FROM roles r JOIN inquiries i ON i.id = r.inquiryId
			  WHERE r.entityId = ? AND i.archived = 0
			  ORDER BY i.question`)
        .all(row.id);
    for (const role of roles) {
        const reason = role.reason === null ? "" : ` — ${role.reason}`;
        lines.push(`  ${role.question}: ${role.role}${reason}`);
    }
    return lines.join("\n");
}
export function createTools(deps) {
    const record = defineTool({
        name: "knowledge_record",
        description: "Record a curated knowledge update: an inquiry, any new or extended types, and the entities with their roles and cited fields, applied atomically.",
        parameters: Type.Object({
            inquiry: Type.Optional(Type.Object({
                id: Type.Optional(Type.String()),
                question: Type.String(),
                why: Type.Optional(Type.String()),
                outcome: Type.Optional(Type.Object({
                    status: Type.Union([
                        Type.Literal("open"),
                        Type.Literal("decided"),
                        Type.Literal("abandoned"),
                    ]),
                    what: Type.Optional(Type.String()),
                })),
            })),
            types: Type.Optional(Type.Array(TypeDefSchema, { maxItems: 10 })),
            entities: Type.Array(Type.Object({
                id: Type.Optional(Type.String()),
                type: Type.String(),
                name: Type.String(),
                keys: Type.Record(Type.String(), Type.String()),
                fields: Type.Record(Type.String(), Type.Object({
                    value: Type.Unknown(),
                    source: Type.String(),
                    observedAt: Type.String(),
                })),
                attributes: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
                role: Type.Optional(Type.Union([
                    Type.Literal("candidate"),
                    Type.Literal("shortlisted"),
                    Type.Literal("rejected"),
                    Type.Literal("chosen"),
                ])),
                reason: Type.Optional(Type.String()),
            }), { maxItems: 50 }),
        }),
        replay: "safe",
        async execute(args, api) {
            const conversationId = Number(api.conversationId);
            const user = await deps.host.identity.actingUser(conversationId);
            if (user === undefined) {
                return error("knowledge_record needs a user (the conversation owner).");
            }
            const parentId = await parentConversation(deps.host, conversationId);
            const db = deps.dbForUser(user);
            // Replay: applyRecord caches by callId; a replayed result must NOT
            // re-mirror (idempotent end to end, plan Review Focus 5).
            const replayed = db
                .raw()
                .prepare("SELECT result FROM applied WHERE callId = ?")
                // SAFETY: `applied.result` is a TEXT column written as JSON by
                // applyRecord; node:sqlite types rows generically.
                .get(api.callId);
            const result = applyRecord(db, args, {
                conversationId: parentId,
                callId: api.callId,
                now: deps.now(),
            });
            if (result.errors.length > 0) {
                return error(result.errors.join("\n"));
            }
            if (replayed === undefined) {
                await mirrorEntities(deps.host, db, user, result.touched, deps.now());
            }
            return {
                output: [{ type: "text", text: result.summary }],
                details: {
                    curation: {
                        changeId: result.changeId,
                        summary: result.summary,
                    },
                },
            };
        },
    });
    const find = defineTool({
        name: "knowledge_find",
        description: "Search curated knowledge: types, entities (with their cited fields, roles and inquiries) by type, field comparison, inquiry question or text.",
        parameters: Type.Object({
            queries: Type.Array(Type.Object({
                text: Type.Optional(Type.String()),
                type: Type.Optional(Type.String()),
                field: Type.Optional(Type.Object({
                    name: Type.String(),
                    op: Type.Union([
                        Type.Literal("eq"),
                        Type.Literal("lt"),
                        Type.Literal("gt"),
                        Type.Literal("contains"),
                    ]),
                    value: Type.Unknown(),
                })),
                inquiry: Type.Optional(Type.String()),
            }), { minItems: 1, maxItems: MAX_QUERIES }),
        }),
        replay: "safe",
        async execute(args, api, context) {
            const conversationId = Number(api.conversationId);
            const meta = await deps.host.conversations.meta(conversationId);
            const user = await deps.host.identity.actingUser(conversationId);
            if (user === undefined || !audienceCovers(meta, { owner: user })) {
                return output("Not available here.");
            }
            const db = deps.dbForUser(user);
            const all = loadEntities(db);
            const lines = [];
            for (const query of args.queries) {
                let candidates = all.filter((row) => row.cls !== "local-only");
                if (query.type !== undefined) {
                    const family = familyTypeIds(db, query.type);
                    candidates = candidates.filter((row) => family.has(row.typeId));
                }
                if (query.field !== undefined) {
                    const wanted = query.field;
                    candidates = candidates.filter((row) => {
                        const fields = JSON.parse(row.fields);
                        return compareField(fields[wanted.name], wanted.op, wanted.value);
                    });
                }
                if (query.inquiry !== undefined) {
                    const needle = query.inquiry.toLowerCase();
                    const ids = new Set(db
                        .raw()
                        .prepare(`SELECT r.entityId FROM roles r JOIN inquiries i ON i.id = r.inquiryId
									  WHERE i.archived = 0 AND lower(i.question) LIKE ?`)
                        .all(`%${needle.replace(/[%_]/g, (c) => `\\${c}`)}%`).map((row) => row.entityId));
                    candidates = candidates.filter((row) => ids.has(row.id));
                }
                if (query.text !== undefined) {
                    let ids;
                    const model = (await api.agent(context)).model;
                    let searched = false;
                    try {
                        const result = await deps.host.publishedHooks.call("recall.search", {
                            query: query.text,
                            kinds: ["doc"],
                            model: model === undefined
                                ? undefined
                                : { provider: model.provider, modelId: model.modelId },
                        }, { user, conversationId });
                        if (result.status === "ok") {
                            searched = true;
                            const hits = result.value
                                ?.hits ?? [];
                            ids = new Set(hits
                                .filter((hit) => hit.provider === "knowledge")
                                .map((hit) => hit.id)
                                .filter((id) => typeof id === "string"));
                        }
                    }
                    catch (error) {
                        console.error("knowledge: recall.search failed", error);
                    }
                    if (!searched) {
                        ids = likeFallback(db, query.text);
                    }
                    candidates = candidates.filter((row) => ids.has(row.id));
                }
                if (candidates.length === 0) {
                    lines.push("No matching knowledge.");
                }
                else {
                    for (const row of candidates) {
                        lines.push(renderEntity(db, row, deps.now()));
                    }
                }
            }
            return output(lines.join("\n\n"));
        },
    });
    return [record, find];
}
