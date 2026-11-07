import { afterEach, describe, expect, it } from "vitest";

import { applyRecord, normalizeKey, type RecordInput } from "../src/apply.js";
import type { KnowledgeDb } from "../src/db.js";
import type { TypeDef } from "../src/schema.js";
import { undoChange } from "../src/undo.js";
import {
	displayValue,
	entitiesOfType,
	entityDetail,
	inquiries,
	typeTree,
} from "../src/view-read.js";
import { memoryDb } from "./helpers.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const DAY_MS = 24 * 60 * 60 * 1000;

const placeType: TypeDef = {
	name: "acme place",
	description: "An Acme place.",
	fields: [],
};

const clinicType: TypeDef = {
	name: "acme clinic",
	description: "An Acme clinic.",
	parent: "acme place",
	fields: [{ name: "price", type: "money", horizonDays: 30 }],
};

let callSeq = 0;
function ctx(callId?: string): { callId: string; now: number } {
	return { callId: callId ?? `call-${++callSeq}`, now: NOW };
}

function entity(
	name: string,
	type = "acme clinic",
): NonNullable<RecordInput["entities"]>[number] {
	return { type, name, keys: {}, fields: {} };
}

describe("knowledge view read model", () => {
	let db: KnowledgeDb | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	function open(): KnowledgeDb {
		const store = memoryDb();
		db = store.openDb("knowledge");
		return db;
	}

	it("typeTree nests children under parents with counts", () => {
		const database = open();
		applyRecord(
			database,
			{
				types: [placeType, clinicType],
				entities: [
					entity("Acme Place", "acme place"),
					entity("North Clinic"),
					entity("South Clinic"),
				],
			},
			ctx("call-tree"),
		);

		const tree = typeTree(database.raw(), { includeArchived: false });
		expect(tree).toHaveLength(1);
		expect(tree[0]?.name).toBe("acme place");
		expect(tree[0]?.ownCount).toBe(1);
		expect(tree[0]?.totalCount).toBe(3);
		expect(tree[0]?.children).toHaveLength(1);
		expect(tree[0]?.children[0]?.name).toBe("acme clinic");
		expect(tree[0]?.children[0]?.ownCount).toBe(2);
		expect(tree[0]?.children[0]?.totalCount).toBe(2);
	});

	it("deep chain", () => {
		const database = open();
		applyRecord(
			database,
			{
				types: [
					placeType,
					clinicType,
					{
						name: "acme dental",
						description: "An Acme dental clinic.",
						parent: "acme clinic",
						fields: [],
					},
				],
				entities: [
					entity("Acme Place", "acme place"),
					entity("North Clinic"),
					entity("Acme Dental", "acme dental"),
				],
			},
			ctx("call-deep"),
		);

		const tree = typeTree(database.raw(), { includeArchived: false });
		expect(tree).toHaveLength(1);
		expect(tree[0]?.totalCount).toBe(3);
		expect(tree[0]?.children[0]?.children[0]?.name).toBe("acme dental");
		expect(tree[0]?.children[0]?.children[0]?.totalCount).toBe(1);
	});

	it("archived types hidden unless asked", () => {
		const database = open();
		applyRecord(
			database,
			{
				types: [placeType, clinicType],
				entities: [entity("North Clinic")],
			},
			ctx("call-type-archive"),
		);
		database
			.raw()
			.prepare("UPDATE types SET archived = 1 WHERE name = ?")
			.run("acme clinic");

		expect(typeTree(database.raw(), { includeArchived: false })).toHaveLength(1);
		expect(typeTree(database.raw(), { includeArchived: false })[0]?.children).toEqual([]);
		const included = typeTree(database.raw(), { includeArchived: true });
		expect(included[0]?.children[0]?.name).toBe("acme clinic");
		expect(included[0]?.children[0]?.archived).toBe(true);
	});

	it("entitiesOfType includes child types' entities, labelled, name-searchable", () => {
		const database = open();
		applyRecord(
			database,
			{
				types: [placeType, clinicType],
				entities: [
					entity("North Clinic"),
					entity("South Clinic"),
					entity("Acme Place", "acme place"),
				],
			},
			ctx("call-entities"),
		);
		const place = database
			.raw()
			.prepare("SELECT id FROM types WHERE name = ?")
			.get("acme place") as { id: number };

		const rows = entitiesOfType(database.raw(), place.id, { search: "", limit: 200 });
		expect(rows.map((row) => row.name)).toEqual([
			"Acme Place",
			"North Clinic",
			"South Clinic",
		]);
		expect(rows.find((row) => row.name === "North Clinic")?.type).toBe("acme clinic");
		expect(rows.find((row) => row.name === "North Clinic")?.localOnly).toBe(false);

		const narrowed = entitiesOfType(database.raw(), place.id, {
			search: "north",
			limit: 200,
		});
		expect(narrowed.map((row) => row.name)).toEqual(["North Clinic"]);
		const limited = entitiesOfType(database.raw(), place.id, { search: "", limit: 2 });
		expect(limited).toHaveLength(2);
	});

	it("archived entities are excluded", () => {
		const database = open();
		applyRecord(
			database,
			{
				types: [placeType, clinicType],
				entities: [
					entity("Acme Place", "acme place"),
					{ ...entity("North Clinic"), keys: { phone: "+1 (555) 010-2000" } },
					entity("South Clinic"),
				],
			},
			ctx("call-entity-archive"),
		);
		const place = database
			.raw()
			.prepare("SELECT id FROM types WHERE name = ?")
			.get("acme place") as { id: number };
		const archive = applyRecord(
			database,
			{ types: [placeType, clinicType], entities: [entity("North Clinic")] },
			ctx("call-archive-entity"),
		);
		const archivedId = archive.touched[0] as string;
		undoChange(database, archive.changeId, NOW + DAY_MS);

		expect(
			entitiesOfType(database.raw(), place.id, { search: "", limit: 200 }).map(
				(row) => row.id,
			),
		).not.toContain(archivedId);
		expect(typeTree(database.raw(), { includeArchived: false })[0]?.totalCount).toBe(3);
		expect(entityDetail(database.raw(), archivedId, NOW)).toBeUndefined();
	});

	it("keys show name and normalized value", () => {
		const database = open();
		const phone = "+1 (555) 010-2000";
		const change = applyRecord(
			database,
			{
				types: [placeType],
				entities: [{ ...entity("Acme Place", "acme place"), keys: { phone } }],
			},
			ctx("call-keys"),
		);

		const detail = entityDetail(database.raw(), change.touched[0] as string, NOW);
		expect(detail?.keys).toEqual([
			{ name: "phone", normalized: normalizeKey("phone", phone) },
		]);
	});

	it("entityDetail marks stale fields", () => {
		const database = open();
		const change = applyRecord(
			database,
			{
				types: [
					placeType,
					{ ...clinicType, fields: [...clinicType.fields, { name: "note", type: "string" }] },
				],
				entities: [
					{
						...entity("North Clinic"),
						fields: {
							price: {
								value: { amount: 12.5, currency: "CAD" },
								source: "recall:north",
								observedAt: new Date(NOW - 40 * DAY_MS).toISOString().slice(0, 10),
							},
							note: {
								value: "open",
								source: "recall:north",
								observedAt: new Date(NOW - 40 * DAY_MS).toISOString().slice(0, 10),
							},
						},
					},
				],
			},
			ctx("call-stale"),
		);

		const detail = entityDetail(database.raw(), change.touched[0] as string, NOW);
		expect(detail?.fields.find((field) => field.name === "price")).toMatchObject({
			value: "12.50 CAD",
			source: "recall:north",
			stale: true,
		});
		expect(detail?.fields.find((field) => field.name === "note")?.stale).toBe(false);
	});

	it("entityDetail roles and history", () => {
		const database = open();
		const created = applyRecord(
			database,
			{
				inquiry: { question: "Which clinic?" },
				types: [placeType, clinicType],
				entities: [
					{
						...entity("North Clinic"),
						keys: { phone: "+1 (555) 010-2000" },
						role: "candidate",
						reason: "nearby",
					},
				],
			},
			ctx("call-history"),
		);
		const entityId = created.touched[0] as string;
		applyRecord(
			database,
			{
				inquiry: { question: "Archived question" },
				types: [placeType, clinicType],
				entities: [
					{
						...entity("North Clinic"),
						keys: { phone: "+1 (555) 010-2000" },
						role: "chosen",
						fields: {
							price: {
								value: { amount: 12.5, currency: "CAD" },
								source: "recall:north",
								observedAt: "2026-10-20",
							},
						},
					},
				],
			},
			ctx("call-history-update"),
		);
		database
			.raw()
			.prepare("UPDATE inquiries SET archived = 1 WHERE question = ?")
			.run("Archived question");

		const detail = entityDetail(database.raw(), entityId, NOW);
		expect(detail?.roles).toEqual([
			{
				inquiryId: expect.any(Number),
				question: "Which clinic?",
				role: "candidate",
				reason: "nearby",
			},
		]);
		expect(detail?.history).toHaveLength(2);
		expect(detail?.history[0]?.label).toBe("changed");
		expect(detail?.history[1]?.label).toBe("created");
		expect(detail?.history[1]?.before).toBe("");
		expect(JSON.parse(detail?.history[0]?.after ?? "{}").fields).toBeTypeOf("object");
		expect(JSON.parse(detail?.history[1]?.after ?? "{}").keys).toEqual(["phone"]);

		const archivedChange = applyRecord(
			database,
			{ types: [placeType, clinicType], entities: [entity("Archive Target")] },
			ctx("call-archive-only"),
		);
		expect(archivedChange.errors).toEqual([]);
		const archiveEntityId = archivedChange.touched[0] as string;
		undoChange(database, archivedChange.changeId, NOW + DAY_MS);
		database
			.raw()
			.prepare("UPDATE entities SET archived = 0 WHERE id = ?")
			.run(archiveEntityId);
		const archiveDetail = entityDetail(database.raw(), archiveEntityId, NOW);
		expect(archiveDetail?.history[0]?.label).toBe("archived");
		expect(archiveDetail?.history[0]?.after).toContain('"archived": 1');
		const archivedCreate = applyRecord(
			database,
			{ types: [placeType, clinicType], entities: [entity("Second Archive Target")] },
			ctx("call-archive-target"),
		);
		const archivedId = archivedCreate.touched[0] as string;
		undoChange(database, archivedCreate.changeId, NOW + DAY_MS);
		const history = database
			.raw()
			.prepare('SELECT before, after FROM versions WHERE "table" = ? AND rowId = ? ORDER BY seq DESC')
			.all("entities", archivedId) as { before: string | null; after: string | null }[];
		expect(history[0]?.before).not.toBeNull();
		expect(JSON.parse(history[0]?.after ?? "{}").archived).toBe(1);
	});

	it("displayValue renders structured values", () => {
		expect(displayValue({ amount: 12.5, currency: "CAD" })).toBe("12.50 CAD");
		expect(displayValue([1, 2, 3])).toBe("1, 2, 3");
		expect(displayValue({ open: true })).toBe('{"open":true}');
		expect(displayValue(true)).toBe("yes");
		expect(displayValue(false)).toBe("no");
	});

	it("inquiries newest-touched first with entities", () => {
		const database = open();
		const first = applyRecord(
			database,
			{
				inquiry: { question: "Older question" },
				types: [placeType, clinicType],
				entities: [{ ...entity("North Clinic"), role: "candidate" }],
			},
			{ callId: "call-inquiry-old", now: NOW - DAY_MS, conversationId: 10 },
		);
		applyRecord(
			database,
			{
				inquiry: { question: "Newer question" },
				types: [placeType, clinicType],
				entities: [{ ...entity("South Clinic"), role: "chosen" }],
			},
			{ callId: "call-inquiry-new", now: NOW, conversationId: 11 },
		);

		const rows = inquiries(database.raw(), { includeArchived: false });
		expect(rows.map((row) => row.question)).toEqual(["Newer question", "Older question"]);
		expect(rows[1]?.conversations).toEqual([10]);
		expect(rows[1]?.entities).toEqual([
			{ id: first.touched[0] as string, name: "North Clinic", role: "candidate" },
		]);
	});

	it("malformed conversations", () => {
		const database = open();
		applyRecord(
			database,
			{
				inquiry: { question: "Malformed conversations" },
				types: [placeType],
				entities: [],
			},
			ctx("call-malformed"),
		);
		database
			.raw()
			.prepare("UPDATE inquiries SET conversations = ? WHERE question = ?")
			.run("not json", "Malformed conversations");

		expect(inquiries(database.raw(), { includeArchived: false })[0]?.conversations).toEqual([]);
	});
});
