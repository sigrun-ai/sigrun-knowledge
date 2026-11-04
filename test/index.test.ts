import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import createKnowledge from "../src/index.js";
import { KnowledgeDb } from "../src/db.js";

interface FakeHostStores {
	user(user: string): { paths: { data: string; state: string; cache: string } };
}

const fakeHost = (root: string) =>
	({
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
});
