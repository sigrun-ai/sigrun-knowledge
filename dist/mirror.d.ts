import type { KnowledgeDb } from "./db.js";
/**
 * The recall payload shapes this extension sends (mirrored locally — the
 * plan's shapes, recall Task 7; knowledge treats recall as optional and
 * never imports it).
 */
export interface RecallIndexPayload {
    id: string;
    kind: "record";
    title: string;
    text: string;
    date: string;
    sources: string[];
}
type HookResult = {
    status: "absent";
} | {
    status: "ok";
    value?: unknown;
} | {
    status: "rejected" | "failed";
    [key: string]: unknown;
};
export interface MirrorHost {
    publishedHooks: {
        call(name: string, payload: unknown, opts?: {
            user?: string;
            conversationId?: number;
        }): Promise<HookResult>;
    };
}
/**
 * Mirror each touched entity into recall: live entities are indexed from
 * their rendered card (kind "record"), archived ones removed. `ok` stores
 * the returned class and stamps indexedAt; `absent` does nothing;
 * `failed`/`rejected` leaves indexedAt behind so the next idle pass
 * retries. Pass `user` explicitly — undo and maintenance have no
 * conversation.
 */
export declare function mirrorEntities(host: MirrorHost, db: KnowledgeDb, user: string, entityIds: readonly string[], now: number): Promise<void>;
export {};
