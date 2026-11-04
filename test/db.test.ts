import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeDb } from "../src/db.js";
import type { FieldDef } from "../src/schema.js";
import { TypeDefSchema, validateValue } from "../src/schema.js";

describe("KnowledgeDb", () => {
	let dir: string;
	let db: KnowledgeDb | undefined;

	afterEach(() => {
		db?.close();
		db = undefined;
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	const open = () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-db-"));
		db = KnowledgeDb.open(join(dir, "knowledge.db"));
		return db;
	};

	it("creates the schema and reopens idempotently", () => {
		const first = open();
		first.close();
		// A second open of the same file must not fail on existing tables.
		db = KnowledgeDb.open(join(dir, "knowledge.db"));
		expect(db).toBeInstanceOf(KnowledgeDb);
	});

	it("creates the parent directory when missing", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-db-"));
		const nested = join(dir, "missing", "nested", "knowledge.db");
		db = KnowledgeDb.open(nested);
		expect(db).toBeInstanceOf(KnowledgeDb);
	});

	it("runs transactions with commit and rollback", () => {
		const database = open();
		database.transaction(() => {
			database
				.raw()
				.prepare("INSERT INTO applied (callId, changeId, result) VALUES (?, ?, ?)")
				.run("call-commit", "change-1", "{}");
		});
		const committed = database
			.raw()
			.prepare("SELECT callId FROM applied WHERE callId = ?")
			.get("call-commit");
		expect(committed).toBeDefined();

		expect(() =>
			database.transaction(() => {
				database
					.raw()
					.prepare(
						"INSERT INTO applied (callId, changeId, result) VALUES (?, ?, ?)",
					)
					.run("call-rollback", "change-2", "{}");
				throw new Error("abort");
			}),
		).toThrow("abort");
		const rolledBack = database
			.raw()
			.prepare("SELECT callId FROM applied WHERE callId = ?")
			.get("call-rollback");
		expect(rolledBack).toBeUndefined();
	});

	it("creates all eight planned tables", () => {
		const database = open();
		const rows = database
			.raw()
			.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
			.all() as { name: string }[];
		const names = new Set(rows.map((row) => row.name));
		for (const table of [
			"types",
			"entities",
			"entity_keys",
			"inquiries",
			"roles",
			"versions",
			"applied",
			"maintenance",
		]) {
			expect(names.has(table), `missing table ${table}`).toBe(true);
		}
	});
});

describe("validateValue", () => {
	const def = (partial: Partial<FieldDef>): FieldDef => ({
		name: "field",
		type: "string",
		...partial,
	});

	it("accepts and rejects strings", () => {
		expect(validateValue(def({ type: "string" }), "clinic note")).toBeUndefined();
		expect(validateValue(def({ type: "string" }), 42)).toMatch(/string/);
	});

	it("accepts and rejects numbers", () => {
		expect(validateValue(def({ type: "number" }), 3.5)).toBeUndefined();
		expect(validateValue(def({ type: "number" }), "3.5")).toMatch(/number/);
	});

	it("accepts and rejects booleans", () => {
		expect(validateValue(def({ type: "boolean" }), false)).toBeUndefined();
		expect(validateValue(def({ type: "boolean" }), "false")).toMatch(/boolean/);
	});

	it("accepts and rejects ISO dates", () => {
		expect(validateValue(def({ type: "date" }), "2026-11-04")).toBeUndefined();
		expect(validateValue(def({ type: "date" }), "11/04/2026")).toMatch(/date/);
	});

	it("accepts and rejects urls", () => {
		expect(
			validateValue(def({ type: "url" }), "https://example.invalid/clinic"),
		).toBeUndefined();
		expect(validateValue(def({ type: "url" }), "not a url")).toMatch(/url/);
	});

	it("accepts money with a 3-letter currency and rejects others", () => {
		expect(
			validateValue(def({ type: "money" }), { amount: 12.5, currency: "CAD" }),
		).toBeUndefined();
		expect(
			validateValue(def({ type: "money" }), { amount: 12.5, currency: "CADL" }),
		).toMatch(/currency/);
		expect(
			validateValue(def({ type: "money" }), { amount: "12.5", currency: "CAD" }),
		).toMatch(/amount/);
	});

	it("enforces enum membership", () => {
		const enumDef = def({ type: "enum", values: ["active", "archived"] });
		expect(validateValue(enumDef, "active")).toBeUndefined();
		expect(validateValue(enumDef, "missing")).toMatch(/enum|one of/);
	});

	it("checks list item types", () => {
		const listDef = def({ type: "list", item: "string" });
		expect(validateValue(listDef, ["alice", "bob"])).toBeUndefined();
		expect(validateValue(listDef, ["alice", 7])).toMatch(/item/);
		expect(validateValue(listDef, "alice")).toMatch(/list/);
	});

	it("validates list-of-enum membership against the def's values", () => {
		const listDef = def({
			type: "list",
			item: "enum",
			values: ["a", "b"],
		});
		expect(validateValue(listDef, ["a", "b"])).toBeUndefined();
		expect(validateValue(listDef, ["a", "zzz"])).toBe(
			"list item: expected one of: a, b",
		);
		// Permissive only when no values are declared.
		expect(
			validateValue(def({ type: "list", item: "enum" }), ["anything"]),
		).toBeUndefined();
	});
});

describe("TypeDefSchema", () => {
	it("rejects a type name violating the lowercase phrase pattern", async () => {
		const { Value } = await import("typebox/value");
		const base = {
			name: "clinic",
			description: "a vet clinic",
			fields: [],
		};
		expect(Value.Check(TypeDefSchema, base)).toBe(true);
		expect(Value.Check(TypeDefSchema, { ...base, name: "Clinic" })).toBe(false);
	});
});
