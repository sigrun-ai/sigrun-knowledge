import { Type, type Static } from "typebox";
export declare const KNOWLEDGE_USER_SCHEMA: Type.TObject<{
    researchTools: Type.TArray<Type.TString>;
}> & Readonly<Record<string, unknown>>;
export type KnowledgeSettings = Record<string, never>;
export type KnowledgeUserSettings = Static<typeof KNOWLEDGE_USER_SCHEMA>;
