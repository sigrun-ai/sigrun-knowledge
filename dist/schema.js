import { Type } from "@earendil-works/pi-ai";
const FIELD_TYPES = [
    "string",
    "number",
    "boolean",
    "date",
    "url",
    "money",
    "enum",
    "list",
];
const LIST_ITEM_TYPES = [
    "string",
    "number",
    "boolean",
    "date",
    "url",
    "money",
    "enum",
];
/** Type names are lowercase singular phrases. */
export const TYPE_NAME_PATTERN = /^[a-z][a-z0-9 -]{0,63}$/;
const FieldDefSchema = Type.Object({
    name: Type.String({ minLength: 1 }),
    type: Type.Union(FIELD_TYPES.map((type) => Type.Literal(type))),
    values: Type.Optional(Type.Array(Type.String())),
    item: Type.Optional(Type.Union(LIST_ITEM_TYPES.map((type) => Type.Literal(type)))),
    identity: Type.Optional(Type.Boolean()),
    horizonDays: Type.Optional(Type.Number()),
    description: Type.Optional(Type.String()),
});
export const TypeDefSchema = Type.Object({
    name: Type.String({ pattern: TYPE_NAME_PATTERN.source }),
    description: Type.String(),
    parent: Type.Optional(Type.String({ pattern: TYPE_NAME_PATTERN.source })),
    fields: Type.Array(FieldDefSchema),
});
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
function checkScalar(type, value) {
    switch (type) {
        case "string":
            return typeof value === "string" ? undefined : "expected a string";
        case "number":
            return typeof value === "number" && Number.isFinite(value)
                ? undefined
                : "expected a number";
        case "boolean":
            return typeof value === "boolean" ? undefined : "expected a boolean";
        case "date": {
            if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) {
                return "expected an ISO date (YYYY-MM-DD)";
            }
            const parsed = new Date(`${value}T00:00:00Z`);
            if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
                return "expected a valid calendar date";
            }
            return undefined;
        }
        case "url":
            if (typeof value !== "string")
                return "expected a url string";
            try {
                new URL(value);
                return undefined;
            }
            catch {
                return "expected a valid url";
            }
        case "money":
            return checkMoney(value);
    }
}
function checkMoney(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return "expected money { amount, currency }";
    }
    const raw = value;
    if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount)) {
        return "money amount must be a number";
    }
    if (typeof raw.currency !== "string" ||
        !/^[A-Za-z]{3}$/.test(raw.currency)) {
        return "money currency must be a 3-letter code";
    }
    return undefined;
}
/**
 * Validate one field value against its definition. Returns undefined when
 * the value is valid, otherwise a short human-readable error text.
 */
export function validateValue(def, value) {
    if (def.type === "enum") {
        if (typeof value !== "string")
            return "expected an enum string";
        if (def.values === undefined || !def.values.includes(value)) {
            return `expected one of: ${(def.values ?? []).join(", ")}`;
        }
        return undefined;
    }
    if (def.type === "list") {
        if (!Array.isArray(value))
            return "expected a list";
        const itemType = def.item ?? "string";
        for (const item of value) {
            // Enum items validate as plain strings here; membership lives on
            // the owning def's values, which a list item def does not carry.
            const error = checkScalar(itemType === "enum" ? "string" : itemType, item);
            if (error !== undefined)
                return `list item: ${error}`;
        }
        return undefined;
    }
    return checkScalar(def.type, value);
}
