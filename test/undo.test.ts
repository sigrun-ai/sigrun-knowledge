import { afterEach, describe, expect, it } from "vitest";

import { applyRecord, type RecordInput } from "../src/apply.js";
import { KnowledgeDb } from "../src/db.js";
import type { TypeDef } from "../src/schema.js";
import { undoChange } from "../src/undo.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const LATER = Date.parse("2026-11-02T12:00:00Z");

let callSeq = 0;
function ctx(callId?: string): { callId: string; now: number } {
	return { callId: callId ?? `call-${++callSeq}`, now: NOW };
}

const clinicType: TypeDef = {
	name: "vet clinic",
	description: "A veterinary clinic.",
	fields: [
		{ name: "phone", type: "string", identity: true },
		{ name: "price", type: "money", horizonDays: 30 },
	],
};

function clinic(
	name: string,
	phone: string,
	price: number,
): RecordInput["entities"][number] {
	return {
		type: "vet clinic",
		name,
		keys: { phone },
		fields: {
			price: {
				value: { amount: price, currency: "CAD" },
				source: "recall:test",
				observedAt: "2026-10-20",
			},
		},
	};
}

function entity(
	db: KnowledgeDb,
	name: string,
): { id: string; fields: string; archived: number } {
	return db
		.raw()
		.prepare("SELECT id, fields, archived FROM entities WHERE name = ?")
		.get(name) as { id: string; fields: string; archived: number };
}

describe("undoChange", () => {
	let db: KnowledgeDb | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	const open = () => {
		db = KnowledgeDb.open(":memory:");
		return db;
	};

	it("undo of change A after change B edited the same field keeps B's value and lists the skip", () => {
		const database = open();
		const changeA = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx("call-a"),
		);
		const changeB = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 150)] },
			ctx("call-b"),
		);
		const undoA = undoChange(database, changeA.changeId, LATER);
		expect(undoA.restored).toBe(0);
		expect(undoA.skipped.length).toBeGreaterThan(0);
		// B's value stands.
		const row = entity(database, "Northside Vet");
		expect(
			(JSON.parse(row.fields) as { price: { value: { amount: number } } })
				.price.value.amount,
		).toBe(150);

		// Undoing B restores A's value.
		const undoB = undoChange(database, changeB.changeId, LATER);
		expect(undoB.skipped).toEqual([]);
		expect(undoB.restored).toBeGreaterThan(0);
		const after = entity(database, "Northside Vet");
		expect(
			(JSON.parse(after.fields) as { price: { value: { amount: number } } })
				.price.value.amount,
		).toBe(120);
	});

	it("undo of a change that created an entity archives it", () => {
		const database = open();
		const change = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx("call-create"),
		);
		const undo = undoChange(database, change.changeId, LATER);
		expect(undo.restored).toBeGreaterThan(0);
		expect(undo.skipped).toEqual([]);
		const row = entity(database, "Northside Vet");
		expect(row.archived).toBe(1);
	});

	it("undo is itself recorded as versions", () => {
		const database = open();
		const change = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx("call-create"),
		);
		undoChange(database, change.changeId, LATER);
		const undoVersions = database
			.raw()
			.prepare("SELECT changeId FROM versions WHERE changeId = ?")
			.all(`undo:${change.changeId}`) as { changeId: string }[];
		expect(undoVersions.length).toBeGreaterThan(0);
	});

	it("undo of a change that only added a role removes that role", () => {
		const database = open();
		applyRecord(
			database,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [clinicType],
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx("call-create"),
		);
		const withRole = applyRecord(
			database,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [clinicType],
				entities: [
					{ ...clinic("Northside Vet", "555-0100", 120), role: "chosen" },
				],
			},
			ctx("call-role"),
		);
		const undo = undoChange(database, withRole.changeId, LATER);
		expect(undo.restored).toBeGreaterThan(0);
		const roles = database
			.raw()
			.prepare("SELECT role FROM roles")
			.all() as { role: string }[];
		expect(roles).toEqual([]);
	});
});
