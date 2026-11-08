/**
 * The read-only Knowledge view. It reads only the calling principal's store,
 * and only after checking that the store file already exists: rendering must
 * never create a database for a user who has no knowledge yet.
 */
import type { SigrunHost, SurfaceDef } from "@sigrun/sigrun/extension";
import type { KnowledgeDb } from "./db.js";
export interface KnowledgeViewDeps {
    readonly host: SigrunHost;
    readonly dbForUser: (user: string) => KnowledgeDb;
    readonly storePath: (user: string) => string;
    readonly now: () => number;
}
/** The view surface, over the factory's per-user database opener. */
export declare function createKnowledgeView(deps: KnowledgeViewDeps): SurfaceDef<"view">;
