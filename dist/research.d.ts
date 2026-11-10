import type { ToolHookCall, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { KnowledgeUserSettings } from "./settings-schema.js";
/**
 * The per-conversation "researched since last review" flag, per user:
 * `<user state>/research.json` maps conversationId (string key) to
 * `{ lastResearchAt, requestedAt? }` (epoch ms).
 */
export interface ResearchFlags {
    [conversationId: string]: {
        lastResearchAt: number;
        requestedAt?: number;
    };
}
/** The window a queued review suppresses duplicate requests. */
export declare const RESEARCH_WINDOW_MS: number;
export declare function readResearchFlags(stateDir: string): ResearchFlags;
export interface ResearchDeps {
    /** Live conversation meta (internal flag + owner). */
    conversationMeta(conversationId: number): Promise<{
        owner?: string;
        internal?: true;
    }>;
    /** The directory user's state dir (research.json lives there). */
    userStateDir(user: string): string;
    /** The extension's checked per-user settings (researchTools). */
    userSettings(user: string): Promise<KnowledgeUserSettings>;
    now(): number;
}
/**
 * The afterTool hook: for a non-internal conversation with an owner and a
 * tool name matching the owner's researchTools globs, stamp
 * lastResearchAt. Never alters the result; errors are logged, never
 * thrown (the hook must not break tool execution).
 */
export declare function createResearch(deps: ResearchDeps): (call: ToolHookCall, _result: ToolExecutionResult, api: {
    conversationId: number;
}, _context: unknown) => Promise<undefined>;
/**
 * Whether the target wants a review of this conversation (one per
 * research burst): true when research happened and no request was made
 * within the last RESEARCH_WINDOW_MS; stamps requestedAt so further
 * settles while a review is queued don't enqueue a second one. A review
 * that never completes is re-requested after the window.
 */
export declare function requestReview(stateDir: string, conversationId: number, now: number): boolean;
/** The review consumed the flag: delete the entry. */
export declare function clearReview(stateDir: string, conversationId: number): void;
