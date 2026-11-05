import { type ToolRegistration } from "@earendil-works/pi-durable";
import type { KnowledgeDb } from "./db.js";
type HookResult = {
    status: "absent";
} | {
    status: "ok";
    value?: unknown;
} | {
    status: "rejected" | "failed";
    [key: string]: unknown;
};
export interface ToolsHost {
    identity: {
        actingUser(conversationId: number): Promise<string | undefined>;
    };
    conversations: {
        meta(id: number): Promise<{
            owner?: string;
            internal?: true;
            sharing?: import("@sigrun/shared/access").Sharing;
        }>;
        entries(id: number, query: {
            order?: "ascending" | "descending";
        }, limit: number, cursor?: unknown): Promise<{
            items: readonly {
                conversationId: number;
            }[];
            next?: unknown;
        }>;
    };
    publishedHooks: {
        call(name: string, payload: unknown, opts?: {
            user?: string;
            conversationId?: number;
        }): Promise<HookResult>;
    };
}
export interface ToolsDeps {
    host: ToolsDepsHost;
    dbForUser(user: string): KnowledgeDb;
    now(): number;
}
export type ToolsDepsHost = ToolsHost;
export declare function createTools(deps: ToolsDeps): readonly ToolRegistration[];
export {};
