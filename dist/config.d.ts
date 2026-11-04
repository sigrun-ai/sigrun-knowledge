export interface SettingsReader {
    get(): Promise<Record<string, unknown>>;
}
export interface UserKnowledgeSettings {
    researchTools: readonly string[];
}
/**
 * Match a tool name against a glob where `*` is the only wildcard and
 * matches any run of characters (including none). Everything else in the
 * pattern is literal.
 */
export declare function matchesGlob(pattern: string, name: string): boolean;
export declare function resolveUserSettings(store: SettingsReader): Promise<UserKnowledgeSettings>;
