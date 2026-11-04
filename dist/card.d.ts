import type { KnowledgeDb } from "./db.js";
export interface KnowledgeCard {
    title: string;
    text: string;
    /** ISO date of the card (from `now`). */
    date: string;
    /** Recall handles cited by the entity's fields. */
    sources: string[];
}
/**
 * Render the review card for one entity: title, one line per field with
 * its observed date (and a stale mark past the field's horizon), the
 * inquiries the entity has roles in, and the cited recall handles.
 */
export declare function renderCard(db: KnowledgeDb, entityId: string, now: number): KnowledgeCard;
