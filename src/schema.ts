import { Type, type TSchema } from "@earendil-works/pi-ai";

export type FieldType =
	| "string"
	| "number"
	| "boolean"
	| "date"
	| "url"
	| "money"
	| "enum"
	| "list";

export interface FieldDef {
	name: string;
	type: FieldType;
	/** Allowed values when type is "enum". */
	values?: string[];
	/** Item type when type is "list". */
	item?: Exclude<FieldType, "list">;
	/** Identity fields participate in the entity's identity keys. */
	identity?: boolean;
	/** Freshness horizon in days, for fields that age. */
	horizonDays?: number;
	description?: string;
}

export interface TypeDef {
	/** Lowercase singular phrase, e.g. "clinic" or "service visit". */
	name: string;
	description: string;
	/** Parent type name (same hierarchy = one identity family). */
	parent?: string;
	fields: FieldDef[];
}

const FIELD_TYPES: readonly FieldType[] = [
	"string",
	"number",
	"boolean",
	"date",
	"url",
	"money",
	"enum",
	"list",
];

const LIST_ITEM_TYPES: readonly Exclude<FieldType, "list">[] = [
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

export const TypeDefSchema: TSchema = Type.Object({
	name: Type.String({ pattern: TYPE_NAME_PATTERN.source }),
	description: Type.String(),
	parent: Type.Optional(Type.String({ pattern: TYPE_NAME_PATTERN.source })),
	fields: Type.Array(FieldDefSchema),
});

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function checkScalar(
	type: Exclude<FieldType, "enum" | "list">,
	value: unknown,
): string | undefined {
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
			if (typeof value !== "string") return "expected a url string";
			try {
				new URL(value);
				return undefined;
			} catch {
				return "expected a valid url";
			}
		case "money":
			return checkMoney(value);
	}
}

function checkMoney(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return "expected money { amount, currency }";
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.amount !== "number" || !Number.isFinite(raw.amount)) {
		return "money amount must be a number";
	}
	if (
		typeof raw.currency !== "string" ||
		!/^[A-Za-z]{3}$/.test(raw.currency)
	) {
		return "money currency must be a 3-letter code";
	}
	return undefined;
}

/**
 * Validate one field value against its definition. Returns undefined when
 * the value is valid, otherwise a short human-readable error text.
 */
export function validateValue(def: FieldDef, value: unknown): string | undefined {
	if (def.type === "enum") {
		if (typeof value !== "string") return "expected an enum string";
		if (def.values === undefined || !def.values.includes(value)) {
			return `expected one of: ${(def.values ?? []).join(", ")}`;
		}
		return undefined;
	}
	if (def.type === "list") {
		if (!Array.isArray(value)) return "expected a list";
		const itemType = def.item ?? "string";
		for (const item of value) {
			// List-of-enum: membership comes from the owning def's values
			// (the item type carries no values of its own); permissive only
			// when no values are declared.
			if (itemType === "enum" && def.values !== undefined) {
				if (typeof item !== "string" || !def.values.includes(item)) {
					return `list item: expected one of: ${def.values.join(", ")}`;
				}
				continue;
			}
			const error = checkScalar(
				itemType === "enum" ? "string" : itemType,
				item,
			);
			if (error !== undefined) return `list item: ${error}`;
		}
		return undefined;
	}
	return checkScalar(def.type, value);
}

/** Minimal type row shape the hierarchy helpers need. */
export interface TypeHierarchyRow {
	id: number;
	parentId: number | null;
	/** Field defs, parsed (FieldDef[]) or still the stored JSON string. */
	fields: string | FieldDef[];
}

/**
 * Effective (own + inherited) field defs for a type: walk the parent
 * chain root-first; a child field with the same name shadows the
 * ancestor's def.
 */
export function effectiveFields(
	typesById: Map<number, TypeHierarchyRow>,
	typeId: number,
): FieldDef[] {
	const chain: TypeHierarchyRow[] = [];
	let current = typesById.get(typeId);
	while (current !== undefined) {
		chain.unshift(current);
		current =
			current.parentId === null ? undefined : typesById.get(current.parentId);
	}
	const byName = new Map<string, FieldDef>();
	for (const type of chain) {
		const fields =
			typeof type.fields === "string"
				? (JSON.parse(type.fields) as FieldDef[])
				: type.fields;
		for (const field of fields) {
			byName.set(field.name, field);
		}
	}
	return [...byName.values()];
}
