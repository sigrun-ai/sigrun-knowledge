import type { KnowledgeDb } from "./db.js";
export interface UndoResult {
    restored: number;
    /** Human-readable lines for rows whose current state no longer matches. */
    skipped: string[];
    /** Entity ids the undo touched (restored or archived). */
    touched: string[];
}
/**
 * Undo a change: walk its versions newest-first and restore each row's
 * `before` state — but only while the row still equals the change's
 * `after`. A row a later change edited is skipped, so undo restores only
 * what the change last wrote. Every restore is itself recorded as a
 * version under `undo:<changeId>`, so nothing is lost.
 */
export declare function undoChange(db: KnowledgeDb, changeId: string, now: number): UndoResult;
