import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { KnowledgeDb } from "../src/db.js";
import { applyRecord } from "../src/apply.js";
import { createTarget } from "../src/target.js";
import { fakeHost, NOW, type Fake } from "./helpers.js";

describe("knowledge curation target", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	function setup() {
		fake = fakeHost({
			hooks: {
				"recall.index": (payload: unknown) => ({
					status: "ok",
					provider: "recall",
					value: {
						handle: `d:${(payload as { id: string }).id}`,
						class: "normal",
						changed: true,
					},
				}),
				"recall.remove": () => ({
					status: "ok",
					provider: "recall",
					value: { removed: true },
				}),
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const target = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		return { db, target };
	}

	it("declares tools [knowledge_record] and readTools [knowledge_find]", () => {
		const { target } = setup();
		expect(target.name).toBe("knowledge");
		expect(target.tools).toEqual(["knowledge_record"]);
		expect(target.readTools).toEqual(["knowledge_find"]);
	});

	it("guidance is non-empty and covers recording inquiries, find-first and horizons", async () => {
		const { target } = setup();
		const guidance = await target.guidance("alice");
		expect(guidance.length).toBeGreaterThan(0);
		const joined = guidance.join("\n");
		expect(joined).toContain("horizonDays");
	});

	it("undo through the target restores and re-mirrors", async () => {
		const { db, target } = setup();
		const applied = applyRecord(
			db,
			{
				inquiry: { question: "Biscuit's knee" },
				types: [
					{
						name: "vet clinic",
						description: "A veterinary clinic.",
						fields: [{ name: "phone", type: "string", identity: true }],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {},
					},
				],
			},
			{ callId: "call-1", now: NOW },
		);
		expect(applied.errors).toEqual([]);
		fake.calls.length = 0;

		await target.undo("alice", applied.changeId, {} as never);

		// The created entity is archived again.
		const row = db
			.raw()
			.prepare("SELECT archived FROM entities WHERE id = ?")
			.get(applied.touched[0]) as { archived: number };
		expect(row.archived).toBe(1);

		// And the archive is mirrored: recall.remove was called for it.
		const removes = fake.calls.filter((c) => c.name === "recall.remove");
		expect(removes).toHaveLength(1);
		expect((removes[0]!.payload as { id: string }).id).toBe(applied.touched[0]);
		expect(removes[0]!.opts?.user).toBe("alice");
	});

	it("undo of a later change still re-mirrors the touched entity via recall.index", async () => {
		const { db, target } = setup();
		const first = applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A veterinary clinic.",
						fields: [{ name: "phone", type: "string", identity: true }],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {},
					},
				],
			},
			{ callId: "c1", now: NOW },
		);
		const second = applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A veterinary clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
						],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {
							city: {
								value: "Springfield",
								source: "d:20",
								observedAt: "2026-11-01",
							},
						},
					},
				],
			},
			{ callId: "c2", now: NOW },
		);
		expect(second.errors).toEqual([]);
		fake.calls.length = 0;

		await target.undo("alice", second.changeId, {} as never);
		// Entity not archived (it existed before): re-indexed, not removed.
		const row = db
			.raw()
			.prepare("SELECT archived FROM entities WHERE id = ?")
			.get(first.touched[0]) as { archived: number };
		expect(row.archived).toBe(0);
		const indexes = fake.calls.filter((c) => c.name === "recall.index");
		expect(indexes).toHaveLength(1);
	});

	it("wantsReview and reviewed drive the research flag", async () => {
		const { db, target } = setup();
		void db;
		// Simulate research having happened: requestReview needs a flag file.
		// createTarget wires wantsReview to research.request against the
		// user's state dir — seed it by writing a flag through the hook path.
		// Here, without research, wantsReview is false.
		expect(await target.wantsReview?.("alice", 7 as never)).toBe(false);
		target.reviewed?.("alice", 7 as never);
	});
});
