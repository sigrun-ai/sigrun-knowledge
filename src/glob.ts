/** Match a tool name against a glob where `*` matches any run of characters. */
export function matchesGlob(pattern: string, name: string): boolean {
	const source = pattern
		.split("*")
		.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`).test(name);
}
