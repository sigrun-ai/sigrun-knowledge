import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";

import type {
	CurationRunResult,
	MaintenanceBudget,
} from "@sigrun/sigrun/extension";

import { KnowledgeDb } from "../src/db.js";
import { applyRecord } from "../src/apply.js";
import { createTarget } from "../src/target.js";
import { fakeHost, NOW, type Fake } from "./helpers.js";

const USER = "alice";

interface TypeRow {
	id: number;
	name: string;
	parentId: number | null;
	fields: string;
	archived: number;
}

interface EntityRow {
	id: string;
	typeId: number;
	fields: string;
	attributes: string;
	indexedAt: number | null;
	archived: number;
}

function typeRow(db: KnowledgeDb, name: string): TypeRow {
	return db
		.raw()
		.prepare(
			"SELECT id, name, parentId, fields, archived FROM types WHERE name = ?",
		)
		.get(name) as unknown as TypeRow;
}

function entityRows(db: KnowledgeDb, typeId: number): EntityRow[] {
	return db
		.raw()
		.prepare(
			"SELECT id, typeId, fields, attributes, indexedAt, archived FROM entities WHERE typeId = ?",
		)
		.all(typeId) as unknown as EntityRow[];
}

function entityRow(db: KnowledgeDb, id: string): EntityRow {
	return db
		.raw()
		.prepare(
			"SELECT id, typeId, fields, attributes, indexedAt, archived FROM entities WHERE id = ?",
		)
		.get(id) as unknown as EntityRow;
}

function maintenanceRows(db: KnowledgeDb, kind: string) {
	return db
		.raw()
		.prepare(
			"SELECT kind, changeId, payload FROM maintenance WHERE kind = ?",
		)
		.all(kind) as { kind: string; changeId: string | null; payload: string }[];
}

/** Three sibling types sharing fields phone+city (Jaccard >= 0.5). */
function seedSiblings(db: KnowledgeDb, withEntities = true) {
	const applied = applyRecord(
		db,
		{
			types: [
				{
					name: "vet clinic",
					description: "A vet clinic.",
					fields: [
						{ name: "phone", type: "string", identity: true },
						{ name: "city", type: "string" },
					],
				},
				{
					name: "dental clinic",
					description: "A dental clinic.",
					fields: [
						{ name: "phone", type: "string", identity: true },
						{ name: "city", type: "string" },
					],
				},
				{
					name: "walk-in clinic",
					description: "A walk-in clinic.",
					fields: [
						{ name: "phone", type: "string", identity: true },
						{ name: "city", type: "string" },
					],
				},
			],
			entities: withEntities
				? [
						{
							type: "vet clinic",
							name: "Northside Vet",
							keys: { phone: "555-0100" },
							fields: {},
						},
						{
							type: "dental clinic",
							name: "Smile Dental",
							keys: { phone: "555-0200" },
							fields: {},
						},
						{
							type: "walk-in clinic",
							name: "Downtown Walk-In",
							keys: { phone: "555-0300" },
							fields: {},
						},
					]
				: [],
		},
		{ callId: "seed-1", now: NOW },
	);
	expect(applied.errors).toEqual([]);
	return applied;
}

function scriptBudget(scripts: CurationRunResult[]): {
	budget: MaintenanceBudget;
	runs: { input: string; tools: readonly string[] }[];
} {
	const runs: { input: string; tools: readonly string[] }[] = [];
	const budget: MaintenanceBudget = {
		deadline: NOW + 60_000,
		runs: scripts.length,
		async run(input, tools) {
			runs.push({ input, tools });
			const next = scripts.shift();
			if (next === undefined) throw new Error("unexpected run");
			return next;
		},
	};
	return { budget, runs };
}

function completed(text: string): CurationRunResult {
	return { status: "completed", text, changes: [] };
}

describe("knowledge idle pass (maintain)", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	function setup(scripts: CurationRunResult[]) {
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
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const target = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const scripted = scriptBudget(scripts);
		return { db, target, budget: scripted.budget, runs: scripted.runs };
	}

	it("three overlapping sibling types with general: true become children of a new parent; entities untouched", async () => {
		const { db, target, budget } = setup([
			completed(
				JSON.stringify({
					general: true,
					name: "clinic",
					description: "A clinic.",
					fields: [
						{ name: "phone", type: "string" },
						{ name: "city", type: "string" },
					],
				}),
			),
		]);
		// Siblings share phone+city but each carries a distinct field, so
		// none folds: all three become children of the new parent.
		const seeded = applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A vet clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
							{ name: "species", type: "string" },
						],
					},
					{
						name: "dental clinic",
						description: "A dental clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
							{ name: "services", type: "string" },
						],
					},
					{
						name: "walk-in clinic",
						description: "A walk-in clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
							{ name: "hours", type: "string" },
						],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {},
					},
					{
						type: "dental clinic",
						name: "Smile Dental",
						keys: { phone: "555-0200" },
						fields: {},
					},
					{
						type: "walk-in clinic",
						name: "Downtown Walk-In",
						keys: { phone: "555-0300" },
						fields: {},
					},
				],
			},
			{ callId: "seed-t1", now: NOW },
		);
		expect(seeded.errors).toEqual([]);

		const report = await target.maintain!(USER, {} as never, budget);

		const parent = typeRow(db, "clinic");
		expect(parent.parentId).toBeNull();
		expect(JSON.parse(parent.fields)).toEqual([
			{ name: "phone", type: "string" },
			{ name: "city", type: "string" },
		]);
		for (const name of ["vet clinic", "dental clinic", "walk-in clinic"]) {
			const child = typeRow(db, name);
			expect(child.parentId).toBe(parent.id);
			// The shared fields moved to the parent; the distinct field stays.
			const fields = JSON.parse(child.fields) as { name: string }[];
			expect(fields.map((field) => field.name)).toHaveLength(1);
			expect(child.archived).toBe(0);
		}
		// Entities are untouched: same types, same fields.
		for (const id of seeded.touched) {
			const row = entityRow(db, id);
			expect(row.fields).toBe("{}");
			expect(row.attributes).toBe("{}");
		}
		expect(report.changes).toHaveLength(1);
		expect(report.changes[0]!.summary).toBe(
			"generalized vet clinic, dental clinic, walk-in clinic into clinic",
		);
		expect(report.more).toBeUndefined();
	});

	it("a child with no distinct fields is folded: entities re-typed with extra values in attributes, no value lost", async () => {
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
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const target = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		// "walk-in clinic" has only the shared fields; its entity carries a
		// "city" value which stays (parent declares it), while an attribute
		// survives untouched.
		applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A vet clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
							{ name: "species", type: "string" },
						],
					},
					{
						name: "dental clinic",
						description: "A dental clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
							{ name: "services", type: "string" },
						],
					},
					{
						name: "walk-in clinic",
						description: "A walk-in clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
						],
					},
				],
				entities: [
					{
						type: "walk-in clinic",
						name: "Downtown Walk-In",
						keys: { phone: "555-0300" },
						fields: {
							city: {
								value: "Springfield",
								source: "d:1",
								observedAt: "2026-11-01",
							},
						},
						attributes: { note: "evenings only" },
					},
				],
			},
			{ callId: "seed-fold", now: NOW },
		);
		const { budget } = scriptBudget([
			completed(
				JSON.stringify({
					general: true,
					name: "clinic",
					description: "A clinic.",
					fields: [
						{ name: "phone", type: "string" },
						{ name: "city", type: "string" },
					],
				}),
			),
		]);

		await target.maintain!(USER, {} as never, budget);

		const parent = typeRow(db, "clinic");
		const folded = typeRow(db, "walk-in clinic");
		expect(folded.archived).toBe(1);
		// Distinct-field children keep their distinct fields only.
		expect(JSON.parse(typeRow(db, "vet clinic").fields)).toEqual([
			{ name: "species", type: "string" },
		]);
		expect(JSON.parse(typeRow(db, "dental clinic").fields)).toEqual([
			{ name: "services", type: "string" },
		]);
		// The folded entity moved to the parent; the city value stays a
		// field (the parent declares it), the note stays an attribute.
		const entities = entityRows(db, parent.id);
		expect(entities).toHaveLength(1);
		expect(JSON.parse(entities[0]!.fields)).toEqual({
			city: { value: "Springfield", source: "d:1", observedAt: "2026-11-01" },
		});
		expect(JSON.parse(entities[0]!.attributes)).toEqual({
			note: "evenings only",
		});
		// The folded entity was re-indexed.
		expect(entities[0]!.indexedAt).toBe(NOW);
	});

	it("120 entities to re-type: 50 this pass with more true, the rest next pass under the same change id", async () => {
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
			},
		});
		const db = KnowledgeDb.open(":memory:");
		const target = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => NOW,
		});
		const defs: import("../src/schema.js").TypeDef[] = [
			{
				name: "vet clinic",
				description: "A vet clinic.",
				fields: [
					{ name: "phone", type: "string", identity: true },
					{ name: "city", type: "string" },
					{ name: "species", type: "string" },
				],
			},
			{
				name: "dental clinic",
				description: "A dental clinic.",
				fields: [
					{ name: "phone", type: "string", identity: true },
					{ name: "city", type: "string" },
					{ name: "services", type: "string" },
				],
			},
			{
				name: "walk-in clinic",
				description: "A walk-in clinic.",
				fields: [
					{ name: "phone", type: "string", identity: true },
					{ name: "city", type: "string" },
				],
			},
		];
		applyRecord(db, { types: defs, entities: [] }, { callId: "seed-t", now: NOW });
		// 120 entities on the foldable type, in batches of 50.
		for (let batch = 0; batch < 3; batch++) {
			const entities = [];
			for (let i = 0; i < 50 && batch * 50 + i < 120; i++) {
				const n = batch * 50 + i;
				entities.push({
					type: "walk-in clinic",
					name: `Clinic ${n}`,
					keys: { phone: `555-${String(1000 + n)}` },
					fields: {},
				});
			}
			applyRecord(db, { entities }, { callId: `seed-e-${batch}`, now: NOW });
		}

		const { budget } = scriptBudget([
			completed(
				JSON.stringify({
					general: true,
					name: "clinic",
					description: "A clinic.",
					fields: [
						{ name: "phone", type: "string" },
						{ name: "city", type: "string" },
					],
				}),
			),
		]);

		const first = await target.maintain!(USER, {} as never, budget);
		expect(first.more).toBe(true);
		expect(first.changes).toHaveLength(1);
		const changeId = first.changes[0]!.changeId;
		const parent = typeRow(db, "clinic");
		expect(entityRows(db, parent.id)).toHaveLength(50);

		// Next pass: no run needed (continuation comes before proposing).
		const { budget: budget2, runs: runs2 } = scriptBudget([]);
		const second = await target.maintain!(USER, {} as never, budget2);
		expect(runs2).toHaveLength(0);
		expect(second.more).toBe(true);
		expect(entityRows(db, parent.id)).toHaveLength(100);

		const { budget: budget3, runs: runs3 } = scriptBudget([]);
		const third = await target.maintain!(USER, {} as never, budget3);
		expect(runs3).toHaveLength(0);
		expect(third.more).toBeUndefined();
		expect(entityRows(db, parent.id)).toHaveLength(120);

		// All passes shared the one change id.
		const retypeChanges = db
			.raw()
			.prepare(
				`SELECT DISTINCT changeId FROM versions v
				 WHERE v."table" = 'entities' AND NOT EXISTS (
				   SELECT 1 FROM applied a WHERE a.changeId = v.changeId)`,
			)
			.all() as { changeId: string }[];
		expect(retypeChanges.map((row) => row.changeId)).toEqual([changeId]);
	});

	it("general: false or unparseable output changes nothing and the group isn't asked again within 30 days", async () => {
		const { db, target, runs } = setup([completed("not json at all")]);
		seedSiblings(db);

		const first = await target.maintain!(USER, {} as never, budget(NOW));
		expect(first.changes).toHaveLength(0);
		expect(runs).toHaveLength(1);
		// The run's allow list is never empty.
		expect(runs[0]!.tools).toEqual(["knowledge_find"]);
		expect(maintenanceRows(db, "declined-generalization")).toHaveLength(1);
		// No type was created.
		expect(
			db.raw().prepare("SELECT COUNT(*) AS n FROM types").get() as { n: number },
		).toEqual({ n: 3 });

		// Second pass (same clock): remembered, not re-asked.
		const again = await target.maintain!(USER, {} as never, budget(NOW));
		expect(again.changes).toHaveLength(0);
		expect(runs).toHaveLength(1);

		// After 30 days the group is re-asked (target on a later clock).
		const later = NOW + 31 * 24 * 60 * 60 * 1000;
		const laterTarget = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => later,
		});
		await laterTarget.maintain!(USER, {} as never, budget(later));
		expect(runs).toHaveLength(2);

		function budget(at: number): MaintenanceBudget {
			return {
				deadline: at + 60_000,
				runs: 1,
				run: async (input, tools) => {
					runs.push({ input, tools });
					return completed("not json at all");
				},
			};
		}
	});

	it("two sibling types (below 3) never trigger a run; budget.runs 0 skips proposing", async () => {
		const { db, target, runs } = setup([]);
		applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A vet clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
						],
					},
					{
						name: "dental clinic",
						description: "A dental clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "city", type: "string" },
						],
					},
				],
				entities: [],
			},
			{ callId: "seed-2", now: NOW },
		);
		const { budget: b1 } = scriptBudget([]);
		const report = await target.maintain!(USER, {} as never, {
			...b1,
			runs: 1,
		});
		expect(report.changes).toHaveLength(0);
		expect(runs).toHaveLength(0);

		// runs: 0 skips proposing even with a qualifying group.
		seedSiblings(db);
		const zero: MaintenanceBudget = {
			deadline: NOW + 60_000,
			runs: 0,
			run: async () => {
				throw new Error("must not run");
			},
		};
		const skipped = await target.maintain!(USER, {} as never, zero);
		expect(skipped.changes).toHaveLength(0);
	});

	it("undo of a generalization restores the original types and entity types", async () => {
		const { db, target, budget } = setup([
			completed(
				JSON.stringify({
					general: true,
					name: "clinic",
					description: "A clinic.",
					fields: [
						{ name: "phone", type: "string" },
						{ name: "city", type: "string" },
					],
				}),
			),
		]);
		seedSiblings(db);
		const before = {
			vet: typeRow(db, "vet clinic"),
			dental: typeRow(db, "dental clinic"),
			walkin: typeRow(db, "walk-in clinic"),
		};
		const entityIds = {
			vet: entityRows(db, before.vet.id).map((row) => row.id),
			dental: entityRows(db, before.dental.id).map((row) => row.id),
			walkin: entityRows(db, before.walkin.id).map((row) => row.id),
		};

		const report = await target.maintain!(USER, {} as never, budget);
		await target.undo(USER, report.changes[0]!.changeId, {} as never);

		const vet = typeRow(db, "vet clinic");
		const dental = typeRow(db, "dental clinic");
		const walkin = typeRow(db, "walk-in clinic");
		expect(vet.parentId).toBe(before.vet.parentId);
		expect(vet.fields).toBe(before.vet.fields);
		expect(vet.archived).toBe(0);
		expect(dental.parentId).toBeNull();
		expect(dental.fields).toBe(before.dental.fields);
		expect(walkin.archived).toBe(0);
		expect(walkin.fields).toBe(before.walkin.fields);

		// Entities returned to their original types.
		for (const id of entityIds.vet) expect(entityRow(db, id).typeId).toBe(vet.id);
		for (const id of entityIds.dental) expect(entityRow(db, id).typeId).toBe(dental.id);
		for (const id of entityIds.walkin) expect(entityRow(db, id).typeId).toBe(walkin.id);
	});

	it("after generalization a record with the same identity key MERGES (no duplicate), and inherited fields validate and render stale", async () => {
		const { db, target, budget } = setup([
			completed(
				JSON.stringify({
					general: true,
					name: "clinic",
					description: "A clinic.",
					fields: [
						{ name: "phone", type: "string", identity: true },
						{ name: "price", type: "money", horizonDays: 30 },
					],
				}),
			),
		]);
		applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A vet clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "price", type: "money", horizonDays: 30 },
							{ name: "species", type: "string" },
						],
					},
					{
						name: "dental clinic",
						description: "A dental clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "price", type: "money", horizonDays: 30 },
							{ name: "services", type: "string" },
						],
					},
					{
						name: "walk-in clinic",
						description: "A walk-in clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "price", type: "money", horizonDays: 30 },
							{ name: "hours", type: "string" },
						],
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
			{ callId: "seed-inherit", now: NOW },
		);

		await target.maintain!(USER, {} as never, budget);
		const parent = typeRow(db, "clinic");

		// Re-record the same identity key: it must MERGE, not duplicate —
		// and the inherited (parent-declared) field validates.
		const merged = applyRecord(
			db,
			{
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {
							price: {
								value: { amount: 60, currency: "CAD" },
								source: "d:2",
								observedAt: "2026-09-20",
							},
						},
					},
				],
			},
			{ callId: "merge-inherit", now: NOW },
		);
		expect(merged.errors).toEqual([]);
		const all = db
			.raw()
			.prepare("SELECT COUNT(*) AS n FROM entities WHERE archived = 0")
			.get() as { n: number };
		expect(all.n).toBe(1);
		// The key row family root moved to the parent.
		const keyRow = db
			.raw()
			.prepare("SELECT typeFamilyRoot FROM entity_keys WHERE entityId = ?")
			.get(merged.touched[0]!) as { typeFamilyRoot: number };
		expect(keyRow.typeFamilyRoot).toBe(parent.id);
		// The inherited field's horizon applies in the card: observed
		// 2026-09-20 + 30 days < NOW => stale.
		const { renderCard } = await import("../src/card.js");
		const card = renderCard(db, merged.touched[0]!, NOW);
		expect(card.text).toContain("stale");
	});

	it("an entity whose field crossed its horizon since indexing is re-indexed", async () => {
		const { db, target } = setup([]);
		const seeded = applyRecord(
			db,
			{
				types: [
					{
						name: "vet clinic",
						description: "A vet clinic.",
						fields: [
							{ name: "phone", type: "string", identity: true },
							{ name: "price", type: "money", horizonDays: 30 },
						],
					},
				],
				entities: [
					{
						type: "vet clinic",
						name: "Northside Vet",
						keys: { phone: "555-0100" },
						fields: {
							price: {
								value: { amount: 60, currency: "CAD" },
								source: "d:1",
								observedAt: "2026-10-01",
							},
						},
					},
				],
			},
			{ callId: "seed-horizon", now: NOW },
		);
		// Pretend the entity was indexed while fresh (before the horizon
		// crossed on 2026-10-31): stamp indexedAt by hand.
		db.raw()
			.prepare("UPDATE entities SET indexedAt = ? WHERE id = ?")
			.run(Date.parse("2026-10-15T00:00:00Z"), seeded.touched[0]);
		fake.calls.length = 0;

		const zero: MaintenanceBudget = {
			deadline: NOW + 60_000,
			runs: 0,
			run: async () => {
				throw new Error("must not run");
			},
		};
		await target.maintain!(USER, {} as never, zero);
		expect(
			fake.calls.filter((call) => call.name === "recall.index").length,
		).toBe(1);
		expect(entityRow(db, seeded.touched[0]!).indexedAt).toBe(NOW);
	});

	it("a deadline after a general:true answer stops without a decline row and reports more", async () => {
		const { db } = setup([]);
		seedSiblings(db);
		let calls = 0;
		// The deadline passes DURING the run (the answer arrives late).
		let clock = NOW;
		const lateTarget = createTarget({
			host: fake.host as never,
			dbForUser: () => db,
			now: () => clock,
		});
		const budget: MaintenanceBudget = {
			deadline: NOW + 1_000,
			runs: 1,
			run: async () => {
				calls++;
				clock = NOW + 60_000;
				return completed(
					JSON.stringify({
						general: true,
						name: "clinic",
						description: "A clinic.",
						fields: [{ name: "phone", type: "string" }],
					}),
				);
			},
		};
		const report = await lateTarget.maintain!(USER, {} as never, budget);
		expect(calls).toBe(1);
		expect(report.changes).toHaveLength(0);
		expect(report.more).toBe(true);
		// No decline remembered; no parent created.
		expect(maintenanceRows(db, "declined-generalization")).toHaveLength(0);
		expect(
			db.raw().prepare("SELECT COUNT(*) AS n FROM types").get() as { n: number },
		).toEqual({ n: 3 });
	});

	it("pending re-index entities are mirrored first", async () => {
		const { db, target } = setup([]);
		const seeded = seedSiblings(db);
		// Newly applied entities have indexedAt NULL = pending. No runs
		// scripted; with runs budget 0 the pass only re-indexes.
		const zero: MaintenanceBudget = {
			deadline: NOW + 60_000,
			runs: 0,
			run: async () => {
				throw new Error("must not run");
			},
		};
		const report = await target.maintain!(USER, {} as never, zero);
		expect(report.changes).toHaveLength(0);
		for (const id of seeded.touched) {
			expect(entityRow(db, id).indexedAt).toBe(NOW);
		}
		expect(fake.calls.filter((call) => call.name === "recall.index").length).toBe(3);
	});
});
