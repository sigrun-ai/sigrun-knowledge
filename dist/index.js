import { join } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { KnowledgeDb } from "./db.js";
import { createTools } from "./tools.js";
import { createTarget } from "./target.js";
import { createResearch } from "./research.js";
import { createKnowledgeView } from "./view.js";
import { KNOWLEDGE_USER_SCHEMA } from "./settings-schema.js";
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createKnowledge(host, deps = {}) {
    const settings = host.settings.declare({
        schema: { type: "object", properties: {} },
        userSchema: KNOWLEDGE_USER_SCHEMA,
    });
    // One store per directory user, opened on first use. Core does not
    // create paths.data; KnowledgeDb.open creates its parent.
    const databases = new Map();
    const pathOf = deps.storePath ??
        ((user) => join(host.stores.user(user).paths.data, "knowledge.db"));
    function dbForUser(user) {
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
        conversationMeta: (id) => host.conversations.meta(id),
        userStateDir: (user) => host.stores.user(user).paths.state,
        userSettings: (user) => settings.user(user).get(),
        now,
    });
    const result = {
        title: "Knowledge",
        extension: defineExtension({
            name: "@sigrun/knowledge",
            tools,
            hooks: [
                hook(ToolTask, {
                    afterTool: async (call, toolResult, api) => researchFlag(call, toolResult, api, undefined),
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
