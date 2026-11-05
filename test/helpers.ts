import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KnowledgeDb } from "../src/db.js";

export interface HookCallRecord {
	name: string;
	payload: unknown;
	opts?: { user?: string; conversationId?: number };
}

type HookResult = unknown;

export interface FakeHost {
	stores: {
		user(user: string): {
			paths: { data: string; state: string; cache: string };
			settings: { get(): Promise<Record<string, unknown>> };
		};
	};
	identity: {
		actingUser(conversationId: number): Promise<string | undefined>;
	};
	conversations: {
		meta(id: number): Promise<Record<string, unknown>>;
		entries(
			id: number,
			query: Record<string, unknown>,
			limit: number,
			cursor?: unknown,
		): Promise<{ items: unknown[]; next?: unknown }>;
	};
	publishedHooks: {
		call(
			name: string,
			payload: unknown,
			opts?: { user?: string; conversationId?: number },
		): Promise<HookResult>;
	};
}

export interface FakeHostOptions {
	/** actingUser per conversationId. */
	users?: Record<number, string | undefined>;
	/** meta per conversationId. */
	metas?: Record<number, Record<string, unknown>>;
	/**
	 * Fork-ancestry pages per conversationId: each page is a list of
	 * entry conversation ids; pages are served in order, with a cursor
	 * chaining them.
	 */
	entryPages?: Record<number, number[][]>;
	/** Per-user settings.json contents. */
	settings?: Record<string, Record<string, unknown>>;
	/** Scripted hook results keyed by hook name (one result or a fn). */
	hooks?: Record<
		string,
		HookResult | ((payload: unknown, opts?: { user?: string }) => HookResult)
	>;
}

export interface Fake {
	host: FakeHost;
	calls: HookCallRecord[];
	dir: string;
}

export function fakeHost(options: FakeHostOptions = {}): Fake {
	const dir = mkdtempSync(join(tmpdir(), "knowledge-fake-"));
	const calls: HookCallRecord[] = [];
	const host: FakeHost = {
		stores: {
			user: (user: string) => ({
				paths: {
					data: join(dir, "users", user, "data"),
					state: join(dir, "users", user, "state"),
					cache: join(dir, "users", user, "cache"),
				},
				settings: {
					async get() {
						return options.settings?.[user] ?? {};
					},
				},
			}),
		},
		identity: {
			async actingUser(conversationId: number) {
				return options.users?.[conversationId];
			},
		},
		conversations: {
			async meta(id: number) {
				return options.metas?.[id] ?? {};
			},
			async entries(id: number, _query, _limit, cursor?: unknown) {
				const pages = options.entryPages?.[id] ?? [];
				const index =
					typeof cursor === "number" ? cursor : Number.parseInt(String(cursor ?? "0"), 10);
				const page = pages[index] ?? [];
				const items = page.map((conversationId, i) => ({
					id: index * 1000 + i + 1,
					conversationId,
					kind: "pi.user",
				}));
				const next = index + 1 < pages.length ? index + 1 : undefined;
				return { items, next };
			},
		},
		publishedHooks: {
			async call(name, payload, opts) {
				calls.push({ name, payload, opts });
				const scripted = options.hooks?.[name];
				if (typeof scripted === "function") return scripted(payload, opts);
				if (scripted !== undefined) return scripted;
				return { status: "absent" };
			},
		},
	};
	return { host, calls, dir };
}

/** Scripted `recall.index` ok result. */
export function indexOk(payload: unknown): unknown {
	return {
		status: "ok",
		provider: "recall",
		value: {
			handle: `d:${(payload as { id: string }).id}`,
			class: "normal",
			changed: true,
		},
	};
}

/** Drive the knowledge_record tool's execute with a minimal fake api. */
export async function callRecord(
	tool: {
		execute(args: never, api: never, context: never): Promise<unknown>;
	},
	args: unknown,
	api: Record<string, unknown>,
): Promise<{
	output: { type: string; text: string }[];
	details?: { curation?: { changeId: string; summary: string } };
	isError?: boolean;
}> {
	const fullApi = {
		callId: "call-1",
		conversationId: 42,
		now: () => NOW,
		agent: async () => ({ model: { provider: "acme-local", modelId: "acme-1" } }),
		...api,
	};
	return (await tool.execute(args as never, fullApi as never, {} as never)) as never;
}

/** Drive knowledge_find likewise. */
export async function callFind(
	tool: {
		execute(args: never, api: never, context: never): Promise<unknown>;
	},
	args: unknown,
	api: Record<string, unknown>,
): Promise<{ output: { type: string; text: string }[]; isError?: boolean }> {
	const fullApi = {
		callId: "call-1",
		conversationId: 42,
		now: () => NOW,
		agent: async () => ({ model: { provider: "acme-local", modelId: "acme-1" } }),
		...api,
	};
	return (await tool.execute(args as never, fullApi as never, {} as never)) as never;
}

export const NOW = Date.parse("2026-11-04T12:00:00Z");

/** openDb that hands out one in-memory database per path. */
export function memoryDb(): { openDb: (path: string) => KnowledgeDb } {
	const dbs = new Map<string, KnowledgeDb>();
	return {
		openDb: (path: string) => {
			let db = dbs.get(path);
			if (db === undefined) {
				db = KnowledgeDb.open(":memory:");
				dbs.set(path, db);
			}
			return db;
		},
	};
}
