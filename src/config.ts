export interface SettingsReader {
	get(): Promise<Record<string, unknown>>;
}

export interface UserKnowledgeSettings {
	researchTools: readonly string[];
}

const DEFAULT_RESEARCH_TOOLS: readonly string[] = [
	"*/search*",
	"*/fetch*",
	"*/crawl*",
	"*/md",
	"web_search",
	"web_fetch",
];

function warnInvalid(setting: string): void {
	console.warn(`knowledge: invalid ${setting} setting; using its default`);
}

/**
 * Match a tool name against a glob where `*` is the only wildcard and
 * matches any run of characters (including none). Everything else in the
 * pattern is literal.
 */
export function matchesGlob(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}

export async function resolveUserSettings(
	store: SettingsReader,
): Promise<UserKnowledgeSettings> {
	const raw = await store.get();
	if (raw.researchTools !== undefined) {
		if (
			Array.isArray(raw.researchTools) &&
			raw.researchTools.every(
				(tool) => typeof tool === "string" && tool !== "",
			)
		) {
			return { researchTools: [...raw.researchTools] };
		}
		warnInvalid("researchTools");
	}
	return { researchTools: [...DEFAULT_RESEARCH_TOOLS] };
}
