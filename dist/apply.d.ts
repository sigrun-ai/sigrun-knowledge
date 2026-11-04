import type { KnowledgeDb } from "./db.js";
import { type TypeDef } from "./schema.js";
declare const ENTITY_ROLES: readonly ["candidate", "shortlisted", "rejected", "chosen"];
export interface RecordInput {
    inquiry?: {
        id?: string;
        question: string;
        why?: string;
        outcome?: {
            status: "open" | "decided" | "abandoned";
            what?: string;
        };
    };
    types?: TypeDef[];
    entities: {
        id?: string;
        type: string;
        name: string;
        keys: Record<string, string>;
        fields: Record<string, {
            value: unknown;
            source: string;
            observedAt: string;
        }>;
        attributes?: Record<string, unknown>;
        role?: (typeof ENTITY_ROLES)[number];
        reason?: string;
    }[];
}
export interface ApplyResult {
    changeId: string;
    summary: string;
    /** Entity ids created or updated. */
    touched: string[];
    errors: string[];
}
export interface ApplyContext {
    conversationId?: number;
    callId: string;
    now: number;
}
/** Normalize an identity key value for matching within a type family. */
export declare function normalizeKey(key: string, value: string): string;
/**
 * Apply one knowledge record atomically. Any validation error rolls the
 * whole record back and is reported in `errors`. Replaying an already
 * applied `callId` returns the stored result unchanged.
 */
export declare function applyRecord(db: KnowledgeDb, input: RecordInput, ctx: ApplyContext): ApplyResult;
/**
 * Move entities to a different type: field values the new type does not
 * declare move into attributes, and identity keys re-root at the new
 * type's family.
 */
export declare function retypeEntities(db: KnowledgeDb, entityIds: readonly string[], toType: string, changeId: string, now: number): void;
export {};
