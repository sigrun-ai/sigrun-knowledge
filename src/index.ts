import { join } from "node:path";

import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { KnowledgeDb } from "./db.js";
import { createTools } from "./tools.js";
import { createTarget } from "./target.js";
import { createResearch } from "./research.js";

export interface FactoryDeps {
	openDb?: (path: string) => KnowledgeDb;
	now?: () => number;
}

/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createKnowledge(
	host: SigrunHost,
	deps: FactoryDeps = {},
): SigrunExtensionResult {
	// One store per directory user, opened on first use. Core does not
	// create paths.data; KnowledgeDb.open creates its parent.
	const databases = new Map<string, KnowledgeDb>();
	function dbForUser(user: string): KnowledgeDb {
		let database = databases.get(user);
		if (database === undefined) {
			database = (deps.openDb ?? KnowledgeDb.open)(
				join(host.stores.user(user).paths.data, "knowledge.db"),
			);
			databases.set(user, database);
		}
		return database;
	}

	const now = deps.now ?? Date.now;

	const tools = createTools({ host, dbForUser, now });
	const target = createTarget({ host, dbForUser, now });
	const researchFlag = createResearch({
		conversationMeta: (id) => host.conversations.meta(id as never),
		userStateDir: (user) => host.stores.user(user).paths.state,
		userSettings: (user) => host.stores.user(user).settings.get(),
		now,
	});

	const result: SigrunExtensionResult & { dbForUser: typeof dbForUser } = {
		extension: defineExtension({
			name: "@sigrun/knowledge",
			tools,
			hooks: [
				hook(ToolTask, {
					afterTool: async (call, toolResult, api) =>
						researchFlag(call, toolResult, api, undefined),
				}),
			],
		}),
		dbForUser,
		curationTargets: [target],
		harnessShutdown: () => {
			for (const database of databases.values()) {
				database.close();
			}
			databases.clear();
		},
	};
	return result;
}
