import { join } from "node:path";

import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { KnowledgeDb } from "./db.js";
import { createTools } from "./tools.js";
import { createTarget } from "./target.js";
import { createResearch } from "./research.js";
import { createKnowledgeView } from "./view.js";

export interface FactoryDeps {
	openDb?: (path: string) => KnowledgeDb;
	now?: () => number;
	storePath?: (user: string) => string;
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
	const pathOf =
		deps.storePath ??
		((user: string) => join(host.stores.user(user).paths.data, "knowledge.db"));
	function dbForUser(user: string): KnowledgeDb {
		let database = databases.get(user);
		if (database === undefined) {
			database = (deps.openDb ?? KnowledgeDb.open)(pathOf(user));
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
		surfaces: {
			views: [createKnowledgeView({ host, dbForUser, storePath: pathOf, now })],
		},
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
