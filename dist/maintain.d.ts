import type { HandlerContext, MaintenanceBudget, MaintenanceReport } from "@sigrun/sigrun/extension";
import type { KnowledgeDb } from "./db.js";
import { type MirrorHost } from "./mirror.js";
import type { FieldDef } from "./schema.js";
export interface MaintainDeps {
    host: MirrorHost;
    dbForUser(user: string): KnowledgeDb;
    now(): number;
}
interface TypeRow {
    id: number;
    name: string;
    description: string;
    parentId: number | null;
    fields: string;
    archived: number;
}
/** Jaccard similarity of two field-name sets. */
export declare function jaccard(a: readonly string[], b: readonly string[]): number;
/** Effective (own + inherited) field defs for a type. */
export declare function effectiveFields(typesById: Map<number, TypeRow>, typeId: number): FieldDef[];
/**
 * The idle pass, in order, stopping at the deadline:
 * 1. re-index up to 50 pending/stale entities (not reported);
 * 2. continue an unfinished re-typing before proposing anything new;
 * 3. propose one generalization via budget.run (needs runs >= 1);
 * 4. apply it as a hierarchy in one change, folding field-less children
 *    (<= 50 entities per pass; the rest continue next pass under the
 *    same change id, reported with more: true).
 * At most one generalization per pass.
 */
export declare function maintain(user: string, ctx: HandlerContext, budget: MaintenanceBudget, deps: MaintainDeps): Promise<MaintenanceReport>;
export {};
