import type { KnowledgeDb } from "./db.js";

export interface UndoResult {
	restored: number;
	/** Human-readable lines for rows whose current state no longer matches. */
	skipped: string[];
	/** Entity ids the undo touched (restored or archived). */
	touched: string[];
}

interface VersionRow {
	seq: number;
	changeId: string;
	table: string;
	rowId: string;
	before: string | null;
	after: string | null;
	at: number;
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
 * Undo a change: walk its versions newest-first and restore each row's
 * `before` state — but only while the row still equals the change's
 * `after`. A row a later change edited is skipped, so undo restores only
 * what the change last wrote. Every restore is itself recorded as a
 * version under `undo:<changeId>`, so nothing is lost.
 */
export function undoChange(
	db: KnowledgeDb,
	changeId: string,
	now: number,
): UndoResult {
	return db.transaction(() => {
		const undoId = `undo:${changeId}`;
		const versions = db
			.raw()
			.prepare(
				'SELECT seq, changeId, "table", rowId, before, after, at FROM versions WHERE changeId = ? ORDER BY seq DESC',
			)
			// SAFETY: the versions table columns are fixed by db.ts's schema;
			// node:sqlite only types rows generically.
			.all(changeId) as unknown as VersionRow[];

		let restored = 0;
		const skipped: string[] = [];
		const touched = new Set<string>();

		for (const version of versions) {
			switch (version.table) {
				case "entities": {
					const outcome = undoEntity(db, version, undoId, now);
					if (outcome === "restored") {
						restored += 1;
						touched.add(version.rowId);
					} else if (outcome !== "unchanged") {
						skipped.push(outcome);
					}
					break;
				}
				case "roles": {
					const outcome = undoRole(db, version, undoId, now);
					if (outcome === "restored") restored += 1;
					else if (outcome !== "unchanged") skipped.push(outcome);
					break;
				}
				case "inquiries": {
					const outcome = undoInquiry(db, version, undoId, now);
					if (outcome === "restored") restored += 1;
					else if (outcome !== "unchanged") skipped.push(outcome);
					break;
				}
				case "entity_keys": {
					const outcome = undoEntityKey(db, version, undoId, now);
					if (outcome === "restored") restored += 1;
					else if (outcome !== "unchanged") skipped.push(outcome);
					break;
				}
			}
		}
		return { restored, skipped, touched: [...touched] };
	});
}

function undoEntity(
	db: KnowledgeDb,
	version: VersionRow,
	undoId: string,
	now: number,
): string {
	const row = db
		.raw()
		.prepare(
			"SELECT id, typeId, name, keys, fields, attributes, cls, indexedAt, archived FROM entities WHERE id = ?",
		)
		.get(version.rowId) as Record<string, unknown> | undefined;
	if (row === undefined) {
		return `entity ${version.rowId}: no longer present`;
	}

	if (version.before === null) {
		// The change created this entity: undo archives it — but only
		// while the row still equals what the change wrote; a later
		// change's edits stand.
		if (Number(row.archived) !== 0) return "unchanged";
		const afterCreate = JSON.parse(version.after ?? "null") as Record<
			string,
			unknown
		> | null;
		if (
			afterCreate !== null &&
			JSON.stringify(afterCreate.fields) !== JSON.stringify(row.fields)
		) {
			return `entity "${String(row.name)}" (${version.rowId}): changed by a later change`;
		}
		writeVersion(db, undoId, "entities", version.rowId, row, { ...row, archived: 1 }, now);
		db.raw()
			.prepare("UPDATE entities SET archived = 1 WHERE id = ?")
			.run(version.rowId);
		return "restored";
	}

	const before = JSON.parse(version.before ?? "null") as Record<
		string,
		unknown
		> | null;
	const after = JSON.parse(version.after ?? "null") as Record<
		string,
		unknown
		> | null;
	if (
		before === null ||
		after === null ||
		JSON.stringify(after.fields) !== JSON.stringify(row.fields)
	) {
		return `entity "${String(row.name)}" (${version.rowId}): fields changed by a later change`;
	}
	const restoredRow = { ...row, ...before, id: row.id, archived: row.archived } as Record<string, unknown>;
	writeVersion(db, undoId, "entities", version.rowId, row, restoredRow, now);
	db.raw()
		.prepare(
			"UPDATE entities SET typeId = ?, name = ?, keys = ?, fields = ?, attributes = ?, indexedAt = ? WHERE id = ?",
		)
		.run(
			restoredRow.typeId as number,
			restoredRow.name as string,
			restoredRow.keys as string,
			restoredRow.fields as string,
			restoredRow.attributes as string,
			restoredRow.indexedAt as number | null,
			version.rowId,
		);
	return "restored";
}

function undoRole(
	db: KnowledgeDb,
	version: VersionRow,
	undoId: string,
	now: number,
): string {
	const row = db
		.raw()
		.prepare("SELECT id, inquiryId, entityId, role, reason FROM roles WHERE id = ?")
		.get(Number(version.rowId)) as Record<string, unknown> | undefined;
	if (row === undefined) return "unchanged";

	if (version.before === null) {
		// The change created this role: undo deletes it.
		const after = JSON.parse(version.after ?? "null") as Record<
			string,
			unknown
		> | null;
		if (after !== null && JSON.stringify(after.role) !== JSON.stringify(row.role)) {
			return `role ${version.rowId}: changed by a later change`;
		}
		writeVersion(db, undoId, "roles", version.rowId, row, null, now);
		db.raw().prepare("DELETE FROM roles WHERE id = ?").run(Number(version.rowId));
		return "restored";
	}

	const before = JSON.parse(version.before ?? "null") as Record<
		string,
		unknown
		> | null;
	const after = JSON.parse(version.after ?? "null") as Record<
		string,
		unknown
		> | null;
	if (
		before === null ||
		after === null ||
		JSON.stringify(after.role) !== JSON.stringify(row.role)
	) {
		return `role ${version.rowId}: changed by a later change`;
	}
	writeVersion(db, undoId, "roles", version.rowId, row, { ...row, ...before, id: row.id }, now);
	db.raw()
		.prepare("UPDATE roles SET role = ?, reason = ? WHERE id = ?")
		.run(before.role as string, (before.reason as string | null) ?? null, Number(version.rowId));
	return "restored";
}

function undoInquiry(
	db: KnowledgeDb,
	version: VersionRow,
	undoId: string,
	now: number,
): string {
	const row = db
		.raw()
		.prepare(
			"SELECT id, question, why, startedAt, touchedAt, conversations, outcome FROM inquiries WHERE id = ?",
		)
		.get(Number(version.rowId)) as Record<string, unknown> | undefined;
	if (row === undefined || version.before === null) return "unchanged";

	const before = JSON.parse(version.before ?? "null") as Record<
		string,
		unknown
		> | null;
	const after = JSON.parse(version.after ?? "null") as Record<
		string,
		unknown
		> | null;
	if (
		before === null ||
		after === null ||
		JSON.stringify(after.outcome) !== JSON.stringify(row.outcome)
	) {
		return `inquiry "${String(row.question)}" (${version.rowId}): outcome changed by a later change`;
	}
	writeVersion(db, undoId, "inquiries", version.rowId, row, { ...row, ...before, id: row.id }, now);
	db.raw()
		.prepare(
			"UPDATE inquiries SET conversations = ?, outcome = ?, touchedAt = ? WHERE id = ?",
		)
		.run(
			before.conversations as string,
			(before.outcome as string | null) ?? null,
			now,
			Number(version.rowId),
		);
	return "restored";
}

function undoEntityKey(
	db: KnowledgeDb,
	version: VersionRow,
	undoId: string,
	now: number,
): string {
	// applyRecord only ever creates key rows; undo removes them.
	if (version.before !== null) return "unchanged";
	const row = db
		.raw()
		.prepare(
			"SELECT id, entityId, typeFamilyRoot, key, normalized FROM entity_keys WHERE id = ?",
		)
		.get(Number(version.rowId)) as Record<string, unknown> | undefined;
	if (row === undefined) return "unchanged";
	writeVersion(db, undoId, "entity_keys", version.rowId, row, null, now);
	db.raw()
		.prepare("DELETE FROM entity_keys WHERE id = ?")
		.run(Number(version.rowId));
	return "restored";
}
