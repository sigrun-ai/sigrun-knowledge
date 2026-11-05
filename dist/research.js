import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { matchesGlob, resolveUserSettings } from "./config.js";
/** The window a queued review suppresses duplicate requests. */
export const RESEARCH_WINDOW_MS = 15 * 60 * 1000;
export function readResearchFlags(stateDir) {
    try {
        const raw = JSON.parse(readFileSync(join(stateDir, "research.json"), "utf8"));
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
            return {};
        return raw;
    }
    catch {
        return {};
    }
}
function writeResearchFlags(stateDir, flags) {
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "research.json"), JSON.stringify(flags, null, "\t") + "\n");
}
/**
 * The afterTool hook: for a non-internal conversation with an owner and a
 * tool name matching the owner's researchTools globs, stamp
 * lastResearchAt. Never alters the result; errors are logged, never
 * thrown (the hook must not break tool execution).
 */
export function createResearch(deps) {
    return async function afterTool(call, _result, api, _context) {
        try {
            const meta = await deps.conversationMeta(api.conversationId);
            if (meta.internal === true || meta.owner === undefined)
                return undefined;
            const settings = await resolveUserSettings({
                get: () => deps.userSettings(meta.owner),
            });
            if (!settings.researchTools.some((glob) => matchesGlob(glob, call.name))) {
                return undefined;
            }
            const stateDir = deps.userStateDir(meta.owner);
            const flags = readResearchFlags(stateDir);
            const key = String(api.conversationId);
            const entry = flags[key] ?? { lastResearchAt: 0 };
            flags[key] = { ...entry, lastResearchAt: deps.now() };
            writeResearchFlags(stateDir, flags);
        }
        catch (error) {
            console.error("knowledge: research flag failed", error);
        }
        return undefined;
    };
}
/**
 * Whether the target wants a review of this conversation (one per
 * research burst): true when research happened and no request was made
 * within the last RESEARCH_WINDOW_MS; stamps requestedAt so further
 * settles while a review is queued don't enqueue a second one. A review
 * that never completes is re-requested after the window.
 */
export function requestReview(stateDir, conversationId, now) {
    const flags = readResearchFlags(stateDir);
    const key = String(conversationId);
    const entry = flags[key];
    if (entry === undefined || entry.lastResearchAt === 0)
        return false;
    if (entry.requestedAt !== undefined &&
        now - entry.requestedAt < RESEARCH_WINDOW_MS) {
        return false;
    }
    flags[key] = { ...entry, requestedAt: now };
    writeResearchFlags(stateDir, flags);
    return true;
}
/** The review consumed the flag: delete the entry. */
export function clearReview(stateDir, conversationId) {
    const flags = readResearchFlags(stateDir);
    const key = String(conversationId);
    if (flags[key] === undefined)
        return;
    delete flags[key];
    writeResearchFlags(stateDir, flags);
}
