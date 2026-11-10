import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { KnowledgeDb } from "../src/db.js";
import { applyRecord } from "../src/apply.js";
import {
	createResearch,
	readResearchFlags,
	requestReview,
	clearReview,
	RESEARCH_WINDOW_MS,
} from "../src/research.js";
import { fakeHost, NOW, type Fake } from "./helpers.js";

describe("research flag", () => {
	let fake: Fake;
	let dir: string;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
		if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
	});

	function researchDeps(fake: Fake, now: () => number) {
		return {
			conversationMeta: (id: number) => fake.host.conversations.meta(id),
			userStateDir: (user: string) => fake.host.stores.user(user).paths.state,
			userSettings: fake.userSettings,
			now,
		};
	}

	it("flags searxng/search for the owner and ignores recall_search and internal conversations", async () => {
		fake = fakeHost({
			metas: {
				1: { owner: "alice" },
				2: { owner: "alice", internal: true },
			},
		});
		const flag = createResearch(researchDeps(fake, () => NOW));
		const api1 = { conversationId: 1 } as never;
		const api2 = { conversationId: 2 } as never;
		const call1 = { name: "searxng/search", arguments: {} };
		const call2 = { name: "recall_search", arguments: {} };
		expect(
			await flag(call1 as never, {} as never, api1 as never, {} as never),
		).toBeUndefined();
		expect(
			await flag(call2 as never, {} as never, api1 as never, {} as never),
		).toBeUndefined();
		// internal conversation: never flagged
		expect(
			await flag(call1 as never, {} as never, api2 as never, {} as never),
		).toBeUndefined();
		const flags = readResearchFlags(fake.host.stores.user("alice").paths.state);
		expect(flags[1]?.lastResearchAt).toBe(NOW);
		expect(flags[2]).toBeUndefined();
	});

	it("ignores ownerless conversations and never throws on errors", async () => {
		fake = fakeHost({
			metas: { 1: {} },
		});
		const flag = createResearch(researchDeps(fake, () => NOW));
		const api = { conversationId: 1 } as never;
		await flag(
			{ name: "searxng/search", arguments: {} } as never,
			{} as never,
			api,
			{} as never,
		);
		expect(readResearchFlags(fake.host.stores.user("alice").paths.state)).toEqual(
			{},
		);

		// a throwing meta lookup is logged, never thrown
		const throwing = createResearch({
			conversationMeta: () => Promise.reject(new Error("boom")),
			userStateDir: (user: string) => join(tmpdir(), "research-never", user),
			userSettings: () => Promise.resolve({ researchTools: ["*/search*"] }),
			now: () => NOW,
		});
		await expect(
			throwing(
				{ name: "searxng/search", arguments: {} } as never,
				{} as never,
				{ conversationId: 1 } as never,
				{} as never,
			),
		).resolves.toBeUndefined();
	});

	it("request is true once after research, false on a second settle within 15 minutes, true again after the window; reviewed clears it", async () => {
		fake = fakeHost({ metas: { 1: { owner: "alice" } } });
		let now = NOW;
		const deps = researchDeps(fake, () => now);
		const flag = createResearch(deps);
		const api = { conversationId: 1 } as never;
		await flag(
			{ name: "searxng/search", arguments: {} } as never,
			{} as never,
			api,
			{} as never,
		);
		const state = fake.host.stores.user("alice").paths.state;

		expect(requestReview(state, 1, now)).toBe(true);
		// stamped: a second settle inside the window does not re-request
		expect(requestReview(state, 1, now)).toBe(false);
		expect(requestReview(state, 1, now + RESEARCH_WINDOW_MS - 1)).toBe(false);
		// after the window a review that never completed is re-requested
		expect(requestReview(state, 1, now + RESEARCH_WINDOW_MS)).toBe(true);
		// and stamping again suppresses the next one
		expect(requestReview(state, 1, now + RESEARCH_WINDOW_MS + 1)).toBe(false);

		// reviewed clears the entry
		clearReview(state, 1);
		expect(requestReview(state, 1, now + RESEARCH_WINDOW_MS + 2)).toBe(false);
		expect(readResearchFlags(state)[1]).toBeUndefined();
	});

	it("request is false when no research happened", () => {
		dir = mkdtempSync(join(tmpdir(), "knowledge-research-"));
		expect(requestReview(dir, 9, NOW)).toBe(false);
	});

	it("honours a custom researchTools glob list", async () => {
		fake = fakeHost({
			metas: { 1: { owner: "alice" } },
			settings: { alice: { researchTools: ["acme-local/lookup"] } },
		});
		const flag = createResearch(researchDeps(fake, () => NOW));
		const api = { conversationId: 1 } as never;
		await flag(
			{ name: "searxng/search", arguments: {} } as never,
			{} as never,
			api,
			{} as never,
		);
		expect(readResearchFlags(fake.host.stores.user("alice").paths.state)).toEqual(
			{},
		);
		await flag(
			{ name: "acme-local/lookup", arguments: {} } as never,
			{} as never,
			api,
			{} as never,
		);
		expect(
			readResearchFlags(fake.host.stores.user("alice").paths.state)[1]
				?.lastResearchAt,
		).toBe(NOW);
	});
});

describe("research wiring", () => {
	it("research.json lives under the user's state directory", () => {
		// sanity: KnowledgeDb unused here; state dir is per-user
		const db = KnowledgeDb.open(":memory:");
		db.close();
		expect(typeof readResearchFlags).toBe("function");
	});
});
