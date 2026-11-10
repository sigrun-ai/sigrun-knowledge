import { Type } from "typebox";
function asJsonSchema(schema) {
    return schema;
}
export const KNOWLEDGE_USER_SCHEMA = asJsonSchema(Type.Object({
    researchTools: Type.Array(Type.String({ minLength: 1 }), {
        title: "Research tools",
        description: "Tool-name globs whose results count as research since the last review.",
        default: ["*/search*", "*/fetch*", "*/crawl*", "*/md", "web_search", "web_fetch"],
        "x-sigrun-apply": "live",
    }),
}));
