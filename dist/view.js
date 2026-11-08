/**
 * The read-only Knowledge view. It reads only the calling principal's store,
 * and only after checking that the store file already exists: rendering must
 * never create a database for a user who has no knowledge yet.
 */
import { existsSync } from "node:fs";
import { entitiesOfType, entityDetail, effectiveTypeFields, inquiries, typeTree, } from "./view-read.js";
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function paramsOf(ctx) {
    const params = ctx.params;
    return {
        ...(typeof params.type === "number" && Number.isInteger(params.type) ? { type: params.type } : {}),
        ...(typeof params.entity === "string" ? { entity: params.entity } : {}),
        ...(params.inquiries === true ? { inquiries: true } : {}),
        ...(typeof params.inquiry === "number" && Number.isInteger(params.inquiry) ? { inquiry: params.inquiry } : {}),
        ...(params.archived === true ? { archived: true } : {}),
        ...(typeof params.q === "string" ? { q: params.q } : {}),
    };
}
function itemIdOf(payload) {
    if (!isObject(payload) || typeof payload.itemId !== "string")
        return undefined;
    return payload.itemId;
}
function navigate(params) {
    // SAFETY: KnowledgeParams contains only JSON-compatible navigation values.
    return { ok: true, navigate: { type: "navigate", params: params } };
}
function noneTree() {
    return {
        v: 1,
        root: {
            type: "page",
            id: "knowledge-root",
            title: "Knowledge",
            main: [{ type: "markdown", text: "Sign in to see your knowledge." }],
        },
    };
}
/** The view surface, over the factory's per-user database opener. */
export function createKnowledgeView(deps) {
    function read(ctx) {
        const user = ctx.principal.user;
        if (user === undefined)
            return { data: emptyData(paramsOf(ctx)), access: "none" };
        const params = paramsOf(ctx);
        if (!(deps.storeExists ?? ((who) => existsSync(deps.storePath(who))))(user)) {
            return { data: emptyData(params), access: "write" };
        }
        const db = deps.dbForUser(user).raw();
        const entity = params.entity === undefined ? undefined : entityDetail(db, params.entity, deps.now());
        const inquiryRows = inquiries(db, { includeArchived: params.archived === true });
        return {
            // "write" permits the edit-shaped drill-in dispatches; handlers
            // only navigate and the data layer remains strictly read-only.
            access: "write",
            data: {
                types: typeTree(db, { includeArchived: params.archived === true }),
                entities: params.type === undefined
                    ? []
                    : entitiesOfType(db, params.type, { search: params.q ?? "", limit: 200 }),
                ...(entity === undefined ? {} : { entity }),
                ...(params.type === undefined
                    ? {}
                    : {
                        typeFields: effectiveTypeFields(db, params.type).map((field) => ({
                            label: field.name,
                            value: `${field.type}${field.horizonDays === undefined ? "" : ` · stale after ${field.horizonDays} days`}`,
                        })),
                    }),
                inquiries: params.inquiries === true ? inquiryRows : [],
                ...(params.inquiry === undefined
                    ? {}
                    : { inquiry: inquiryRows.find((row) => row.id === params.inquiry) }),
                params,
            },
        };
    }
    function caller(ctx) {
        return ctx.principal.user === undefined
            ? { ok: false, error: { message: "sign in to use the Knowledge view" } }
            : undefined;
    }
    function rowAction(ctx, payload, name) {
        const rejected = caller(ctx);
        if (rejected !== undefined)
            return rejected;
        const itemId = itemIdOf(payload);
        const params = paramsOf(ctx);
        if (name === "openType") {
            if (itemId === "inquiries") {
                return navigate({ ...(params.archived === true ? { archived: true } : {}), inquiries: true });
            }
            const id = itemId?.match(/^type:(\d+)$/)?.[1];
            return id === undefined
                ? { ok: false, error: { message: "invalid openType row id" } }
                : navigate({ type: Number(id), ...(params.archived === true ? { archived: true } : {}) });
        }
        if (name === "openEntity") {
            const id = itemId?.match(/^entity:(.+)$/)?.[1];
            return id === undefined
                ? { ok: false, error: { message: "invalid openEntity row id" } }
                : navigate({ entity: id, ...(params.archived === true ? { archived: true } : {}) });
        }
        const id = itemId?.match(/^inquiry:(\d+)$/)?.[1];
        return id === undefined
            ? { ok: false, error: { message: "invalid openInquiry row id" } }
            : navigate({
                inquiries: true,
                inquiry: Number(id),
                ...(params.archived === true ? { archived: true } : {}),
            });
    }
    return {
        id: "knowledge",
        title: "Knowledge",
        icon: "folder",
        placement: "view",
        instanceKey: (params, principal) => JSON.stringify([principal.user ?? "", params]),
        render: async (ctx) => {
            const { data, access } = read(ctx);
            return {
                tree: viewTree(data, access),
                // SAFETY: the view data is a JSON-only mirror of the read model.
                data: data,
                access,
            };
        },
        data: async (ctx) => {
            const { data, access } = read(ctx);
            // SAFETY: the view data is a JSON-only mirror of the read model.
            return { data: data, access };
        },
        actions: {
            openType: async (ctx, payload) => rowAction(ctx, payload, "openType"),
            openEntity: async (ctx, payload) => rowAction(ctx, payload, "openEntity"),
            openInquiry: async (ctx, payload) => rowAction(ctx, payload, "openInquiry"),
            search: async (ctx, payload) => {
                const rejected = caller(ctx);
                if (rejected !== undefined)
                    return rejected;
                const values = isObject(payload) && isObject(payload.values) ? payload.values : payload;
                const q = isObject(values) && typeof values.q === "string" ? values.q.trim() : "";
                const params = paramsOf(ctx);
                return navigate({
                    ...(params.type === undefined ? {} : { type: params.type }),
                    ...(q === "" ? {} : { q }),
                    ...(params.archived === true ? { archived: true } : {}),
                });
            },
        },
    };
}
function emptyData(params) {
    return { types: [], entities: [], inquiries: [], params };
}
function flattenTypes(nodes, depth = 0) {
    return nodes.flatMap((node) => [
        {
            id: `type:${node.id}`,
            title: `${"  ".repeat(depth)}${node.name}`,
            meta: String(node.totalCount),
            archived: node.archived ? "archived" : "",
        },
        ...flattenTypes(node.children, depth + 1),
    ]);
}
function viewTree(data, access) {
    if (access === "none")
        return noneTree();
    const sidebar = [
        {
            type: "collection",
            id: "types",
            display: "list",
            items: [
                ...flattenTypes(data.types),
                { id: "inquiries", title: "Inquiries" },
            ],
            onActivate: { type: "edit", name: "openType" },
            item: { title: { $: "./title" }, meta: [{ text: { $: "./meta" } }] },
        },
    ];
    const main = [];
    if (data.params.entity !== undefined)
        main.push(...entityBlocks(data.entity));
    else if (data.params.inquiry !== undefined)
        main.push(...inquiryBlocks(data.inquiry));
    else if (data.params.inquiries === true)
        main.push(inquiriesBlock(data.inquiries));
    else if (data.params.type !== undefined)
        main.push(...typeBlocks(data));
    else
        main.push({ type: "markdown", text: "Select a type or Inquiries." });
    if (data.types.length === 0 && data.params.entity === undefined && data.params.type === undefined && data.params.inquiries === undefined) {
        main.length = 0;
        main.push({
            type: "markdown",
            text: "No knowledge yet. Curator reviews record knowledge from your conversations.",
        });
    }
    const params = data.params;
    const tree = {
        v: 1,
        root: {
            type: "page",
            id: "knowledge-root",
            title: "Knowledge",
            actions: [
                {
                    id: "toggle-archived",
                    label: params.archived === true ? "Hide archived" : "Show archived",
                    action: {
                        type: "navigate",
                        params: params.archived === true ? withoutArchived(params) : { ...params, archived: true },
                    },
                },
            ],
            sidebar,
            main,
        },
    };
    // SAFETY: this JSON literal is checked by validateTree in the surface tests.
    return tree;
}
function withoutArchived(params) {
    const { archived: _archived, ...rest } = params;
    return rest;
}
function typeBlocks(data) {
    return [
        {
            type: "fields",
            id: "fields",
            rows: fieldDefinitionRows(data),
        },
        {
            type: "collection",
            id: "entities",
            display: "table",
            items: data.entities.map((row) => ({
                id: `entity:${row.id}`,
                name: row.name,
                type: row.type,
                localOnly: row.localOnly ? "local-only" : "",
            })),
            item: { title: { $: "./name" } },
            columns: [
                { field: "name", label: "Name" },
                { field: "type", label: "Type" },
                { field: "localOnly", label: "Local only", cell: "badge" },
            ],
            onActivate: { type: "edit", name: "openEntity" },
        },
        {
            type: "form",
            id: "search",
            bind: "/search",
            mode: "submit",
            onSubmit: "search",
            submitLabel: "Search",
            children: [{ type: "text", name: "q", label: "Search entities", kind: "search" }],
        },
    ];
}
function fieldDefinitionRows(data) {
    return data.typeFields ?? [];
}
function entityBlocks(entity) {
    if (entity === undefined)
        return [{ type: "markdown", text: "Not found" }];
    return [
        {
            type: "fields",
            id: "entity-summary",
            rows: [
                { label: "Name", value: entity.name },
                { label: "Type", value: entity.type },
                ...(entity.localOnly ? [{ label: "Class", value: "local-only", tone: "warn" }] : []),
            ],
        },
        {
            type: "fields",
            id: "entity-fields",
            rows: entity.fields.map((field) => ({
                label: field.name,
                value: `${field.value} · ${field.source} · ${field.observedAt}`,
                ...(field.stale ? { tone: "warn" } : {}),
            })),
        },
        {
            type: "fields",
            id: "keys",
            rows: entity.keys.map((key) => ({ label: `${key.name} (normalized)`, value: key.normalized })),
        },
        {
            type: "fields",
            id: "attributes",
            rows: entity.attributes.map((attribute) => ({ label: attribute.name, value: attribute.value })),
        },
        {
            type: "collection",
            id: "roles",
            display: "list",
            items: entity.roles.map((role) => ({
                id: `inquiry:${role.inquiryId}`,
                question: role.question,
                role: role.role,
                reason: role.reason ?? "",
            })),
            item: {
                title: { $: "./question" },
                subtitle: { $: "./role" },
                body: { $: "./reason" },
            },
            onActivate: { type: "edit", name: "openInquiry" },
        },
        {
            type: "section",
            id: "history",
            title: "History",
            children: entity.history.map((version) => ({
                type: "section",
                id: `history-${version.changeId}`,
                title: `${version.label} · ${new Date(version.at).toISOString()}`,
                children: [{ type: "diff", before: version.before, after: version.after, lang: "json" }],
            })),
        },
    ];
}
function inquiriesBlock(rows) {
    return {
        type: "collection",
        id: "inquiries",
        display: "list",
        items: rows.map((row) => ({
            id: `inquiry:${row.id}`,
            question: row.question,
            why: row.why ?? "",
            outcome: row.outcome ?? "",
            archived: row.archived ? "archived" : "",
        })),
        item: {
            title: { $: "./question" },
            subtitle: { $: "./why" },
            body: { $: "./outcome" },
            badges: [{ text: { $: "./archived" }, tone: "neutral" }],
        },
        onActivate: { type: "edit", name: "openInquiry" },
    };
}
function inquiryBlocks(inquiry) {
    if (inquiry === undefined)
        return [{ type: "markdown", text: "Not found" }];
    return [
        {
            type: "fields",
            id: "inquiry-detail",
            rows: [
                { label: "Question", value: inquiry.question },
                { label: "Why", value: inquiry.why ?? "" },
                { label: "Outcome", value: inquiry.outcome ?? "" },
            ],
        },
        {
            type: "section",
            id: "conversations",
            title: "Conversations",
            children: inquiry.conversations.map((id) => ({
                type: "callout",
                id: `conversation-${id}`,
                title: `Conversation ${id}`,
                tone: "neutral",
                actions: [
                    {
                        id: `conversation-${id}-open`,
                        label: `Conversation ${id}`,
                        action: { type: "navigate", target: { conversation: id } },
                    },
                ],
            })),
        },
        {
            type: "collection",
            id: "inquiry-entities",
            display: "list",
            items: inquiry.entities.map((entity) => ({
                id: `entity:${entity.id}`,
                name: entity.name,
                role: entity.role,
            })),
            item: { title: { $: "./name" }, subtitle: { $: "./role" } },
            onActivate: { type: "edit", name: "openEntity" },
        },
    ];
}
