import { describe, expect, it, vi } from "vitest";

import {
	matchesGlob,
	resetWarnedForTests,
	resolveUserSettings,
} from "../src/config.js";

const storeWith = (value: Record<string, unknown>) => ({
	get: async () => value,
});

describe("matchesGlob", () => {
	it("matches a * wildcard anywhere", () => {
		expect(matchesGlob("*/search*", "searxng/search")).toBe(true);
		expect(matchesGlob("*/search*", "searxng/search_images")).toBe(true);
		expect(matchesGlob("*/search*", "recall_search")).toBe(false);
	});

	it("matches without wildcards only on equality", () => {
		expect(matchesGlob("web_search", "web_search")).toBe(true);
		expect(matchesGlob("web_search", "web_search_v2")).toBe(false);
	});

	it("matches a bare * against everything", () => {
		expect(matchesGlob("*", "anything/at all")).toBe(true);
	});

	it("treats regex metacharacters literally", () => {
		expect(matchesGlob("a.b", "axb")).toBe(false);
		expect(matchesGlob("a.b", "a.b")).toBe(true);
	});
});

describe("resolveUserSettings", () => {
	it("returns the default researchTools when unset", async () => {
		const settings = await resolveUserSettings(storeWith({}));
		expect(settings.researchTools).toEqual([
			"*/search*",
			"*/fetch*",
			"*/crawl*",
			"*/md",
			"web_search",
			"web_fetch",
		]);
	});

	it("passes through a valid researchTools list", async () => {
		const settings = await resolveUserSettings(
			storeWith({ researchTools: ["*/lookup*", "web_search"] }),
		);
		expect(settings.researchTools).toEqual(["*/lookup*", "web_search"]);
	});

	it("warns once and falls back on invalid researchTools", async () => {
		resetWarnedForTests();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const settings = await resolveUserSettings(
				storeWith({ researchTools: [42, "web_search"] }),
			);
			expect(settings.researchTools).toEqual([
				"*/search*",
				"*/fetch*",
				"*/crawl*",
				"*/md",
				"web_search",
				"web_fetch",
			]);
			expect(warn).toHaveBeenCalledTimes(1);
		} finally {
			warn.mockRestore();
		}
	});

	it("warns once total across repeated resolutions", async () => {
		resetWarnedForTests();
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const bad = storeWith({ researchTools: [42] });
			await resolveUserSettings(bad);
			await resolveUserSettings(bad);
			await resolveUserSettings(bad);
			const researchWarns = warn.mock.calls.filter(([message]) =>
				String(message).includes("researchTools"),
			);
			expect(researchWarns).toHaveLength(1);
		} finally {
			warn.mockRestore();
		}
	});
});
