import type { CurationTarget } from "@sigrun/sigrun/extension";
import type { KnowledgeDb } from "./db.js";
import { type MirrorHost } from "./mirror.js";
export interface TargetDeps {
    host: MirrorHost & {
        stores: {
            user(user: string): {
                paths: {
                    state: string;
                };
            };
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
export declare function createTarget(deps: TargetDeps): CurationTarget;
