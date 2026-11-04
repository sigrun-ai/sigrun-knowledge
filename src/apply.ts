import { randomUUID } from "node:crypto";

import type { KnowledgeDb } from "./db.js";
import {
	type FieldDef,
	TYPE_NAME_PATTERN,
	type TypeDef,
	validateValue,
} from "./schema.js";

const MAX_TYPES_PER_RECORD = 10;
const MAX_ENTITIES_PER_RECORD = 50;

const ENTITY_ROLES = ["candidate", "shortlisted", "rejected", "chosen"] as const;

export interface RecordInput {
	inquiry?: {
		id?: string;
		question: string;
		why?: string;
		outcome?: {
			status: "open" | "decided" | "abandoned";
			what?: string;
		};
	};
	types?: TypeDef[];
	entities: {
		id?: string;
		type: string;
		name: string;
		keys: Record<string, string>;
		fields: Record<
			string,
			{ value: unknown; source: string; observedAt: string }
		>;
		attributes?: Record<string, unknown>;
		role?: (typeof ENTITY_ROLES)[number];
		reason?: string;
	}[];
}

export interface ApplyResult {
	changeId: string;
	summary: string;
	/** Entity ids created or updated. */
	touched: string[];
	errors: string[];
}

export interface ApplyContext {
	conversationId?: number;
	callId: string;
	now: number;
}

interface StoredType {
	id: number;
	name: string;
	description: string;
	parentId: number | null;
	fields: FieldDef[];
	version: number;
	archived: number;
}

interface StoredEntity {
	id: string;
	typeId: number;
	name: string;
	keys: string;
	fields: string;
	attributes: string;
	cls: string;
	indexedAt: number | null;
	archived: number;
}

interface FieldRecord {
	value: unknown;
	source: string;
	observedAt: string;
}

/** Marker thrown inside the transaction to roll back on validation errors. */
class RecordInvalid extends Error {}

/** Normalize an identity key value for matching within a type family. */
export function normalizeKey(key: string, value: string): string {
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

function loadTypes(db: KnowledgeDb): Map<string, StoredType> {
	const rows = db
		.raw()
		.prepare(
			"SELECT id, name, description, parentId, fields, version, archived FROM types WHERE archived = 0",
		)
		.all() as (Omit<StoredType, "fields"> & { fields: string })[];
	const map = new Map<string, StoredType>();
	for (const row of rows) {
		map.set(row.name, {
			...row,
			fields: JSON.parse(row.fields) as FieldDef[],
		});
	}
	return map;
}

/** The topmost ancestor type id: one identity family per hierarchy. */
function familyRootId(
	typesById: Map<number, StoredType>,
	typeId: number,
): number {
	let current = typeId;
	for (;;) {
		const type = typesById.get(current);
		if (type === undefined || type.parentId === null) return current;
		current = type.parentId;
	}
}

function writeVersion(
	db: KnowledgeDb,
	changeId: string,
	table: string,
	rowId: string,
	before: unknown,
	after: unknown,
	at: number,
): void {
	db.raw()
		.prepare(
			'INSERT INTO versions (changeId, "table", rowId, before, after, at) VALUES (?, ?, ?, ?, ?, ?)',
		)
		.run(
			changeId,
			table,
			rowId,
			before === undefined || before === null
				? null
				: JSON.stringify(before),
			after === undefined || after === null
				? null
				: JSON.stringify(after),
			at,
		);
}

/**
 * Apply one knowledge record atomically. Any validation error rolls the
 * whole record back and is reported in `errors`. Replaying an already
 * applied `callId` returns the stored result unchanged.
 */
export function applyRecord(
	db: KnowledgeDb,
	input: RecordInput,
	ctx: ApplyContext,
): ApplyResult {
	const replayed = db
		.raw()
		.prepare("SELECT result FROM applied WHERE callId = ?")
		.get(ctx.callId) as { result: string } | undefined;
	if (replayed !== undefined) {
		return JSON.parse(replayed.result) as ApplyResult;
	}

	const errors: string[] = [];
	let result: ApplyResult | undefined;
	try {
		db.transaction(() => {
			const applied = applyValidating(db, input, ctx, errors);
			if (applied === undefined) throw new RecordInvalid();
			result = applied;
			db.raw()
				.prepare(
					"INSERT INTO applied (callId, changeId, result) VALUES (?, ?, ?)",
				)
				.run(ctx.callId, result.changeId, JSON.stringify(result));
		});
	} catch (error) {
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

function applyValidating(
	db: KnowledgeDb,
	input: RecordInput,
	ctx: ApplyContext,
	errors: string[],
): ApplyResult | undefined {
	if (input.types !== undefined && input.types.length > MAX_TYPES_PER_RECORD) {
		errors.push(
			`record declares ${input.types.length} types (max ${MAX_TYPES_PER_RECORD})`,
		);
	}
	if (input.entities.length > MAX_ENTITIES_PER_RECORD) {
		errors.push(
			`record carries ${input.entities.length} entities (max ${MAX_ENTITIES_PER_RECORD})`,
		);
	}
	if (errors.length > 0) return undefined;

	const changeId = randomUUID();
	const typesByName = loadTypes(db);
	let typesById = new Map<number, StoredType>();
	for (const type of typesByName.values()) typesById.set(type.id, type);

	// Types: create, or extend by adding fields (never remove or retype).
	// A parent may be declared later in the same record, so resolve the
	// hierarchy in a fixpoint pass over the unresolved defs.
	const typeErrors: string[] = [];
	for (const def of input.types ?? []) {
		validateTypeDef(def, typeErrors);
		if (typeErrors.length > 0) break;
		const seen = new Set<string>();
		const declared = new Map((input.types ?? []).map((d) => [d.name, d]));
		let cursor: TypeDef | undefined = def;
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
			if (pending.has(def.parent ?? "")) continue;
			applyTypeDef(db, def, typesByName, typesById, errors);
			pending.delete(def.name);
			progressed = true;
			if (errors.length > 0) break;
		}
		if (!progressed || errors.length > 0) break;
	}
	for (const def of pending.values()) {
		errors.push(`type "${def.name}" has unknown parent "${def.parent}"`);
	}
	if (errors.length > 0) return undefined;

	function applyTypeDef(
		db: KnowledgeDb,
		def: TypeDef,
		typesByName: Map<string, StoredType>,
		typesById: Map<number, StoredType>,
		errors: string[],
	): void {
		const existing = typesByName.get(def.name);
		if (existing === undefined) {
			const parentId =
				def.parent === undefined
					? null
					: (typesByName.get(def.parent)?.id ?? null);
			const inserted = db
				.raw()
				.prepare(
					"INSERT INTO types (name, description, parentId, fields, version) VALUES (?, ?, ?, ?, 1)",
				)
				.run(def.name, def.description, parentId, JSON.stringify(def.fields));
			const stored: StoredType = {
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
			} else if (stored.type !== field.type) {
				errors.push(
					`type "${def.name}" retypes field "${field.name}" (${stored.type} -> ${field.type})`,
				);
			}
		}
		for (const stored of existing.fields) {
			if (!def.fields.some((field) => field.name === stored.name)) {
				errors.push(
					`type "${def.name}" update drops field "${stored.name}"`,
				);
			}
		}
		if (errors.length > 0) return;
		if (merged.length !== existing.fields.length) {
			db.raw()
				.prepare(
					"UPDATE types SET fields = ?, version = version + 1 WHERE id = ?",
				)
				.run(JSON.stringify(merged), existing.id);
			existing.fields = merged;
			existing.version += 1;
		}
	}

	typesById = new Map<number, StoredType>();
	for (const type of typesByName.values()) typesById.set(type.id, type);

	// Inquiry: match by question, else create.
	let inquiryId: number | undefined;
	if (input.inquiry !== undefined) {
		inquiryId = applyInquiry(db, input.inquiry, ctx, changeId);
	}

	const touched: string[] = [];
	const touchedTypeNames: string[] = [];
	for (const entityInput of input.entities) {
		const type = typesByName.get(entityInput.type);
		if (type === undefined) {
			errors.push(
				`entity "${entityInput.name}" has unknown type "${entityInput.type}"`,
			);
			continue;
		}
		if (
			entityInput.role !== undefined &&
			!ENTITY_ROLES.includes(entityInput.role)
		) {
			errors.push(
				`entity "${entityInput.name}" has invalid role "${entityInput.role}"`,
			);
			continue;
		}
		if (entityInput.role !== undefined && inquiryId === undefined) {
			errors.push(
				`entity "${entityInput.name}" carries a role but the record has no inquiry`,
			);
			continue;
		}
		for (const [fieldName, field] of Object.entries(entityInput.fields)) {
			const def = type.fields.find((candidate) => candidate.name === fieldName);
			if (def === undefined) {
				errors.push(
					`entity "${entityInput.name}" field "${fieldName}" is not declared on type "${type.name}"`,
				);
				continue;
			}
			const invalid = validateValue(def, field.value);
			if (invalid !== undefined) {
				errors.push(
					`entity "${entityInput.name}" field "${fieldName}": ${invalid}`,
				);
			}
		}
		if (errors.length > 0) continue;

		const entityId = applyEntity(
			db,
			entityInput,
			type,
			typesById,
			changeId,
			ctx.now,
			errors,
		);
		if (entityId === undefined) continue;
		touched.push(entityId);
		if (!touchedTypeNames.includes(type.name)) touchedTypeNames.push(type.name);

		if (entityInput.role !== undefined && inquiryId !== undefined) {
			applyRole(
				db,
				inquiryId,
				entityId,
				entityInput.role,
				entityInput.reason,
				changeId,
				ctx.now,
			);
		}
	}
	if (errors.length > 0) return undefined;

	const subject = input.inquiry?.question ?? "facts";
	const typeSummary = touchedTypeNames.map((name) => `${name}s`).join(", ");
	return {
		changeId,
		summary: `recorded ${subject}: ${touched.length} ${typeSummary}`,
		touched,
		errors: [],
	};
}

function validateTypeDef(def: TypeDef, errors: string[]): void {
	if (!TYPE_NAME_PATTERN.test(def.name)) {
		errors.push(`type name "${def.name}" is not a lowercase singular phrase`);
	}
	if (typeof def.description !== "string" || def.description === "") {
		errors.push(`type "${def.name}" needs a description`);
	}
	if (
		def.parent !== undefined &&
		(def.name === def.parent || !TYPE_NAME_PATTERN.test(def.parent))
	) {
		errors.push(`type "${def.name}" has an invalid parent "${def.parent}"`);
	}
}

function applyInquiry(
	db: KnowledgeDb,
	inquiry: NonNullable<RecordInput["inquiry"]>,
	ctx: ApplyContext,
	changeId: string,
): number {
	const existing = db
		.raw()
		.prepare(
			"SELECT id, conversations, outcome FROM inquiries WHERE question = ?",
		)
		.get(inquiry.question) as
		| { id: number; conversations: string; outcome: string | null }
		| undefined;
	if (existing === undefined) {
		const conversations =
			ctx.conversationId === undefined ? [] : [ctx.conversationId];
		const inserted = db
			.raw()
			.prepare(
				"INSERT INTO inquiries (question, why, startedAt, touchedAt, conversations, outcome) VALUES (?, ?, ?, ?, ?, ?)",
			)
			.run(
				inquiry.question,
				inquiry.why ?? null,
				ctx.now,
				ctx.now,
				JSON.stringify(conversations),
				inquiry.outcome === undefined
					? null
					: JSON.stringify(inquiry.outcome),
			);
		return Number(inserted.lastInsertRowid);
	}

	// Existing inquiry: only record a version when something changed.
	const conversations = JSON.parse(existing.conversations) as number[];
	const conversationAdded =
		ctx.conversationId !== undefined &&
		!conversations.includes(ctx.conversationId);
	const outcomeChanged =
		inquiry.outcome !== undefined &&
		existing.outcome !== JSON.stringify(inquiry.outcome);
	if (conversationAdded || outcomeChanged) {
		const next = {
			conversations: conversationAdded
				? [...conversations, ctx.conversationId as number]
				: conversations,
			outcome: outcomeChanged ? inquiry.outcome : existing.outcome,
		};
		writeVersion(
			db,
			changeId,
			"inquiries",
			String(existing.id),
			{
				conversations: existing.conversations,
				outcome: existing.outcome,
				touchedAt: ctx.now,
			},
			{
				conversations: JSON.stringify(next.conversations),
				outcome:
					typeof next.outcome === "string"
						? next.outcome
						: next.outcome === undefined || next.outcome === null
							? null
							: JSON.stringify(next.outcome),
				touchedAt: ctx.now,
			},
			ctx.now,
		);
		db.raw()
			.prepare(
				"UPDATE inquiries SET conversations = ?, outcome = ?, touchedAt = ? WHERE id = ?",
			)
			.run(
				JSON.stringify(next.conversations),
				typeof next.outcome === "string"
					? next.outcome
					: next.outcome === undefined || next.outcome === null
						? null
						: JSON.stringify(next.outcome),
				ctx.now,
				existing.id,
			);
	}
	return existing.id;
}

function applyRole(
	db: KnowledgeDb,
	inquiryId: number,
	entityId: string,
	role: (typeof ENTITY_ROLES)[number],
	reason: string | undefined,
	changeId: string,
	now: number,
): void {
	const existing = db
		.raw()
		.prepare(
			"SELECT id, role, reason FROM roles WHERE inquiryId = ? AND entityId = ?",
		)
		.get(inquiryId, entityId) as
		| { id: number; role: string; reason: string | null }
		| undefined;
	if (existing === undefined) {
		const inserted = db
			.raw()
			.prepare(
				"INSERT INTO roles (inquiryId, entityId, role, reason) VALUES (?, ?, ?, ?)",
			)
			.run(inquiryId, entityId, role, reason ?? null);
		writeVersion(
			db,
			changeId,
			"roles",
			String(inserted.lastInsertRowid),
			null,
			{ id: Number(inserted.lastInsertRowid), inquiryId, entityId, role, reason: reason ?? null },
			now,
		);
		return;
	}
	if (existing.role === role && existing.reason === (reason ?? null)) return;
	writeVersion(
		db,
		changeId,
		"roles",
		String(existing.id),
		existing,
		{ ...existing, role, reason: reason ?? null },
		now,
	);
	db.raw()
		.prepare("UPDATE roles SET role = ?, reason = ? WHERE id = ?")
		.run(role, reason ?? null, existing.id);
}

function applyEntity(
	db: KnowledgeDb,
	input: RecordInput["entities"][number],
	type: StoredType,
	typesById: Map<number, StoredType>,
	changeId: string,
	now: number,
	errors: string[],
): string | undefined {
	const rootId = familyRootId(typesById, type.id);

	// Match: explicit id, else any identity key within the type family.
	// Name similarity never matches.
	let existing: StoredEntity | undefined;
	if (input.id !== undefined) {
		existing = db
			.raw()
			.prepare(
				"SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ? AND archived = 0",
			)
			.get(input.id) as StoredEntity | undefined;
		if (existing === undefined) {
			errors.push(
				`entity "${input.name}" references unknown id "${input.id}"`,
			);
			return undefined;
		}
	} else {
		for (const [key, value] of Object.entries(input.keys)) {
			const normalized = normalizeKey(key, value);
			if (normalized === "") continue;
			const match = db
				.raw()
				.prepare(
					`SELECT e.id, e.typeId, e.name, e.keys, e.fields, e.attributes, e.cls, e.indexedAt, e.archived
					 FROM entity_keys k JOIN entities e ON e.id = k.entityId
					 WHERE k.typeFamilyRoot = ? AND k.key = ? AND k.normalized = ? AND e.archived = 0`,
				)
				.get(rootId, key, normalized) as StoredEntity | undefined;
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
			.prepare(
				"INSERT INTO entities (id, typeId, name, keys, fields, attributes, indexedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
			)
			.run(
				id,
				type.id,
				input.name,
				JSON.stringify(keyNames),
				JSON.stringify(input.fields),
				JSON.stringify(input.attributes ?? {}),
				now,
			);
		for (const [key, value] of Object.entries(input.keys)) {
			insertKey(db, id, rootId, key, value);
		}
		const stored: StoredEntity = {
			id,
			typeId: type.id,
			name: input.name,
			keys: JSON.stringify(keyNames),
			fields: JSON.stringify(input.fields),
			attributes: JSON.stringify(input.attributes ?? {}),
			cls: "normal",
			indexedAt: now,
			archived: 0,
		};
		writeVersion(db, changeId, "entities", id, null, stored, now);
		return id;
	}

	// Update: merge fields, add any new identity keys.
	const storedFields = JSON.parse(existing.fields) as Record<string, FieldRecord>;
	const nextFields = { ...storedFields, ...input.fields };
	const storedAttributes = JSON.parse(existing.attributes) as Record<
		string,
		unknown
	>;
	const nextAttributes = { ...storedAttributes, ...(input.attributes ?? {}) };
	const storedKeyNames = new Set(
		JSON.parse(existing.keys) as string[],
	);
	for (const [key, value] of Object.entries(input.keys)) {
		storedKeyNames.add(key);
		const normalized = normalizeKey(key, value);
		const present = db
			.raw()
			.prepare(
				"SELECT id FROM entity_keys WHERE entityId = ? AND key = ? AND normalized = ?",
			)
			.get(existing.id, key, normalized);
		if (present === undefined) {
			const row = insertKey(db, existing.id, rootId, key, value);
			writeVersion(db, changeId, "entity_keys", String(row.id), null, row, now);
		}
	}

	const next: StoredEntity = {
		...existing,
		typeId: type.id,
		name: input.name,
		keys: JSON.stringify([...storedKeyNames]),
		fields: JSON.stringify(nextFields),
		attributes: JSON.stringify(nextAttributes),
		indexedAt: now,
	};
	const changed =
		next.fields !== existing.fields ||
		next.attributes !== existing.attributes ||
		next.keys !== existing.keys ||
		next.name !== existing.name ||
		next.typeId !== existing.typeId;
	if (changed) {
		writeVersion(db, changeId, "entities", existing.id, existing, next, now);
		db.raw()
			.prepare(
				"UPDATE entities SET typeId = ?, name = ?, keys = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?",
			)
			.run(
				next.typeId,
				next.name,
				next.keys,
				next.fields,
				next.attributes,
				next.indexedAt,
				existing.id,
			);
	}
	return existing.id;
}

function insertKey(
	db: KnowledgeDb,
	entityId: string,
	rootId: number,
	key: string,
	value: string,
): { id: number; entityId: string; typeFamilyRoot: number; key: string; normalized: string } {
	const normalized = normalizeKey(key, value);
	const inserted = db
		.raw()
		.prepare(
			"INSERT INTO entity_keys (entityId, typeFamilyRoot, key, normalized) VALUES (?, ?, ?, ?)",
		)
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
export function retypeEntities(
	db: KnowledgeDb,
	entityIds: readonly string[],
	toType: string,
	changeId: string,
	now: number,
): void {
	db.transaction(() => {
		const typesByName = loadTypes(db);
		const target = typesByName.get(toType);
		if (target === undefined) {
			throw new Error(`retypeEntities: unknown type "${toType}"`);
		}
		const typesById = new Map<number, StoredType>();
		for (const type of typesByName.values()) typesById.set(type.id, type);
		const rootId = familyRootId(typesById, target.id);
		const declared = new Set(target.fields.map((field) => field.name));

		for (const entityId of entityIds) {
			const entity = db
				.raw()
				.prepare(
					"SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ?",
				)
				.get(entityId) as StoredEntity | undefined;
			if (entity === undefined) continue;

			const fields = JSON.parse(entity.fields) as Record<string, FieldRecord>;
			const attributes = JSON.parse(entity.attributes) as Record<
				string,
				unknown
			>;
			const kept: Record<string, FieldRecord> = {};
			for (const [name, field] of Object.entries(fields)) {
				if (declared.has(name)) {
					kept[name] = field;
				} else {
					attributes[name] = field;
				}
			}
			const next: StoredEntity = {
				...entity,
				typeId: target.id,
				fields: JSON.stringify(kept),
				attributes: JSON.stringify(attributes),
				indexedAt: now,
			};
			writeVersion(db, changeId, "entities", entity.id, entity, next, now);
			db.raw()
				.prepare(
					"UPDATE entities SET typeId = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?",
				)
				.run(next.typeId, next.fields, next.attributes, now, entity.id);
			db.raw()
				.prepare(
					"UPDATE entity_keys SET typeFamilyRoot = ? WHERE entityId = ?",
				)
				.run(rootId, entity.id);
		}
	});
}
