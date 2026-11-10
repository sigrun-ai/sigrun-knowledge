import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { checkStoredSettings, assertDrawable } from "@sigrun/sigrun/settings-schema";
import type { SettingsDeclaration, SigrunHost } from "@sigrun/sigrun/extension";

import createKnowledge from "../src/index.js";
import { KNOWLEDGE_USER_SCHEMA } from "../src/settings-schema.js";

interface DeclaredHost {
	declaration: SettingsDeclaration | undefined;
	declared: ReturnType<SigrunHost["settings"]["declare"]> | undefined;
	settingsDir: string;
	save(user: string, value: Record<string, unknown>): Promise<void>;
}

const dirs: string[] = [];
afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function declaredHost(): Promise<DeclaredHost> {
	const root = await mkdtemp(join(tmpdir(), "knowledge-settings-"));
	dirs.push(root);
	const settingsDir = join(root, "settings");
	await mkdir(settingsDir, { recursive: true });
	const state = {
		declaration: undefined,
		declared: undefined,
		settingsDir,
	} as DeclaredHost;
	const read = async (user: string): Promise<Record<string, unknown>> => {
		try {
			return JSON.parse(await readFile(join(state.settingsDir, `${user}.json`), "utf8"));
		} catch {
			return {};
		}
	};
	const host = {
		settings: {
			declare: <S, U>(declaration: SettingsDeclaration) => {
				state.declaration = declaration;
				const declared = {
					get: async () => ({}) as S,
					user: (user: string) => ({
						get: async () => checkStoredSettings(declaration.userSchema!, await read(user)).value as U,
					}),
				};
				state.declared = declared;
				return declared;
			},
		},
		stores: {
			user: (user: string) => ({
				settings: {
					get: () => read(user),
					set: async (value: Record<string, unknown>) => {
						await mkdir(state.settingsDir, { recursive: true });
						await writeFile(join(state.settingsDir, `${user}.json`), JSON.stringify(value));
					},
				},
				paths: {
					data: join(root, user, "data"),
					state: join(root, user, "state"),
					cache: join(root, user, "cache"),
				},
			}),
		},
	} as unknown as SigrunHost;
	createKnowledge(host);
	state.save = (user, value) => host.stores.user(user).settings.set(value);
	return state;
}

describe("knowledge user settings schema", () => {
	test("schema is drawable", () => {
		assertDrawable(KNOWLEDGE_USER_SCHEMA);
	});

	test("defaults match the old parser", async () => {
		const host = await declaredHost();
		expect(await host.declared!.user("alice").get()).toEqual({
			researchTools: ["*/search*", "*/fetch*", "*/crawl*", "*/md", "web_search", "web_fetch"],
		});
	});

	test("an old settings file still loads", async () => {
		const host = await declaredHost();
		// The fixture from config.test.ts's valid researchTools case.
		await writeFile(
			join(host.settingsDir, "alice.json"),
			JSON.stringify({ researchTools: ["*/lookup*", "web_search"] }),
		);
		expect(await host.declared!.user("alice").get()).toEqual({
			researchTools: ["*/lookup*", "web_search"],
		});
	});

	test("malformed researchTools items are dropped per element", async () => {
		const host = await declaredHost();
		await host.save("alice", { researchTools: ["", "web_search"] });
		expect(await host.declared!.user("alice").get()).toEqual({
			researchTools: ["web_search"],
		});
	});

	test("a non-array researchTools value falls back to the old defaults", async () => {
		const host = await declaredHost();
		await host.save("alice", { researchTools: "web_search" });
		expect(await host.declared!.user("alice").get()).toEqual({
			researchTools: ["*/search*", "*/fetch*", "*/crawl*", "*/md", "web_search", "web_fetch"],
		});
	});

	test("user settings stay per user", async () => {
		const host = await declaredHost();
		await writeFile(
			join(host.settingsDir, "alice.json"),
			JSON.stringify({ researchTools: ["alice/search"] }),
		);
		await writeFile(
			join(host.settingsDir, "bob.json"),
			JSON.stringify({ researchTools: ["bob/search"] }),
		);
		const bobBefore = await readFile(join(host.settingsDir, "bob.json"), "utf8");
		await host.save("alice", { researchTools: ["alice/changed"] });
		expect(await host.declared!.user("alice").get()).toEqual({ researchTools: ["alice/changed"] });
		expect(await host.declared!.user("bob").get()).toEqual({ researchTools: ["bob/search"] });
		expect(await readFile(join(host.settingsDir, "bob.json"), "utf8")).toBe(bobBefore);
	});

	test("the factory declares only the empty shared schema and a user schema", async () => {
		const host = await declaredHost();
		expect(host.declaration).toEqual({
			schema: { type: "object", properties: {} },
			userSchema: KNOWLEDGE_USER_SCHEMA,
		});
	});
});
