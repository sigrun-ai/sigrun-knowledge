import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createResearch, readResearchFlags } from "../src/research.js";
import { fakeHost, NOW, type Fake } from "./helpers.js";

describe("research afterTool on a harness-written result", () => {
	let fake: Fake;
	afterEach(() => {
		if (fake !== undefined) rmSync(fake.dir, { recursive: true, force: true });
	});

	it("research is not stamped for a call that never ran", async () => {
		fake = fakeHost({
			metas: { 1: { owner: "alice" } },
		});
		const flag = createResearch({
			conversationMeta: (id: number) => fake.host.conversations.meta(id),
			userStateDir: (user: string) => fake.host.stores.user(user).paths.state,
			userSettings: (user: string) =>
				fake.host.stores.user(user).settings.get(),
			now: () => NOW,
		});
		const call = { name: "searxng/search", arguments: {} };
		const blockedResult = {
			output: [{ type: "text", text: "held" }],
			isError: true,
			diagnostics: [
				{ severity: "error", message: "held", code: "blocked" },
			],
		};
		await flag(
			call as never,
			blockedResult as never,
			{ conversationId: 1 } as never,
			{} as never,
		);
		expect(
			readResearchFlags(fake.host.stores.user("alice").paths.state)[1],
		).toBeUndefined();
	});

	it("research IS stamped when the call ran (control)", async () => {
		fake = fakeHost({
			metas: { 1: { owner: "alice" } },
		});
		const flag = createResearch({
			conversationMeta: (id: number) => fake.host.conversations.meta(id),
			userStateDir: (user: string) => fake.host.stores.user(user).paths.state,
			userSettings: (user: string) =>
				fake.host.stores.user(user).settings.get(),
			now: () => NOW,
		});
		await flag(
			{ name: "searxng/search", arguments: {} } as never,
			{ output: [{ type: "text", text: "ok" }] } as never,
			{ conversationId: 1 } as never,
			{} as never,
		);
		expect(
			readResearchFlags(fake.host.stores.user("alice").paths.state)[1]
				?.lastResearchAt,
		).toBe(NOW);
	});
});
