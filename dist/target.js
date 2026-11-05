import { undoChange } from "./undo.js";
import { mirrorEntities } from "./mirror.js";
import { guidance } from "./prompts.js";
import { requestReview, clearReview } from "./research.js";
/**
 * The knowledge curation target (curator P7): knowledge_record is the
 * wrapped write surface; knowledge_find is a read tool the review may
 * call (never wrapped). undo reverts a change and re-mirrors every
 * touched entity. wantsReview/reviewed drive the research flag.
 */
export function createTarget(deps) {
    return {
        name: "knowledge",
        tools: ["knowledge_record"],
        readTools: ["knowledge_find"],
        guidance: () => guidance(),
        async undo(user, changeId, _ctx) {
            const db = deps.dbForUser(user);
            const result = undoChange(db, changeId, deps.now());
            await mirrorEntities(deps.host, db, user, result.touched, deps.now());
        },
        wantsReview: (user, id) => requestReview(deps.host.stores.user(user).paths.state, id, deps.now()),
        reviewed: (user, id) => {
            clearReview(deps.host.stores.user(user).paths.state, id);
        },
        // Task 11 wires the idle pass: re-index pending entities and
        // generalize sibling types. Deliberately a no-op for now — the
        // target works without it (research-triggered reviews and undo are
        // the live surfaces).
        maintain: async () => ({ changes: [] }),
    };
}
