/**
 * The Knowledge view surface: a read-only, principal-owned drill-down from
 * the type tree to entities and inquiries. Every rendered tree goes through
 * the server's validator, and every read is scoped to the calling user.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { validateTree } from "@sigrun/sigrun/blocks";
import type {
	Principal,
	SigrunHost,
	SurfaceContext,
	SurfaceDef,
} from "@sigrun/sigrun/extension";
import { applyRecord, type RecordInput } from "../src/apply.js";
import type { KnowledgeDb } from "../src/db.js";
import type { TypeDef } from "../src/schema.js";
import { createKnowledgeView } from "../src/view.js";
import { fakeHost, memoryDb, NOW } from "./helpers.js";

const ALICE = "alice";
const BOB = "bob";
const CAROL = "carol";
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
function callId(): string {
	return `view-call-${++callSeq}`;
}

function principal(user: string | undefined): Principal {
	return { user, admin: false, service: false, method: "token" };
}

function ctxOf(
	user: string | undefined,
	params: Record<string, unknown> = {},
): SurfaceContext {
	return {
		principal: principal(user),
		params: params as SurfaceContext["params"],
		key: "test",
		signal: new AbortController().signal,
	};
}

interface Fixture {
	readonly view: SurfaceDef<"view">;
	readonly db: KnowledgeDb;
	readonly opened: string[];
	readonly storePath: (user: string) => string;
	readonly dir: string;
}

const fixtures: Fixture[] = [];
afterEach(() => {
	for (const fixture of fixtures) fixture.db.close();
	fixtures.length = 0;
});

function fixture(): Fixture {
	const fake = fakeHost();
	const memory = memoryDb();
	const opened: string[] = [];
	const storePath = (user: string): string =>
		join(fake.host.stores.user(user).paths.data, "knowledge.db");
	const view = createKnowledgeView({
		host: fake.host as unknown as SigrunHost,
		storePath,
		now: () => NOW,
		// The production opener's existence check is still exercised: this
		// marker stands for a real SQLite file while reads stay in memory.
		storeExists: (user) => existsSync(storePath(user)),
		dbForUser: (user) => {
			opened.push(user);
			return memory.openDb(storePath(user));
		},
	});
	const db = memory.openDb(storePath(ALICE));
	mkdirSync(fake.host.stores.user(ALICE).paths.data, { recursive: true });
	writeFileSync(storePath(ALICE), "");
	const result = { view, db, opened, storePath, dir: fake.dir };
	fixtures.push(result);
	return result;
}

function record(
	db: KnowledgeDb,
	entities: NonNullable<RecordInput["entities"]>,
	opts: { question?: string; conversationId?: number } = {},
): ReturnType<typeof applyRecord> {
	return applyRecord(
		db,
		{
			...(opts.question === undefined ? {} : { inquiry: { question: opts.question } }),
			types: [placeType, clinicType],
			entities,
		},
		{
			callId: callId(),
			now: NOW,
			...(opts.conversationId === undefined ? {} : { conversationId: opts.conversationId }),
		},
	);
}

function typeId(db: KnowledgeDb, name: string): number {
	return (db.raw().prepare("SELECT id FROM types WHERE name = ?").get(name) as { id: number }).id;
}

function blocks(tree: unknown): Record<string, unknown>[] {
	const found: Record<string, unknown>[] = [];
	function walk(value: unknown): void {
		if (Array.isArray(value)) {
			for (const child of value) walk(child);
			return;
		}
		if (typeof value !== "object" || value === null) return;
		const row = value as Record<string, unknown>;
		if (typeof row.type === "string") found.push(row);
		for (const child of Object.values(row)) walk(child);
	}
	walk(tree);
	return found;
}

function block(tree: unknown, id: string): Record<string, unknown> {
	const found = blocks(tree).find((candidate) => candidate.id === id);
	expect(found, `block ${id}`).toBeDefined();
	return found as Record<string, unknown>;
}

function items(tree: unknown, id: string): Record<string, unknown>[] {
	return block(tree, id).items as Record<string, unknown>[];
}

async function rendered(
	view: SurfaceDef<"view">,
	user: string | undefined,
	params: Record<string, unknown> = {},
): Promise<Awaited<ReturnType<SurfaceDef<"view">["render"]>>> {
	const result = await view.render(ctxOf(user, params));
	const verdict = validateTree(result.tree, {
		placement: "view",
		handlers: new Set(Object.keys(view.actions ?? {})),
	});
	expect(verdict.ok).toBe(true);
	return result;
}

describe("the Knowledge view", () => {
	test("sidebar shows the type tree and an Inquiries entry", async () => {
		const { view, db } = fixture();
		record(db, [
			{ type: "acme place", name: "Acme Place", keys: {}, fields: {} },
			{ type: "acme clinic", name: "North Clinic", keys: {}, fields: {} },
		]);

		const result = await rendered(view, ALICE);
		const types = items(result.tree, "types");
		expect(types.map((row) => [row.id, row.title, row.meta])).toEqual([
			["type:1", "acme place", "2"],
			["type:2", "  acme clinic", "1"],
			["inquiries", "Inquiries", undefined],
		]);
		expect(block(result.tree, "types").onActivate).toEqual({ type: "edit", name: "openType" });
		expect(result.access).toBe("write");
		expect(view.id).toBe("knowledge");
		expect(view.title).toBe("Knowledge");
		expect(view.icon).toBe("folder");
		expect(view.placement).toBe("view");
		expect(view.instanceKey?.({ type: 1 }, principal(ALICE))).toBe(
			JSON.stringify([ALICE, { type: 1 }]),
		);
	});

	test("openType navigates to {type}; the type page lists its entities", async () => {
		const { view, db } = fixture();
		const changed = record(db, [
			{ type: "acme place", name: "Acme Place", keys: {}, fields: {} },
			{ type: "acme clinic", name: "North Clinic", keys: {}, fields: {} },
		]);
		const place = typeId(db, "acme place");
		const clinic = typeId(db, "acme clinic");
		const navigation = await view.actions?.openType(ctxOf(ALICE), {
			itemId: `type:${place}`,
		});
		expect(navigation).toEqual({
			ok: true,
			navigate: { type: "navigate", params: { type: place } },
		});

		const result = await rendered(view, ALICE, { type: clinic });
		expect(block(result.tree, "fields").rows).toEqual([
			{ label: "price", value: "money · stale after 30 days" },
		]);
		const entities = items(result.tree, "entities");
		expect(entities).toHaveLength(1);
		expect(entities[0]).toMatchObject({ id: "entity:" + changed.touched[1], name: "North Clinic" });
		expect(block(result.tree, "entities")).toMatchObject({
			display: "table",
			onActivate: { type: "edit", name: "openEntity" },
			columns: [
				{ field: "name", label: "Name" },
				{ field: "type", label: "Type" },
				{ field: "localOnly", label: "Local only", cell: "badge" },
			],
		});
		expect(block(result.tree, "search")).toMatchObject({ mode: "submit", onSubmit: "search" });
		const search = await view.actions?.search(ctxOf(ALICE, { type: place }), {
			values: { q: "north" },
		});
		expect(search).toEqual({
			ok: true,
			navigate: { type: "navigate", params: { type: place, q: "north" } },
		});
	});

	test("history renders created and archived rows", async () => {
		const { view, db } = fixture();
		const changed = record(db, [
			{ type: "acme clinic", name: "North Clinic", keys: { phone: "+1 (555) 010-2000" }, fields: {} },
		]);
		const entityId = changed.touched[0] as string;
		applyRecord(
			db,
			{ types: [placeType, clinicType], entities: [
				{ type: "acme clinic", name: "North Clinic", keys: { phone: "+1 (555) 010-2000" }, fields: {
					price: { value: { amount: 12.5, currency: "CAD" }, source: "recall:north", observedAt: "2026-11-01" },
				} },
			] },
			{ callId: callId(), now: NOW + DAY_MS },
		);
		const result = await rendered(view, ALICE, { entity: entityId });
		const history = blocks(result.tree).filter((row) => row.type === "diff");
		expect(history).toHaveLength(2);
		expect(history[0]?.before).not.toBe("");
		expect(history[1]?.before).toBe("");
		expect(JSON.stringify(block(result.tree, "history"))).toContain("created");
	});

	test("entity detail renders fields with source, date and stale", async () => {
		const { view, db } = fixture();
		const changed = applyRecord(
			db,
			{
				inquiry: { question: "Which clinic?" },
				types: [placeType, clinicType],
				entities: [{
					type: "acme clinic",
					name: "North Clinic",
					keys: { phone: "+1 (555) 010-2000" },
					role: "candidate",
					reason: "nearby",
					fields: {
						price: {
							value: { amount: 12.5, currency: "CAD" },
							source: "recall:north",
							observedAt: new Date(NOW - 40 * DAY_MS).toISOString().slice(0, 10),
						},
					},
				}],
			},
			{ callId: callId(), now: NOW },
		);
		const entityId = changed.touched[0] as string;
		const result = await rendered(view, ALICE, { entity: entityId });
		expect(block(result.tree, "entity-fields").rows).toEqual([
			{ label: "price", value: "12.50 CAD · recall:north · 2026-09-25", tone: "warn" },
		]);
		expect(block(result.tree, "keys").rows).toEqual([
			{ label: "phone (normalized)", value: "15550102000" },
		]);
		expect(JSON.stringify(block(result.tree, "roles"))).toContain("Which clinic?");
		expect(JSON.stringify(block(result.tree, "roles"))).toContain("candidate");
		expect(block(result.tree, "history").children).toHaveLength(1);
	});

	test("structured values render", async () => {
		const { view, db } = fixture();
		const changed = applyRecord(
			db,
			{ types: [placeType, clinicType], entities: [{
				type: "acme clinic", name: "North Clinic", keys: {}, fields: {
					price: { value: { amount: 12.5, currency: "CAD" }, source: "acme", observedAt: "2026-11-01" },
				},
			}] },
			{ callId: callId(), now: NOW },
		);
		const result = await rendered(view, ALICE, { entity: changed.touched[0] as string });
		expect(JSON.stringify(result.tree)).toContain("12.50 CAD");
	});

	test("inquiry links open conversations", async () => {
		const { view, db } = fixture();
		const changed = applyRecord(
			db,
			{
				inquiry: { question: "Which clinic?" },
				types: [placeType, clinicType],
				entities: [{ type: "acme clinic", name: "North Clinic", keys: {}, fields: {}, role: "candidate" }],
			},
			{ callId: callId(), now: NOW, conversationId: 10 },
		);
		const result = await rendered(view, ALICE, { inquiries: true });
		const inquiry = items(result.tree, "inquiries")[0];
		expect(inquiry).toMatchObject({ question: "Which clinic?" });
		const inquiryId = (db.raw().prepare("SELECT id FROM inquiries WHERE question = ?").get("Which clinic?") as { id: number }).id;
		expect(inquiry).toMatchObject({ id: `inquiry:${inquiryId}`, question: "Which clinic?" });
		const navigation = await view.actions?.openInquiry(ctxOf(ALICE), {
			itemId: `inquiry:${inquiryId}`,
		});
		expect(navigation).toEqual({
			ok: true,
			navigate: { type: "navigate", params: { inquiries: true, inquiry: inquiryId } },
		});
		const detail = await rendered(view, ALICE, { inquiries: true, inquiry: inquiryId });
		const conversation = block(detail.tree, "conversation-10");
		expect(conversation).toMatchObject({
			actions: [{
				label: "Conversation 10",
				action: { type: "navigate", target: { conversation: 10 } },
			}],
		});
		expect(JSON.stringify(detail.tree)).toContain(changed.touched[0] as string);
	});

	test("params cannot cross users", async () => {
		const { view, db, opened, storePath } = fixture();
		const changed = record(db, [{ type: "acme clinic", name: "North Clinic", keys: {}, fields: {} }]);
		const bobPath = storePath(BOB);
		mkdirSync(join(bobPath, ".."), { recursive: true });
		writeFileSync(bobPath, "");
		const result = await rendered(view, BOB, { entity: changed.touched[0] as string });
		expect(JSON.stringify(result.tree)).toContain("Not found");
		expect(opened).toEqual([BOB]);
		expect(JSON.stringify(result.tree)).not.toContain("North Clinic");
	});

	test("no store, no file", async () => {
		const { view, opened, storePath } = fixture();
		expect(existsSync(storePath(CAROL))).toBe(false);
		const result = await rendered(view, CAROL);
		expect(JSON.stringify(result.tree)).toContain(
			"No knowledge yet. Curator reviews record knowledge from your conversations.",
		);
		expect(opened).not.toContain(CAROL);
		expect(existsSync(storePath(CAROL))).toBe(false);
	});

	test("anonymous principal gets access none", async () => {
		const { view, opened } = fixture();
		const result = await rendered(view, undefined);
		expect(result.access).toBe("none");
		expect(opened).toEqual([]);
		expect(await view.actions?.openType(ctxOf(undefined), { itemId: "type:1" })).toEqual({
			ok: false,
			error: { message: "sign in to use the Knowledge view" },
		});
	});

	test("history is capped at 20 rows", async () => {
		const { view, db } = fixture();
		const changed = record(db, [{ type: "acme clinic", name: "North Clinic", keys: { phone: "+1 (555) 010-2000" }, fields: {} }]);
		const entityId = changed.touched[0] as string;
		for (let index = 0; index < 21; index += 1) {
			applyRecord(
				db,
				{ types: [placeType, clinicType], entities: [{
					type: "acme clinic", name: "North Clinic", keys: { phone: "+1 (555) 010-2000" }, fields: {
						price: { value: { amount: index + 1, currency: "CAD" }, source: "acme", observedAt: "2026-11-01" },
					}, attributes: { revision: index },
				}] },
				{ callId: callId(), now: NOW + index },
			);
		}
		const result = await rendered(view, ALICE, { entity: entityId });
		expect(block(result.tree, "history").children).toHaveLength(20);
	});

	test("search escapes percent and underscore LIKE wildcards", async () => {
		const { view, db } = fixture();
		record(db, [
			{ type: "acme clinic", name: "Acme 50% Clinic", keys: {}, fields: {} },
			{ type: "acme clinic", name: "Acme 500 Clinic", keys: {}, fields: {} },
			{ type: "acme clinic", name: "Acme A_B Clinic", keys: {}, fields: {} },
			{ type: "acme clinic", name: "Acme AFB Clinic", keys: {}, fields: {} },
		]);
		const clinic = typeId(db, "acme clinic");
		const percent = await rendered(view, ALICE, { type: clinic, q: "50%" });
		expect(items(percent.tree, "entities").map((row) => row.name)).toEqual(["Acme 50% Clinic"]);
		const underscore = await rendered(view, ALICE, { type: clinic, q: "A_B" });
		expect(items(underscore.tree, "entities").map((row) => row.name)).toEqual(["Acme A_B Clinic"]);
	});

	test("a local-only entity renders its badge", async () => {
		const { view, db } = fixture();
		const changed = record(db, [{
			type: "acme clinic", name: "North Clinic", keys: {}, fields: {},
		}]);
		db.raw().prepare("UPDATE entities SET cls = 'local-only' WHERE id = ?").run(changed.touched[0] as string);
		const clinic = typeId(db, "acme clinic");
		const list = await rendered(view, ALICE, { type: clinic });
		expect(items(list.tree, "entities")[0]).toMatchObject({ localOnly: "local-only" });
		const detail = await rendered(view, ALICE, { entity: changed.touched[0] as string });
		expect(JSON.stringify(detail.tree)).toContain("local-only");
	});

	test("archived types, entities and inquiries appear behind the archived toggle", async () => {
		const { view, db } = fixture();
		const changed = applyRecord(
			db,
			{
				inquiry: { question: "Archived question" },
				types: [placeType, clinicType],
				entities: [{ type: "acme clinic", name: "North Clinic", keys: {}, fields: {}, role: "candidate" }],
			},
			{ callId: callId(), now: NOW },
		);
		const entityId = changed.touched[0] as string;
		db.raw().prepare("UPDATE types SET archived = 1 WHERE name = ?").run("acme clinic");
		db.raw().prepare("UPDATE inquiries SET archived = 1").run();

		const ordinary = await rendered(view, ALICE);
		expect(JSON.stringify(ordinary.tree)).not.toContain("acme clinic");
		const withArchived = await rendered(view, ALICE, { archived: true });
		expect(JSON.stringify(withArchived.tree)).toContain("acme clinic");
		const archivedInquiries = await rendered(view, ALICE, { inquiries: true, archived: true });
		expect(JSON.stringify(archivedInquiries.tree)).toContain("Archived question");
		const page = await rendered(view, ALICE, { type: typeId(db, "acme clinic"), archived: true });
		expect(items(page.tree, "entities").map((row) => row.id)).toContain(`entity:${entityId}`);
		const action = await view.actions?.openType(ctxOf(ALICE, { archived: true }), { itemId: "inquiries" });
		expect(action).toEqual({
			ok: true,
			navigate: { type: "navigate", params: { inquiries: true, archived: true } },
		});
	});

	test("entities at archived types keep inherited field definitions and horizons", async () => {
		const { view, db } = fixture();
		const changed = applyRecord(
			db,
			{ types: [placeType, clinicType], entities: [{
				type: "acme clinic", name: "North Clinic", keys: {}, fields: {
					price: { value: { amount: 12.5, currency: "CAD" }, source: "acme", observedAt: "2026-09-01" },
				},
			}] },
			{ callId: callId(), now: NOW },
		);
		db.raw().prepare("UPDATE types SET archived = 1 WHERE name = ?").run("acme clinic");
		const result = await rendered(view, ALICE, { entity: changed.touched[0] as string, archived: true });
		expect(block(result.tree, "entity-fields").rows).toEqual([
			{ label: "price", value: "12.50 CAD · acme · 2026-09-01", tone: "warn" },
		]);
	});

	test("handlers refuse malformed or foreign row ids", async () => {
		const { view } = fixture();
		for (const [name, itemId] of [
			["openType", "entity:1"],
			["openEntity", "type:1"],
			["openInquiry", "inquiry:nope"],
			["openType", "1"],
		] as const) {
			expect(await view.actions?.[name](ctxOf(ALICE), { itemId })).toEqual({
				ok: false,
				error: { message: `invalid ${name} row id` },
			});
		}
	});
});
