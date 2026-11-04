const DEFAULT_RESEARCH_TOOLS = [
    "*/search*",
    "*/fetch*",
    "*/crawl*",
    "*/md",
    "web_search",
    "web_fetch",
];
function warnInvalid(setting) {
    // Warn once per setting name: Task 10 resolves settings per tool call,
    // so a misconfigured user must not spam the log on every call.
    if (warned.has(setting))
        return;
    warned.add(setting);
    console.warn(`knowledge: invalid ${setting} setting; using its default`);
}
const warned = new Set();
/** Test hook: clear the warn-once registry between tests. */
export function resetWarnedForTests() {
    warned.clear();
}
/**
 * Match a tool name against a glob where `*` is the only wildcard and
 * matches any run of characters (including none). Everything else in the
 * pattern is literal.
 */
export function matchesGlob(pattern, name) {
    const source = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp(`^${source}$`).test(name);
}
export async function resolveUserSettings(store) {
    const raw = await store.get();
    if (raw.researchTools !== undefined) {
        if (Array.isArray(raw.researchTools) &&
            raw.researchTools.every((tool) => typeof tool === "string" && tool !== "")) {
            return { researchTools: [...raw.researchTools] };
        }
        warnInvalid("researchTools");
    }
    return { researchTools: [...DEFAULT_RESEARCH_TOOLS] };
}
