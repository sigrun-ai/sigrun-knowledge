import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { applyRecord, type RecordInput } from "../src/apply.js";
import { KnowledgeDb } from "../src/db.js";
import type { TypeDef } from "../src/schema.js";
import { createTools } from "../src/tools.js";
import {
	callFind,
	callRecord,
	fakeHost,
	indexOk,
	NOW,
	type Fake,
} from "./helpers.js";

const CLINIC_TYPE: TypeDef = {
	name: "vet clinic",
	description: "A veterinary clinic.",
	fields: [
		{ name: "phone", type: "string", identity: true },
		{ name: "exam fee", type: "money", horizonDays: 30 },
	] satisfies TypeDef["fields"],
};

function recordInput(name: string, phone: string): RecordInput {
	return {
		inquiry: { question: "Biscuit's knee" },
		types: [CLINIC_TYPE],
		entities: [
			{
				type: "vet clinic",
				name,
				keys: { phone },
				fields: {
					"exam fee": {
						value: { amount: 80, currency: "CAD" },
						source: "d:12",
						observedAt: "2026-10-20",
					},
				},
				role: "candidate",
			},
		],
	};
}

describe("knowledge_record", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	it("applies, mirrors each entity with kind record, and returns details.curation", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			hooks: { "recall.index": (payload: unknown) => indexOk(payload) },
		});
		const dbMap = new Map<string, KnowledgeDb>();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => {
				let db = dbMap.get("alice");
				if (db === undefined) {
					db = KnowledgeDb.open(":memory:");
					dbMap.set("alice", db);
				}
				return db;
			},
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record");
		expect(record).toBeDefined();
		const result = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-a", conversationId: 42 },
		);
		expect(result.isError).toBeUndefined();
		expect(result.details?.curation?.changeId).not.toBe("");
		expect(result.details?.curation?.summary).toContain("Biscuit's knee");
		expect(result.output[0]!.text).toContain("Biscuit's knee");

		const indexCalls = fake.calls.filter((c) => c.name === "recall.index");
		expect(indexCalls).toHaveLength(1);
		const payload = indexCalls[0]!.payload as Record<string, unknown>;
		expect(payload.kind).toBe("record");
		expect(typeof payload.id).toBe("string");
		expect(payload.title).toContain("Northside Vet");
		expect(indexCalls[0]!.opts?.user).toBe("alice");

		// Mirrored class + indexedAt were stored.
		const db = dbMap.get("alice")!;
		const row = db
			.raw()
			.prepare("SELECT cls, indexedAt FROM entities")
			.get() as { cls: string; indexedAt: number | null };
		expect(row.cls).toBe("normal");
		expect(row.indexedAt).toBe(NOW);
	});

	it("inside a review fork, the inquiry records the parent conversation id, not the fork's", async () => {
		fake = fakeHost({
			users: { 99: "alice" },
			entryPages: { 99: [[99, 99, 99, 7]] },
			hooks: { "recall.index": (payload: unknown) => indexOk(payload) },
		});
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		await callRecord(record as never, recordInput("Northside Vet", "555-0100"), {
			callId: "call-fork",
			conversationId: 99,
		});
		const inquiry = db
			.raw()
			.prepare("SELECT conversations FROM inquiries WHERE question = ?")
			.get("Biscuit's knee") as { conversations: string };
		const conversations = JSON.parse(inquiry.conversations) as number[];
		expect(conversations).toEqual([7]);
		expect(conversations).not.toContain(99);
	});

	it("inside a review fork with more than 50 fork entries, the inquiry still records the parent conversation", async () => {
		fake = fakeHost({
			users: { 99: "alice" },
			entryPages: {
				99: [Array.from({ length: 50 }, () => 99), [99, 7]],
			},
			hooks: { "recall.index": (payload: unknown) => indexOk(payload) },
		});
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		await callRecord(record as never, recordInput("Northside Vet", "555-0100"), {
			callId: "call-fork-paged",
			conversationId: 99,
		});
		const inquiry = db
			.raw()
			.prepare("SELECT conversations FROM inquiries WHERE question = ?")
			.get("Biscuit's knee") as { conversations: string };
		expect(JSON.parse(inquiry.conversations)).toEqual([7]);
	});

	it("replay with the same callId neither re-applies nor re-indexes", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			hooks: { "recall.index": (payload: unknown) => indexOk(payload) },
		});
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		const first = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-replay", conversationId: 42 },
		);
		const callsAfterFirst = fake.calls.length;
		const second = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-replay", conversationId: 42 },
		);
		expect(second.details?.curation?.changeId).toBe(
			first.details?.curation?.changeId,
		);
		expect(fake.calls.length).toBe(callsAfterFirst);
		const versions = db
			.raw()
			.prepare("SELECT COUNT(*) AS n FROM versions")
			.get() as { n: number };
		expect(versions.n).toBeGreaterThan(0);
		const entities = db
			.raw()
			.prepare("SELECT COUNT(*) AS n FROM entities")
			.get() as { n: number };
		expect(entities.n).toBe(1);
	});

	it("with recall absent, still applies and reports its change", async () => {
		fake = fakeHost({ users: { 42: "alice" } }); // no hooks scripted: absent
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		const result = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-absent", conversationId: 42 },
		);
		expect(result.isError).toBeUndefined();
		expect(result.details?.curation?.changeId).not.toBe("");
		const row = db
			.raw()
			.prepare("SELECT indexedAt FROM entities")
			.get() as { indexedAt: number | null };
		expect(row.indexedAt).toBeNull();
	});

	it("with recall.index failed, the entity stays pending re-index", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			hooks: {
				"recall.index": () => ({
					status: "failed",
					provider: "recall",
					reason: "threw",
					error: "boom",
				}),
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		const result = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-failed", conversationId: 42 },
		);
		expect(result.isError).toBeUndefined();
		const row = db
			.raw()
			.prepare("SELECT indexedAt FROM entities")
			.get() as { indexedAt: number | null };
		expect(row.indexedAt).toBeNull();
	});

	it("returns the error lines and no details.curation on a validation error", async () => {
		fake = fakeHost({ users: { 42: "alice" } });
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		const bad = recordInput("Northside Vet", "555-0100");
		bad.entities[0]!.fields["exam fee"] = {
			value: "eighty",
			source: "d:12",
			observedAt: "2026-10-20",
		};
		const result = await callRecord(record as never, bad, {
			callId: "call-bad",
			conversationId: 42,
		});
		expect(result.details?.curation).toBeUndefined();
		expect(result.output[0]!.text).toContain("exam fee");
	});

	it("answers with an error text when the conversation has no acting user", async () => {
		fake = fakeHost({ users: {} });
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const record = tools.find((tool: { name: string }) => tool.name === "knowledge_record")!;
		const result = await callRecord(
			record as never,
			recordInput("Northside Vet", "555-0100"),
			{ callId: "call-nouser", conversationId: 42 },
		);
		expect(result.isError).toBe(true);
		expect(result.output[0]!.text.toLowerCase()).toContain("user");
	});
});

describe("knowledge_find", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	async function seededDb() {
		const db = KnowledgeDb.open(":memory:");
		// Parent type + child type, one entity each.
		applyRecord(
			db,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [
					CLINIC_TYPE,
					{
						name: "mobile clinic",
						description: "A clinic that comes to you.",
						parent: "vet clinic",
						fields: CLINIC_TYPE.fields,
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {
							"exam fee": {
								value: { amount: 40, currency: "CAD" },
								source: "d:12",
								observedAt: "2026-10-20",
							},
						},
						role: "candidate",
					},
					{
						type: "mobile clinic",
						name: "Wheels Paws",
						keys: { phone: "555-0199" },
						fields: {
							"exam fee": {
								value: { amount: 30, currency: "USD" },
								source: "d:13",
								observedAt: "2026-10-21",
							},
						},
						role: "shortlisted",
					},
				],
			},
			{ callId: "seed", now: NOW },
		);
		return db;
	}

	it("is never a target tool: it is declared replay-safe read-only", async () => {
		fake = fakeHost({ users: { 42: "alice" }, metas: { 42: { owner: "alice" } } });
		const db = KnowledgeDb.open(":memory:");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		expect(find.replay).toBe("safe");
	});

	it("by type includes child types; field lt on money compares amounts in one currency only", async () => {
		fake = fakeHost({ users: { 42: "alice" }, metas: { 42: { owner: "alice" } } });
		const db = await seededDb();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const byType = await callFind(
			find as never,
			{ queries: [{ type: "vet clinic" }] },
			{ conversationId: 42 },
		);
		expect(byType.output[0]!.text).toContain("Northside Vet");
		expect(byType.output[0]!.text).toContain("Wheels Paws");

		const cheap = await callFind(
			find as never,
			{
				queries: [
					{
						type: "vet clinic",
						field: {
							name: "exam fee",
							op: "lt",
							value: { amount: 50, currency: "CAD" },
						},
					},
				],
			},
			{ conversationId: 42 },
		);
		expect(cheap.output[0]!.text).toContain("Northside Vet");
		// 30 USD would be under 50 if currencies were ignored: it must not match.
		expect(cheap.output[0]!.text).not.toContain("Wheels Paws");
	});

	it("text falls back to LIKE when recall is absent", async () => {
		fake = fakeHost({ users: { 42: "alice" }, metas: { 42: { owner: "alice" } } });
		const db = await seededDb();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const result = await callFind(
			find as never,
			{ queries: [{ text: "Northside" }] },
			{ conversationId: 42 },
		);
		expect(result.output[0]!.text).toContain("Northside Vet");
		expect(result.output[0]!.text).not.toContain("Wheels Paws");
	});

	it("text search keeps only hits whose provider is knowledge", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			metas: { 42: { owner: "alice" } },
			hooks: {
				"recall.search": () => ({
					status: "ok",
					provider: "recall",
					value: {
						hits: [
							{
								handle: "d:9",
								kind: "doc",
								title: "unrelated",
								date: "2026-10-01",
								snippet: "",
								class: "normal",
								provider: "other",
								id: "other-1",
							},
						],
					},
				}),
			},
		});
		const db = await seededDb();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const result = await callFind(
			find as never,
			{ queries: [{ text: "clinic" }] },
			{ conversationId: 42 },
		);
		expect(result.output[0]!.text).toContain("No matching");
	});

	it("never shows a local-only entity", async () => {
		fake = fakeHost({ users: { 42: "alice" }, metas: { 42: { owner: "alice" } } });
		const db = await seededDb();
		db.raw()
			.prepare("UPDATE entities SET cls = 'local-only' WHERE name = ?")
			.run("Northside Vet");
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const result = await callFind(
			find as never,
			{ queries: [{ type: "vet clinic" }] },
			{ conversationId: 42 },
		);
		expect(result.output[0]!.text).not.toContain("Northside Vet");
		expect(result.output[0]!.text).toContain("Wheels Paws");
	});

	it("in alice's conversation shared with bob answers \"Not available here.\"", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			metas: {
				42: {
					owner: "alice",
					sharing: { scope: "people", users: ["bob"], level: "read" },
				},
			},
		});
		const db = await seededDb();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const result = await callFind(
			find as never,
			{ queries: [{ type: "vet clinic" }] },
			{ conversationId: 42 },
		);
		expect(result.output[0]!.text).toBe("Not available here.");
	});

	it("in alice's private conversation it lists her entities", async () => {
		fake = fakeHost({
			users: { 42: "alice" },
			metas: { 42: { owner: "alice" } },
		});
		const db = await seededDb();
		const tools = createTools({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const find = tools.find((tool: { name: string }) => tool.name === "knowledge_find")!;
		const result = await callFind(
			find as never,
			{ queries: [{ type: "vet clinic" }] },
			{ conversationId: 42 },
		);
		expect(result.output[0]!.text).toContain("Northside Vet");
		expect(result.output[0]!.text).toContain("observed 2026-10-20");
		expect(result.output[0]!.text).toContain("d:12");
		expect(result.output[0]!.text).toContain("Biscuit's knee");
	});
});
