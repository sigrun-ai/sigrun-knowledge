import { DatabaseSync } from "node:sqlite";
/**
 * The per-user knowledge store. One database per directory user at
 * join(host.stores.user(user).paths.data, "knowledge.db").
 *
 * `typeFamilyRoot` on entity_keys is the topmost ancestor type id, so
 * identity keys de-duplicate across a type hierarchy.
 */
export declare class KnowledgeDb {
    private readonly db;
    private constructor();
    static open(path: string): KnowledgeDb;
    private migrate;
    /** Raw handle for the scaffold; table accessors land with Task 9. */
    raw(): DatabaseSync;
    transaction<T>(fn: () => T): T;
    close(): void;
}
