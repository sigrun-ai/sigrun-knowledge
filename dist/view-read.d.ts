import type { DatabaseSync } from "node:sqlite";
import { type FieldDef } from "./schema.js";
export interface TypeNode {
    readonly id: number;
    readonly name: string;
    readonly description: string;
    readonly archived: boolean;
    readonly ownCount: number;
    readonly totalCount: number;
    readonly children: readonly TypeNode[];
}
export interface FieldView {
    readonly name: string;
    readonly value: string;
    readonly source: string;
    readonly observedAt: string;
    readonly stale: boolean;
}
export interface EntityRow {
    readonly id: string;
    readonly name: string;
    readonly type: string;
    readonly localOnly: boolean;
}
export interface EntityDetail extends EntityRow {
    readonly keys: readonly {
        name: string;
        normalized: string;
    }[];
    readonly fields: readonly FieldView[];
    readonly attributes: readonly {
        name: string;
        value: string;
    }[];
    readonly roles: readonly {
        inquiryId: number;
        question: string;
        role: string;
        reason: string | null;
    }[];
    readonly history: readonly {
        changeId: string;
        at: number;
        before: string;
        after: string;
        label: "created" | "archived" | "changed";
    }[];
}
export interface InquiryRow {
    readonly id: number;
    readonly question: string;
    readonly why: string | null;
    readonly outcome: string | null;
    readonly startedAt: number;
    readonly touchedAt: number;
    readonly archived: boolean;
    readonly conversations: readonly number[];
    readonly entities: readonly {
        id: string;
        name: string;
        role: string;
    }[];
}
export declare function typeTree(db: DatabaseSync, opts: {
    includeArchived: boolean;
}): readonly TypeNode[];
/** Effective field definitions for a type, including archived ancestors. */
export declare function effectiveTypeFields(db: DatabaseSync, typeId: number): readonly FieldDef[];
export declare function entitiesOfType(db: DatabaseSync, typeId: number, opts: {
    search: string;
    limit: number;
}): readonly EntityRow[];
export declare function displayValue(value: unknown): string;
export declare function entityDetail(db: DatabaseSync, id: string, now: number): EntityDetail | undefined;
export declare function inquiries(db: DatabaseSync, opts: {
    includeArchived: boolean;
}): readonly InquiryRow[];
