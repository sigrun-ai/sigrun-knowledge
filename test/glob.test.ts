import { describe, expect, it } from "vitest";

import { matchesGlob } from "../src/glob.js";

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
