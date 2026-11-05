import type {
	CurationRunResult,
	HandlerContext,
	MaintenanceBudget,
	MaintenanceReport,
} from "@sigrun/sigrun/extension";

import { randomUUID } from "node:crypto";

import type { KnowledgeDb } from "./db.js";
import { mirrorEntities, type MirrorHost } from "./mirror.js";
import { retypeEntities } from "./apply.js";
import type { FieldDef, TypeDef } from "./schema.js";

const REINDEX_LIMIT = 50;
const RETYPE_LIMIT = 50;
const DECLINED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MIN_GROUP_SIZE = 3;
const MIN_JACCARD = 0.5;

export interface MaintainDeps {
	host: MirrorHost;
	dbForUser(user: string): KnowledgeDb;
	now(): number;
}

interface TypeRow {
	id: number;
	name: string;
	description: string;
	parentId: number | null;
	fields: string;
	archived: number;
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
			before === undefined || before === null ? null : JSON.stringify(before),
			after === undefined || after === null ? null : JSON.stringify(after),
			at,
		);
}

/** Jaccard similarity of two field-name sets. */
export function jaccard(a: readonly string[], b: readonly string[]): number {
	const setA = new Set(a);
	const setB = new Set(b);
	let common = 0;
	for (const name of setA) if (setB.has(name)) common += 1;
	const union = setA.size + setB.size - common;
	return union === 0 ? 0 : common / union;
}

function loadLiveTypes(db: KnowledgeDb): TypeRow[] {
	return db
		.raw()
		.prepare(
			`SELECT DISTINCT t.id, t.name, t.description, t.parentId, t.fields, t.archived
			 FROM types t
			 WHERE t.archived = 0 AND NOT EXISTS (
			   SELECT 1 FROM types c
			   WHERE c.archived = 0 AND c.parentId = t.id
			     AND t.parentId IS NULL)`,
		)
		// SAFETY: the types table columns are fixed by db.ts's schema; node:sqlite
		// types rows generically.
		.all() as unknown as TypeRow[];
}

function entityCount(db: KnowledgeDb, typeId: number): number {
	const row = db
		.raw()
		.prepare(
			"SELECT COUNT(*) AS n FROM entities WHERE typeId = ? AND archived = 0",
		)
		.get(typeId) as { n: number };
	return row.n;
}

function entityIdsOf(db: KnowledgeDb, typeId: number): string[] {
	return (
		db
			.raw()
			.prepare(
				"SELECT id FROM entities WHERE typeId = ? AND archived = 0 ORDER BY id",
			)
			.all(typeId) as { id: string }[]
	).map((row) => row.id);
}

/** Effective (own + inherited) field defs for a type. */
export function effectiveFields(typesById: Map<number, TypeRow>, typeId: number): FieldDef[] {
	const chain: TypeRow[] = [];
	let current = typesById.get(typeId);
	while (current !== undefined) {
		chain.unshift(current);
		current = current.parentId === null ? undefined : typesById.get(current.parentId);
	}
	const byName = new Map<string, FieldDef>();
	for (const type of chain) {
		for (const field of JSON.parse(type.fields) as FieldDef[]) {
			byName.set(field.name, field);
		}
	}
	return [...byName.values()];
}

/** The group key for the 30-day declined memory. */
function groupKey(names: readonly string[]): string {
	return [...names].sort().join("|");
}

function isDeclined(db: KnowledgeDb, key: string, now: number): boolean {
	const rows = db
		.raw()
		.prepare(
			"SELECT payload, at FROM maintenance WHERE kind = 'declined-generalization'",
		)
		.all() as { payload: string; at: number }[];
	// The group's most recent decline within the TTL wins; an older
	// expired decline is a re-ask.
	let declinedAt: number | undefined;
	for (const row of rows) {
		const payload = JSON.parse(row.payload) as { group?: string };
		if (payload.group === key) {
			declinedAt = declinedAt === undefined ? row.at : Math.max(declinedAt, row.at);
		}
	}
	return declinedAt !== undefined && now - declinedAt <= DECLINED_TTL_MS;
}

function rememberDeclined(db: KnowledgeDb, key: string, now: number): void {
	db.raw()
		.prepare(
			"INSERT INTO maintenance (kind, changeId, payload, cursor, at) VALUES ('declined-generalization', NULL, ?, NULL, ?)",
		)
		.run(JSON.stringify({ group: key }), now);
}

interface Continuation {
	changeId: string;
	parentType: string;
	remaining: string[];
}

function loadContinuation(db: KnowledgeDb): Continuation | undefined {
	const row = db
		.raw()
		.prepare(
			"SELECT changeId, payload FROM maintenance WHERE kind = 'retype-continuation' ORDER BY id DESC LIMIT 1",
		)
		.get() as { changeId: string | null; payload: string } | undefined;
	if (row === undefined || row.changeId === null) return undefined;
	const payload = JSON.parse(row.payload) as {
		parentType?: string;
		remaining?: string[];
	};
	if (payload.parentType === undefined) return undefined;
	return {
		changeId: row.changeId,
		parentType: payload.parentType,
		remaining: payload.remaining ?? [],
	};
}

function saveContinuation(
	db: KnowledgeDb,
	changeId: string,
	parentType: string,
	remaining: string[],
	now: number,
): void {
	const existing = db
		.raw()
		.prepare(
			"SELECT id FROM maintenance WHERE kind = 'retype-continuation' ORDER BY id DESC LIMIT 1",
		)
		.get() as { id: number } | undefined;
	if (existing !== undefined) {
		db.raw()
			.prepare("DELETE FROM maintenance WHERE id = ?")
			.run(existing.id);
	}
	db.raw()
		.prepare(
			"INSERT INTO maintenance (kind, changeId, payload, cursor, at) VALUES ('retype-continuation', ?, ?, NULL, ?)",
		)
		.run(changeId, JSON.stringify({ parentType, remaining }), now);
}

function dropContinuation(db: KnowledgeDb): void {
	db.raw()
		.prepare("DELETE FROM maintenance WHERE kind = 'retype-continuation'")
		.run();
}

function generalizePrompt(types: { name: string; fields: FieldDef[] }[]): string {
	const lines = types
		.map(
			(type) =>
				`- ${type.name}: fields ${type.fields.map((field) => field.name).join(", ") || "(none)"}`,
		)
		.join("\n");
	return [
		"These knowledge types look like siblings. Decide whether they are kinds of ONE general type.",
		lines,
		"",
		'Answer ONLY JSON: {"general": true, "name": string, "description": string, "fields": [{"name": string, "type": "string"|"number"|"boolean"|"date"|"url"|"money"|"enum"|"list", "horizonDays"?: number}]} — the parent name (a lowercase singular phrase), description, and the shared fields each child already carries.',
		'Or {"general": false}.',
	].join("\n");
}

function parseAnswer(text: string):
	| { general: true; name: string; description: string; fields: FieldDef[] }
	| { general: false }
	| undefined {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end === -1 || end < start) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return undefined;
	}
	if (typeof parsed !== "object" || parsed === null) return undefined;
	const raw = parsed as Record<string, unknown>;
	if (raw.general !== true) return { general: false };
	if (typeof raw.name !== "string" || raw.name.trim() === "") return undefined;
	if (typeof raw.description !== "string") return undefined;
	if (!Array.isArray(raw.fields)) return undefined;
	const fields: FieldDef[] = [];
	for (const field of raw.fields as Record<string, unknown>[]) {
		if (typeof field.name !== "string" || typeof field.type !== "string") {
			return undefined;
		}
		const def: FieldDef = { name: field.name, type: field.type as FieldDef["type"] };
		if (typeof field.horizonDays === "number") def.horizonDays = field.horizonDays;
		if (typeof field.description === "string") def.description = field.description;
		if (Array.isArray(field.values)) {
			def.values = field.values.filter((v): v is string => typeof v === "string");
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
export async function maintain(
	user: string,
	ctx: HandlerContext,
	budget: MaintenanceBudget,
	deps: MaintainDeps,
): Promise<MaintenanceReport> {
	void ctx;
	const db = deps.dbForUser(user);
	const changes: { changeId: string; summary: string }[] = [];
	let more = false;

	// 1. Re-index pending entities (indexedAt behind their last version,
	//    or never indexed).
	const pending = db
		.raw()
		.prepare(
			`SELECT e.id FROM entities e
			 WHERE e.archived = 0 AND (
			   e.indexedAt IS NULL OR e.indexedAt < COALESCE((
			     SELECT MAX(v.at) FROM versions v
			     WHERE v."table" = 'entities' AND v.rowId = e.id
			   ), 0))
			 ORDER BY e.id LIMIT ?`,
		)
		.all(REINDEX_LIMIT) as { id: string }[];
	if (pending.length > 0) {
		await mirrorEntities(
			deps.host,
			db,
			user,
			pending.map((row) => row.id),
			deps.now(),
		);
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
			retypeEntities(db, batch, continuation.parentType, continuation.changeId, deps.now());
			await mirrorEntities(deps.host, db, user, batch, deps.now());
		}
		if (rest.length > 0) {
			saveContinuation(db, continuation.changeId, continuation.parentType, rest, deps.now());
			more = true;
		} else {
			dropContinuation(db);
			changes.push({
				changeId: continuation.changeId,
				summary: `re-typed remaining entities into ${continuation.parentType}`,
			});
		}
		return { changes, ...(more ? { more: true } : {}) };
	}

	// 3. Propose (needs budget).
	if (budget.runs < 1) return { changes, ...(more ? { more: true } : {}) };
	if (deps.now() > budget.deadline) {
		return { changes, ...(more ? { more: true } : {}) };
	}

	// Find sibling groups: same parent (or both root), not archived,
	// >= 3 types, pairwise field-name Jaccard >= 0.5.
	const types = loadLiveTypes(db);
	const siblings = new Map<string, TypeRow[]>();
	for (const type of types) {
		const key = type.parentId === null ? "root" : String(type.parentId);
		const list = siblings.get(key) ?? [];
		list.push(type);
		siblings.set(key, list);
	}
	let best: { group: TypeRow[]; entities: number } | undefined;
	for (const group of siblings.values()) {
		if (group.length < MIN_GROUP_SIZE) continue;
		const names = group.map((type) =>
			(JSON.parse(type.fields) as FieldDef[]).map((field) => field.name),
		);
		let ok = true;
		for (let i = 0; i < group.length && ok; i++) {
			for (let j = i + 1; j < group.length; j++) {
				if (jaccard(names[i]!, names[j]!) < MIN_JACCARD) {
					ok = false;
					break;
				}
			}
		}
		if (!ok) continue;
		const count = group.reduce((sum, type) => sum + entityCount(db, type.id), 0);
		if (best === undefined || count > best.entities) best = { group, entities: count };
	}
	if (best === undefined) return { changes, ...(more ? { more: true } : {}) };
	if (isDeclined(db, groupKey(best.group.map((type) => type.name)), deps.now())) {
		return { changes, ...(more ? { more: true } : {}) };
	}

	const run = await budget.run(
		generalizePrompt(
			best.group.map((type) => ({
				name: type.name,
				fields: JSON.parse(type.fields) as FieldDef[],
			})),
		),
		["knowledge_find"],
	);
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
	// The answer must not rename onto an existing type (hierarchy would
	// silently merge families); decline in that case.
	if (types.some((type) => type.name === answer.name)) {
		rememberDeclined(db, groupKey(best.group.map((type) => type.name)), deps.now());
		return { changes, ...(more ? { more: true } : {}) };
	}

	// 4. Apply as a hierarchy in ONE change.
	if (deps.now() > budget.deadline) {
		// Past the deadline: decline silently rather than half-applying.
		rememberDeclined(db, groupKey(best.group.map((type) => type.name)), deps.now());
		return { changes, ...(more ? { more: true } : {}) };
	}
	const changeId = `maintain:${randomUUID()}`;
	const now = deps.now();
	const group = best.group;
	const answerFieldNames = new Set(answer.fields.map((field) => field.name));

	const folded: TypeRow[] = [];
	const retyped: TypeRow[] = [];
	for (const type of group) {
		const own = JSON.parse(type.fields) as FieldDef[];
		const distinct = own.filter((field) => !answerFieldNames.has(field.name));
		if (distinct.length === 0) folded.push(type);
		else retyped.push(type);
	}

	const foldedEntities: string[] = [];
	db.transaction(() => {
		// The parent. Shared fields come from the answer.
		const parentDef: TypeDef = {
			name: answer.name,
			description: answer.description,
			fields: answer.fields,
		};
		const inserted = db
			.raw()
			.prepare(
				"INSERT INTO types (name, description, parentId, fields, version) VALUES (?, ?, NULL, ?, 1)",
			)
			.run(parentDef.name, parentDef.description, JSON.stringify(parentDef.fields));
		const parentId = Number(inserted.lastInsertRowid);
		writeVersion(
			db,
			changeId,
			"types",
			String(parentId),
			null,
			{
				id: parentId,
				name: parentDef.name,
				description: parentDef.description,
				parentId: null,
				fields: JSON.stringify(parentDef.fields),
				version: 1,
				archived: 0,
			},
			now,
		);

		for (const type of retyped) {
			const own = JSON.parse(type.fields) as FieldDef[];
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
				.prepare(
					"UPDATE types SET parentId = ?, fields = ?, version = version + 1 WHERE id = ?",
				)
				.run(parentId, JSON.stringify(distinct), type.id);
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
		retypeEntities(db, batch, answer.name, changeId, now);
		await mirrorEntities(deps.host, db, user, batch, deps.now());
	}
	if (rest.length > 0) {
		saveContinuation(db, changeId, answer.name, rest, deps.now());
		more = true;
	}

	return { changes, ...(more ? { more: true } : {}) };
}
