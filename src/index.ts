import { join } from "node:path";

import { defineExtension } from "@earendil-works/pi-durable";
import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";

import { KnowledgeDb } from "./db.js";

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

	const result: SigrunExtensionResult & { dbForUser: typeof dbForUser } = {
		extension: defineExtension({ name: "@sigrun/knowledge" }),
		dbForUser,
		harnessShutdown: () => {
			for (const database of databases.values()) {
				database.close();
			}
			databases.clear();
		},
	};
	return result;
}
