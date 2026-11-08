import type { DatabaseSync } from "node:sqlite";

import {
	type FieldDef,
	type TypeHierarchyRow,
	effectiveFields,
} from "./schema.js";

export interface TypeNode {
	readonly id: number;
	readonly name: string;
	readonly description: string;
	readonly archived: boolean;
	readonly ownCount: number;
	readonly totalCount: number;
	readonly children: readonly TypeNode[];
}

export interface FieldView {
	readonly name: string;
	readonly value: string;
	readonly source: string;
	readonly observedAt: string;
	readonly stale: boolean;
}

export interface EntityRow {
	readonly id: string;
	readonly name: string;
	readonly type: string;
	readonly localOnly: boolean;
}

export interface EntityDetail extends EntityRow {
	readonly keys: readonly { name: string; normalized: string }[];
	readonly fields: readonly FieldView[];
	readonly attributes: readonly { name: string; value: string }[];
	readonly roles: readonly {
		inquiryId: number;
		question: string;
		role: string;
		reason: string | null;
	}[];
	readonly history: readonly {
		changeId: string;
		at: number;
		before: string;
		after: string;
		label: "created" | "archived" | "changed";
	}[];
}

export interface InquiryRow {
	readonly id: number;
	readonly question: string;
	readonly why: string | null;
	readonly outcome: string | null;
	readonly startedAt: number;
	readonly touchedAt: number;
	readonly archived: boolean;
	readonly conversations: readonly number[];
	readonly entities: readonly { id: string; name: string; role: string }[];
}

interface TypeRow {
	id: number;
	name: string;
	description: string;
	parentId: number | null;
	fields: string;
	archived: number;
}

interface MutableTypeNode {
	id: number;
	name: string;
	description: string;
	archived: boolean;
	ownCount: number;
	totalCount: number;
	children: MutableTypeNode[];
}

interface FieldRecord {
	value: unknown;
	source: string;
	observedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseObserved(observedAt: string): number | null {
	const parsed = Date.parse(
		/^\d{4}-\d{2}-\d{2}$/.test(observedAt)
			? `${observedAt}T00:00:00Z`
			: observedAt,
	);
	return Number.isNaN(parsed) ? null : parsed;
}

function types(db: DatabaseSync, includeArchived = false): TypeRow[] {
	// SAFETY: fixed schema columns; only the archived predicate is selected.
	// SAFETY: the result rows match TypeRow.
	const statement = includeArchived
		? "SELECT id, name, description, parentId, fields, archived FROM types ORDER BY name, id"
		: "SELECT id, name, description, parentId, fields, archived FROM types WHERE archived = 0 ORDER BY name, id";
	return db.prepare(statement).all() as unknown as TypeRow[];
}

function descendantIds(rows: readonly TypeRow[], typeId: number): Set<number> {
	const children = new Map<number, number[]>();
	for (const row of rows) {
		if (row.parentId === null) continue;
		const siblings = children.get(row.parentId) ?? [];
		siblings.push(row.id);
		children.set(row.parentId, siblings);
	}
	const ids = new Set<number>();
	const pending = [typeId];
	while (pending.length > 0) {
		const id = pending.pop() as number;
		if (ids.has(id)) continue;
		ids.add(id);
		pending.push(...(children.get(id) ?? []));
	}
	return ids;
}

export function typeTree(
	db: DatabaseSync,
	opts: { includeArchived: boolean },
): readonly TypeNode[] {
	const rows = types(db, opts.includeArchived);
	// SAFETY: fixed schema columns; count is grouped by typeId.
	const counts = db
		.prepare(
			"SELECT typeId, COUNT(*) AS count FROM entities WHERE archived = 0 GROUP BY typeId",
		)
		.all() as unknown as { typeId: number; count: number }[];
	const countByType = new Map(counts.map((row) => [row.typeId, row.count]));
	const nodes = new Map<number, MutableTypeNode>();
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
	const roots: MutableTypeNode[] = [];
	for (const row of rows) {
		const node = nodes.get(row.id) as MutableTypeNode;
		const parent = row.parentId === null ? undefined : nodes.get(row.parentId);
		if (parent === undefined) roots.push(node);
		else parent.children.push(node);
	}
	function total(node: MutableTypeNode): number {
		node.totalCount = node.children.reduce(
			(sum, child) => sum + total(child),
			node.ownCount,
		);
		return node.totalCount;
	}
	for (const root of roots) total(root);
	return roots;
}

/** Effective field definitions for a type, including archived ancestors. */
export function effectiveTypeFields(
	db: DatabaseSync,
	typeId: number,
): readonly FieldDef[] {
	return effectiveFields(
		new Map(types(db, true).map((type) => [type.id, type as TypeHierarchyRow])),
		typeId,
	);
}

export function entitiesOfType(
	db: DatabaseSync,
	typeId: number,
	opts: { search: string; limit: number },
): readonly EntityRow[] {
	const family = descendantIds(types(db, true), typeId);
	// SAFETY: fixed schema columns; search is bound and escaped.
	const rows = db
		.prepare(
			`SELECT e.id, e.name, e.cls, t.id AS typeId, t.name AS type
			 FROM entities e JOIN types t ON t.id = e.typeId
			 WHERE e.archived = 0 AND lower(e.name) LIKE ? ESCAPE '\\'
			 ORDER BY e.name, e.id`,
		)
		.all(`%${opts.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`) as unknown as {
		id: string;
		name: string;
		cls: string;
		typeId: number;
		type: string;
	}[];
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

export function displayValue(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).amount === "number" &&
		typeof (value as Record<string, unknown>).currency === "string"
	) {
		const money = value as { amount: number; currency: string };
		return `${money.amount.toFixed(2)} ${money.currency}`;
	}
	if (Array.isArray(value)) return value.map(displayValue).join(", ");
	if (typeof value === "boolean") return value ? "yes" : "no";
	if (typeof value === "object" && value !== null) return JSON.stringify(value);
	return String(value);
}

function historyBlob(value: string | null): string {
	if (value === null) return "";
	const parsed = JSON.parse(value) as Record<string, unknown>;
	for (const key of ["fields", "attributes", "keys"]) {
		if (typeof parsed[key] === "string") {
			parsed[key] = JSON.parse(parsed[key] as string);
		}
	}
	return JSON.stringify(parsed, null, 2);
}

export function entityDetail(
	db: DatabaseSync,
	id: string,
	now: number,
): EntityDetail | undefined {
	// SAFETY: fixed schema columns; entity id is bound.
	const row = db
		.prepare(
			`SELECT e.id, e.name, e.typeId, e.fields, e.attributes, e.cls, t.name AS type
			 FROM entities e JOIN types t ON t.id = e.typeId
			 WHERE e.id = ? AND e.archived = 0`,
		)
		.get(id) as unknown as
		| {
				id: string;
				name: string;
				typeId: number;
				fields: string;
				attributes: string;
				cls: string;
				type: string;
		  }
		| undefined;
	if (row === undefined) return undefined;

	const fields = effectiveTypeFields(db, row.typeId);
	const fieldViews = Object.entries(
		JSON.parse(row.fields) as Record<string, FieldRecord>,
	).map(([name, field]) => {
		const def = fields.find((candidate: FieldDef) => candidate.name === name);
		const observedMs = parseObserved(field.observedAt);
		return {
			name,
			value: displayValue(field.value),
			source: field.source,
			observedAt: field.observedAt,
			stale:
				def?.horizonDays !== undefined &&
				observedMs !== null &&
				now - observedMs > def.horizonDays * DAY_MS,
		};
	});
	// SAFETY: fixed schema columns; entity id is bound.
	const keys = db
		.prepare(
			"SELECT key AS name, normalized FROM entity_keys WHERE entityId = ? ORDER BY key, normalized",
		)
		.all(id) as unknown as { name: string; normalized: string }[];
	// SAFETY: fixed schema columns; entity id is bound.
	const roles = db
		.prepare(
			`SELECT i.id AS inquiryId, i.question, r.role, r.reason
			 FROM roles r JOIN inquiries i ON i.id = r.inquiryId
			 WHERE r.entityId = ? AND i.archived = 0 ORDER BY i.question, i.id`,
		)
		.all(id) as unknown as EntityDetail["roles"];
	// SAFETY: fixed schema columns; table and row id are bound.
	const history = db
		.prepare(
			'SELECT changeId, before, after, at FROM versions WHERE "table" = ? AND rowId = ? ORDER BY seq DESC LIMIT 20',
		)
		.all("entities", id) as unknown as {
		changeId: string;
		before: string | null;
		after: string | null;
		at: number;
	}[];

	return {
		id: row.id,
		name: row.name,
		type: row.type,
		localOnly: row.cls === "local-only",
		keys,
		fields: fieldViews,
		attributes: Object.entries(
			JSON.parse(row.attributes) as Record<string, unknown>,
		).map(([name, value]) => ({ name, value: displayValue(value) })),
		roles,
		history: history.map((version) => ({
			changeId: version.changeId,
			at: version.at,
			before: historyBlob(version.before),
			after: historyBlob(version.after),
			label:
				version.before === null
					? "created"
					: version.after === null
						? "archived"
						: (JSON.parse(version.after) as { archived?: number }).archived === 1 &&
							  (JSON.parse(version.before) as { archived?: number }).archived !== 1
							? "archived"
							: "changed",
		})),
	};
}

export function inquiries(
	db: DatabaseSync,
	opts: { includeArchived: boolean },
): readonly InquiryRow[] {
	// SAFETY: fixed schema columns; only the archived predicate is selected.
	// SAFETY: the result rows match the inquiry row shape below.
	const statement = opts.includeArchived
		? "SELECT id, question, why, outcome, startedAt, touchedAt, archived, conversations FROM inquiries ORDER BY touchedAt DESC, id DESC"
		: "SELECT id, question, why, outcome, startedAt, touchedAt, archived, conversations FROM inquiries WHERE archived = 0 ORDER BY touchedAt DESC, id DESC";
	const rows = db.prepare(statement).all() as unknown as {
		id: number;
		question: string;
		why: string | null;
		outcome: string | null;
		startedAt: number;
		touchedAt: number;
		archived: number;
		conversations: string;
	}[];
	return rows.map((row) => {
		const entities = db
			.prepare(
				`SELECT e.id, e.name, r.role
				 FROM roles r JOIN entities e ON e.id = r.entityId
				 WHERE r.inquiryId = ? AND e.archived = 0 ORDER BY e.name, e.id`,
			)
			.all(row.id) as unknown as { id: string; name: string; role: string }[];
		let conversations: number[] = [];
		try {
			const parsed = JSON.parse(row.conversations) as unknown;
			if (Array.isArray(parsed)) {
				conversations = parsed.filter(
					(value): value is number => typeof value === "number",
				);
			}
		} catch {
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
