import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import { KnowledgeDb } from "../src/db.js";
import { applyRecord } from "../src/apply.js";
import { mirrorEntities } from "../src/mirror.js";
import { fakeHost, NOW, type Fake } from "./helpers.js";

function seeded(db: KnowledgeDb): string[] {
	const result = applyRecord(
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
		{ callId: "seed", now: NOW },
	);
	return result.touched;
}

describe("mirrorEntities", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	it("indexes a live entity with kind record and stores the returned class", async () => {
		fake = fakeHost({
			hooks: {
				"recall.index": (payload: unknown) => ({
					status: "ok",
					provider: "recall",
					value: { handle: "d:1", class: "local-only", changed: true },
				}),
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const [entityId] = seeded(db);
		await mirrorEntities(fake.host as never, db, "alice", [entityId!], NOW);
		const call = fake.calls.find((c) => c.name === "recall.index");
		expect(call).toBeDefined();
		const payload = call!.payload as Record<string, unknown>;
		expect(payload.id).toBe(entityId);
		expect(payload.kind).toBe("record");
		expect(payload.title).toContain("Northside Vet");
		expect(call!.opts?.user).toBe("alice");
		const row = db
			.raw()
			.prepare("SELECT cls, indexedAt FROM entities WHERE id = ?")
			.get(entityId) as { cls: string; indexedAt: number };
		expect(row.cls).toBe("local-only");
		expect(row.indexedAt).toBe(NOW);
	});

	it("removes an archived entity", async () => {
		fake = fakeHost({
			hooks: {
				"recall.remove": () => ({
					status: "ok",
					provider: "recall",
					value: { removed: true },
				}),
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const [entityId] = seeded(db);
		db.raw().prepare("UPDATE entities SET archived = 1 WHERE id = ?").run(entityId);
		await mirrorEntities(fake.host as never, db, "alice", [entityId!], NOW);
		const call = fake.calls.find((c) => c.name === "recall.remove");
		expect(call).toBeDefined();
		expect((call!.payload as { id: string }).id).toBe(entityId);
		expect(call!.opts?.user).toBe("alice");
	});

	it("absent recall does nothing and failed leaves the entity pending re-index", async () => {
		fake = fakeHost({}); // recall.index absent
		const db = KnowledgeDb.open(":memory:");
		const [entityId] = seeded(db);
		await mirrorEntities(fake.host as never, db, "alice", [entityId!], NOW);
		const row = db
			.raw()
			.prepare("SELECT indexedAt FROM entities WHERE id = ?")
			.get(entityId) as { indexedAt: number | null };
		expect(row.indexedAt).toBeNull();

		fake = fakeHost({
			hooks: {
				"recall.index": () => ({
					status: "rejected",
					provider: "recall",
					errors: [{ path: "", message: "bad" }],
				}),
			},
		});
		await mirrorEntities(fake.host as never, db, "alice", [entityId!], NOW);
		const still = db
			.raw()
			.prepare("SELECT indexedAt FROM entities WHERE id = ?")
			.get(entityId) as { indexedAt: number | null };
		expect(still.indexedAt).toBeNull();
	});
});
