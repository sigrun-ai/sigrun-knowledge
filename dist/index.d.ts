import type { SigrunExtensionResult, SigrunHost } from "@sigrun/sigrun/extension";
import { KnowledgeDb } from "./db.js";
export interface FactoryDeps {
    openDb?: (path: string) => KnowledgeDb;
    now?: () => number;
}
/**
 * The loader injects the host only when factory.length > 0: keep the host
 * bare and the optional test dependencies second, so the arity stays one.
 */
export default function createKnowledge(host: SigrunHost, deps?: FactoryDeps): SigrunExtensionResult;
