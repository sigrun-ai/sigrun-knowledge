import { afterEach, describe, expect, it } from "vitest";

import { applyRecord, type RecordInput } from "../src/apply.js";
import { renderCard } from "../src/card.js";
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
		{ name: "price", type: "money", horizonDays: 30 },
		{ name: "notes", type: "string" },
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
				source: "recall:price-page",
				observedAt,
			},
			notes: {
				value: "friendly staff",
				source: "recall:visit-note",
				observedAt: "2026-10-30",
			},
		},
	};
}

describe("renderCard", () => {
	let db: KnowledgeDb | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
	});

	const open = () => {
		db = KnowledgeDb.open(":memory:");
		return db;
	};

	it("renders the title, fields with observed dates, roles and sources", () => {
		const database = open();
		const result = applyRecord(
			database,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [clinicType],
				entities: [{ ...clinic("Northside Vet", "555-0100", 120), role: "shortlisted" }],
			},
			ctx("call-1"),
		);
		const card = renderCard(database, result.touched[0], NOW);
		expect(card.title).toBe("vet clinic — Northside Vet");
		expect(card.text).toContain("price");
		expect(card.text).toContain("observed 2026-10-20");
		expect(card.text).toContain("Biscuit's knee");
		expect(card.text).toContain("shortlisted");
		expect(card.sources).toEqual(
			expect.arrayContaining(["recall:price-page", "recall:visit-note"]),
		);
		expect(card.date).not.toBe("");
	});

	it("marks a price field older than its 30-day horizon as stale", () => {
		const database = open();
		const result = applyRecord(
			database,
			{
				types: [clinicType],
				entities: [clinic("Northside Vet", "555-0100", 120, "2026-09-15")],
			},
			ctx("call-1"),
		);
		const card = renderCard(database, result.touched[0], NOW);
		expect(card.text).toMatch(/price.*\(observed 2026-09-15, stale\)/);
		// The notes field was observed recently: no stale mark.
		expect(card.text).toMatch(/notes:.*\(observed 2026-10-30\)/);
	});
});
