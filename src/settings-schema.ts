import { Type, type Static } from "typebox";

function asJsonSchema<T>(schema: T): T & Readonly<Record<string, unknown>> {
	return schema as T & Readonly<Record<string, unknown>>;
}

export const KNOWLEDGE_USER_SCHEMA = asJsonSchema(Type.Object({
	researchTools: Type.Array(Type.String({ minLength: 1 }), {
		title: "Research tools",
		description: "Tool-name globs whose results count as research since the last review.",
		default: ["*/search*", "*/fetch*", "*/crawl*", "*/md", "web_search", "web_fetch"],
		"x-sigrun-apply": "live",
	}),
}));

export type KnowledgeSettings = Record<string, never>;
export type KnowledgeUserSettings = Static<typeof KNOWLEDGE_USER_SCHEMA>;
