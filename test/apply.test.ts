import { afterEach, describe, expect, it } from "vitest";

import {
	applyRecord,
	type RecordInput,
	retypeEntities,
} from "../src/apply.js";
import { KnowledgeDb } from "../src/db.js";
import type { TypeDef } from "../src/schema.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");

let callSeq = 0;
function ctx(callId?: string): { callId: string; now: number } {
	return { callId: callId ?? `call-${++callSeq}`, now: NOW };
}

const clinicType: TypeDef = {
	name: "vet clinic",
	description: "A veterinary clinic.",
	fields: [
		{ name: "phone", type: "string", identity: true },
		{ name: "website", type: "url", identity: true },
		{ name: "price", type: "money", horizonDays: 30 },
		{ name: "email", type: "string" },
	],
};

function clinic(
	name: string,
	phone: string,
	price: number,
	observedAt = "2026-10-20",
): RecordInput["entities"][number] {
	return {
		type: "vet clinic",
		name,
		keys: { phone },
		fields: {
			price: {
				value: { amount: price, currency: "CAD" },
				source: `recall:${name.toLowerCase().replace(/\s+/g, "-")}`,
				observedAt,
			},
		},
	};
}

function count(db: KnowledgeDb, table: string): number {
	const row = db
		.raw()
		.prepare(`SELECT COUNT(*) AS n FROM ${table}`)
		.get() as { n: number };
	return row.n;
}

describe("applyRecord", () => {
	let db: KnowledgeDb | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	const open = () => {
		db = KnowledgeDb.open(":memory:");
		return db;
	};

	it("a record creates the type, three clinics and the inquiry with roles, in one change", () => {
		const database = open();
		const input: RecordInput = {
			inquiry: { question: "Biscuit's knee", why: "needs surgery" },
			types: [clinicType],
			entities: [
				{ ...clinic("Northside Vet", "555-0100", 120), role: "candidate" },
				{
					...clinic("Riverside Animal Hospital", "555-0101", 95),
					role: "shortlisted",
				},
				{
					...clinic("Hilltop Pet Care", "555-0102", 140),
					role: "rejected",
					reason: "too far",
				},
			],
		};
		const result = applyRecord(database, input, ctx("call-create"));
		expect(result.errors).toEqual([]);
		expect(result.summary).toBe("recorded Biscuit's knee: 3 vet clinics");
		expect(result.touched).toHaveLength(3);
		expect(result.changeId).not.toBe("");

		expect(count(database, "types")).toBe(1);
		expect(count(database, "entities")).toBe(3);
		expect(count(database, "inquiries")).toBe(1);
		expect(count(database, "roles")).toBe(3);

		const role = database
			.raw()
			.prepare(
				`SELECT r.role AS role, r.reason AS reason, i.question AS question
				 FROM roles r JOIN inquiries i ON i.id = r.inquiryId
				 JOIN entities e ON e.id = r.entityId WHERE e.name = ?`,
			)
			.get("Hilltop Pet Care") as
			| { role: string; reason: string; question: string }
			| undefined;
		expect(role).toEqual({
			role: "rejected",
			reason: "too far",
			question: "Biscuit's knee",
		});

		const changeIds = database
			.raw()
			.prepare("SELECT DISTINCT changeId AS id FROM versions")
			.all() as { id: string }[];
		expect(changeIds).toEqual([{ id: result.changeId }]);
	});

	it("a validation error in the third entity rolls back the first two", () => {
		const database = open();
		const bad = clinic("Hilltop Pet Care", "555-0102", 140);
		bad.fields.price = {
			value: "expensive",
			source: "recall:hilltop",
			observedAt: "2026-10-20",
		};
		const result = applyRecord(
			database,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [clinicType],
				entities: [
					clinic("Northside Vet", "555-0100", 120),
					clinic("Riverside Animal Hospital", "555-0101", 95),
					bad,
				],
			},
			ctx("call-bad"),
		);
		expect(result.errors.length).toBeGreaterThan(0);
		expect(result.changeId).toBe("");
		expect(result.touched).toEqual([]);
		expect(count(database, "types")).toBe(0);
		expect(count(database, "entities")).toBe(0);
		expect(count(database, "inquiries")).toBe(0);
		expect(count(database, "versions")).toBe(0);
		expect(count(database, "applied")).toBe(0);
	});

	it("replaying the same callId returns the same result and writes nothing", () => {
		const database = open();
		const input: RecordInput = {
			types: [clinicType],
			entities: [clinic("Northside Vet", "555-0100", 120)],
		};
		const first = applyRecord(database, input, ctx("call-replay"));
		const second = applyRecord(database, input, ctx("call-replay"));
		expect(second).toEqual(first);
		expect(count(database, "entities")).toBe(1);
		expect(count(database, "types")).toBe(1);
	});

	it('"Northside Vet" with phone 555-0100 and "Northside Vet" with 555-0199 stay two entities', () => {
		const database = open();
		applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx(),
		);
		const second = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0199", 130)] },
			ctx(),
		);
		expect(second.errors).toEqual([]);
		expect(count(database, "entities")).toBe(2);
	});

	it('"(555) 0100" matches "555-0100"', () => {
		const database = open();
		const first = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx(),
		);
		const second = applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "(555) 0100", 130)] },
			ctx(),
		);
		expect(second.errors).toEqual([]);
		expect(second.touched).toEqual(first.touched);
		expect(count(database, "entities")).toBe(1);
	});

	it("a same-named entity with no keys is a new entity", () => {
		const database = open();
		applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx(),
		);
		const noKeys = clinic("Northside Vet", "555-0100", 120);
		noKeys.keys = {};
		const result = applyRecord(
			database,
			{ types: [clinicType], entities: [noKeys] },
			ctx(),
		);
		expect(result.errors).toEqual([]);
		expect(count(database, "entities")).toBe(2);
	});

	it("identity keys match across a parent/child type family", () => {
		const database = open();
		const family: TypeDef[] = [
			{
				name: "clinic",
				description: "Any clinic.",
				fields: [{ name: "phone", type: "string", identity: true }],
			},
			{
				name: "vet clinic",
				description: "A veterinary clinic.",
				parent: "clinic",
				fields: [{ name: "phone", type: "string", identity: true }],
			},
		];
		applyRecord(
			database,
			{
				types: family,
				entities: [
					{ type: "clinic", name: "Northside Vet", keys: { phone: "555-0100" }, fields: {} },
				],
			},
			ctx(),
		);
		const second = applyRecord(
			database,
			{
				types: family,
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "(555) 0100" },
						fields: {},
					},
				],
			},
			ctx(),
		);
		expect(second.errors).toEqual([]);
		expect(count(database, "entities")).toBe(1);
	});

	it("extending a type adds a field; a type update that drops or retypes a field is an error", () => {
		const database = open();
		applyRecord(
			database,
			{ types: [clinicType], entities: [clinic("Northside Vet", "555-0100", 120)] },
			ctx(),
		);
		const extended = applyRecord(
			database,
			{
				types: [
					{
						...clinicType,
						fields: [
							...clinicType.fields,
							{ name: "hours", type: "string" },
						],
					},
				],
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx(),
		);
		expect(extended.errors).toEqual([]);
		const fields = JSON.parse(
			(
				database
					.raw()
					.prepare("SELECT fields FROM types WHERE name = ?")
					.get("vet clinic") as { fields: string }
			).fields,
		) as { name: string }[];
		expect(fields.map((field) => field.name)).toContain("hours");

		const dropped = applyRecord(
			database,
			{
				types: [
					{
						...clinicType,
						fields: clinicType.fields.filter(
							(field) => field.name !== "website",
						),
					},
				],
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx(),
		);
		expect(dropped.errors.some((error) => error.includes("website"))).toBe(true);

		const retyped = applyRecord(
			database,
			{
				types: [
					{
						...clinicType,
						fields: clinicType.fields.map((field) =>
							field.name === "phone"
								? { ...field, type: "number" as const }
								: field,
						),
					},
				],
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx(),
		);
		expect(retyped.errors.some((error) => error.includes("phone"))).toBe(true);
	});

	it("retypeEntities moves extra values into attributes and keeps key matching working under the new family root", () => {
		const database = open();
		const family: TypeDef[] = [
			{
				name: "clinic",
				description: "Any clinic.",
				fields: [{ name: "phone", type: "string", identity: true }],
			},
			clinicType,
		];
		const created = applyRecord(
			database,
			{
				types: family,
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx("call-create"),
		);
		retypeEntities(database, created.touched, "clinic", "change-retype", NOW);
		const row = database
			.raw()
			.prepare(
				`SELECT e.fields AS fields, e.attributes AS attributes, t.name AS typeName
				 FROM entities e JOIN types t ON t.id = e.typeId WHERE e.name = ?`,
			)
			.get("Northside Vet") as {
			fields: string;
			attributes: string;
			typeName: string;
		};
		expect(row.typeName).toBe("clinic");
		expect(JSON.parse(row.fields)).toEqual({});
		const attributes = JSON.parse(row.attributes) as Record<string, unknown>;
		expect(attributes.price).toBeDefined();

		// Key matching still de-duplicates under the new family root.
		const second = applyRecord(
			database,
			{
				types: family,
				entities: [
					{
						type: "clinic",
						name: "Northside Vet",
						keys: { phone: "(555) 0100" },
						fields: {},
					},
				],
			},
			ctx("call-match"),
		);
		expect(second.errors).toEqual([]);
		expect(second.touched).toEqual(created.touched);
		expect(count(database, "entities")).toBe(1);
	});

	it("retypeEntities moves extra values into attributes and keeps key matching working under the new family root", () => {
		const database = open();
		const family: TypeDef[] = [
			{
				name: "clinic",
				description: "Any clinic.",
				fields: [{ name: "phone", type: "string", identity: true }],
			},
			clinicType,
		];
		const created = applyRecord(
			database,
			{
				types: family,
				entities: [clinic("Northside Vet", "555-0100", 120)],
			},
			ctx("call-create"),
		);
		retypeEntities(database, created.touched, "clinic", "change-retype", NOW);
		const row = database
			.raw()
			.prepare(
				"SELECT e.fields AS fields, e.attributes AS attributes, t.name AS typeName FROM entities e JOIN types t ON t.id = e.typeId WHERE e.name = ?",
			)
			.get("Northside Vet") as {
			fields: string;
			attributes: string;
			typeName: string;
		};
		expect(row.typeName).toBe("clinic");
		expect(JSON.parse(row.fields)).toEqual({});
		const attributes = JSON.parse(row.attributes) as Record<string, unknown>;
		expect(attributes.price).toBeDefined();

		// Key matching still de-duplicates under the new family root.
		const second = applyRecord(
			database,
			{
				types: family,
				entities: [
					{
						type: "clinic",
						name: "Northside Vet",
						keys: { phone: "(555) 0100" },
						fields: {},
					},
				],
			},
			ctx("call-match"),
		);
		expect(second.errors).toEqual([]);
		expect(second.touched).toEqual(created.touched);
		expect(count(database, "entities")).toBe(1);
	});

	it("rejects records over the type and entity limits", () => {
		const database = open();
		const tooManyTypes = applyRecord(
			database,
			{
				types: Array.from({ length: 11 }, (_, index) => ({
					name: `type ${index}`,
					description: "x",
					fields: [],
				})),
				entities: [],
			},
			ctx(),
		);
		expect(tooManyTypes.errors.length).toBeGreaterThan(0);

		const tooManyEntities = applyRecord(
			database,
			{
				types: [clinicType],
				entities: Array.from({ length: 51 }, (_, index) =>
					clinic(`Clinic ${index}`, `555-0${100 + index}`, 100),
				),
			},
			ctx(),
		);
		expect(tooManyEntities.errors.length).toBeGreaterThan(0);
	});
});
