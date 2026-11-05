import type { CurationTarget, HandlerContext } from "@sigrun/sigrun/extension";

import { undoChange } from "./undo.js";
import type { KnowledgeDb } from "./db.js";
import { mirrorEntities, type MirrorHost } from "./mirror.js";
import { maintain } from "./maintain.js";
import { guidance } from "./prompts.js";
import { requestReview, clearReview } from "./research.js";

export interface TargetDeps {
	host: MirrorHost & {
		stores: {
			user(user: string): { paths: { state: string } };
		};
	};
	dbForUser(user: string): KnowledgeDb;
	now(): number;
}

/**
 * The knowledge curation target (curator P7): knowledge_record is the
 * wrapped write surface; knowledge_find is a read tool the review may
 * call (never wrapped). undo reverts a change and re-mirrors every
 * touched entity. wantsReview/reviewed drive the research flag.
 */
export function createTarget(deps: TargetDeps): CurationTarget {
	return {
		name: "knowledge",
		tools: ["knowledge_record"],
		readTools: ["knowledge_find"],
		guidance: () => guidance(),
		async undo(user: string, changeId: string, _ctx: HandlerContext) {
			const db = deps.dbForUser(user);
			const result = undoChange(db, changeId, deps.now());
			await mirrorEntities(deps.host, db, user, result.touched, deps.now());
		},
		wantsReview: (user: string, id: number) =>
			requestReview(deps.host.stores.user(user).paths.state, id, deps.now()),
		reviewed: (user: string, id: number) => {
			clearReview(deps.host.stores.user(user).paths.state, id);
		},
		maintain: (user, ctx, budget) => maintain(user, ctx, budget, deps),
	};
}
