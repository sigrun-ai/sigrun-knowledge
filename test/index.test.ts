import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkStoredSettings } from "@sigrun/sigrun/settings-schema";
import type { SettingsDeclaration } from "@sigrun/sigrun/extension";

import createKnowledge from "../src/index.js";
import { KnowledgeDb } from "../src/db.js";

interface FakeHostStores {
	user(user: string): { paths: { data: string; state: string; cache: string } };
}

const fakeHost = (root: string) =>
	({
		settings: {
			declare: (declaration: SettingsDeclaration) => ({
				get: async () => ({}),
				user: (_user: string) => ({
					get: async () => checkStoredSettings(declaration.userSchema!, {}).value,
				}),
			}),
		},
		stores: {
			user: (user: string) => ({
				paths: {
					data: join(root, user),
					state: join(root, user, "state"),
					cache: join(root, user, "cache"),
				},
			}),
		},
	}) as never;

describe("createKnowledge", () => {
	let dir: string;

	afterEach(() => {
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	it("has factory arity 1", () => {
		expect(createKnowledge.length).toBe(1);
	});

	it("registers under @sigrun/knowledge", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const opened: string[] = [];
		const result = createKnowledge(fakeHost(dir), {
			openDb: (path) => {
				opened.push(path);
				return KnowledgeDb.open(":memory:");
			},
		});
		expect((result.extension as { name: string }).name).toBe(
			"@sigrun/knowledge",
		);
		expect(opened).toEqual([]);
	});

	it("declares one curation target with tools [knowledge_record] and readTools [knowledge_find]", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const result = createKnowledge(fakeHost(dir), {
			openDb: () => KnowledgeDb.open(":memory:"),
		});
		const targets = result.curationTargets;
		expect(targets).toHaveLength(1);
		expect(targets![0]!.name).toBe("knowledge");
		expect(targets![0]!.tools).toEqual(["knowledge_record"]);
		expect(targets![0]!.readTools).toEqual(["knowledge_find"]);
		expect(typeof targets![0]!.undo).toBe("function");
		expect(typeof targets![0]!.guidance).toBe("function");
	});

	it("registers knowledge_record and knowledge_find as tools", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const result = createKnowledge(fakeHost(dir), {
			openDb: () => KnowledgeDb.open(":memory:"),
		});
		const tools = (result.extension as unknown as { tools: { name: string; replay?: string }[] })
			.tools;
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("knowledge_record");
		expect(names).toContain("knowledge_find");
		expect(
			tools.find((tool) => tool.name === "knowledge_record")!.replay,
		).toBe("safe");
	});

	it("opens one database per user lazily and closes them on shutdown", async () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const opened: string[] = [];
		const closed: string[] = [];
		const result = createKnowledge(fakeHost(dir), {
			openDb: (path) => {
				opened.push(path);
				const db = KnowledgeDb.open(":memory:");
				const original = db.close.bind(db);
				db.close = () => {
					closed.push(path);
					original();
				};
				return db;
			},
		});
		const dbFor = (result as unknown as { dbForUser(u: string): KnowledgeDb })
			.dbForUser;
		expect(typeof dbFor).toBe("function");
		const aliceDb = dbFor("alice");
		expect(opened).toEqual([join(dir, "alice", "knowledge.db")]);
		expect(dbFor("alice")).toBe(aliceDb);
		expect(dbFor("bob")).not.toBe(aliceDb);
		expect(opened).toEqual([
			join(dir, "alice", "knowledge.db"),
			join(dir, "bob", "knowledge.db"),
		]);
		await result.harnessShutdown?.({} as never, {} as never);
		expect(closed).toEqual([
				join(dir, "alice", "knowledge.db"),
				join(dir, "bob", "knowledge.db"),
			]);
	});

	it("the factory result declares one target with tools [knowledge_record] and readTools [knowledge_find]", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const result = createKnowledge(fakeHost(dir), {
			openDb: () => KnowledgeDb.open(":memory:"),
		});
		expect(result.curationTargets).toHaveLength(1);
		const target = result.curationTargets![0]!;
		expect(target.name).toBe("knowledge");
		expect(target.tools).toEqual(["knowledge_record"]);
		expect(target.readTools).toEqual(["knowledge_find"]);
	});

	it("the extension registers knowledge_record and knowledge_find", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-index-"));
		const result = createKnowledge(fakeHost(dir), {
			openDb: () => KnowledgeDb.open(":memory:"),
		});
		const tools = (
			result.extension as unknown as { tools: readonly { name: string }[] }
		).tools;
		const names = tools.map((tool) => tool.name);
		expect(names).toContain("knowledge_record");
		expect(names).toContain("knowledge_find");
	});
});
