import type { KnowledgeDb } from "./db.js";
import type { FieldDef } from "./schema.js";

export interface KnowledgeCard {
	title: string;
	text: string;
	/** ISO date of the card (from `now`). */
	date: string;
	/** Recall handles cited by the entity's fields. */
	sources: string[];
}

interface FieldRecord {
	value: unknown;
	source: string;
	observedAt: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatField(value: unknown): string {
	if (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		typeof (value as Record<string, unknown>).amount === "number"
	) {
		const money = value as { amount: number; currency: string };
		return `${money.amount} ${money.currency}`;
	}
	if (Array.isArray(value)) return value.map(formatField).join(", ");
	return String(value);
}

/**
 * Render the review card for one entity: title, one line per field with
 * its observed date (and a stale mark past the field's horizon), the
 * inquiries the entity has roles in, and the cited recall handles.
 */
export function renderCard(
	db: KnowledgeDb,
	entityId: string,
	now: number,
): KnowledgeCard {
	const row = db
		.raw()
		.prepare(
			`SELECT e.id, e.name, e.fields, t.fields AS typeFields, t.name AS typeName
			 FROM entities e JOIN types t ON t.id = e.typeId WHERE e.id = ?`,
		)
		.get(entityId) as
		| {
				id: string;
				name: string;
				fields: string;
				typeFields: string;
				typeName: string;
			}
		| undefined;
	if (row === undefined) {
		throw new Error(`renderCard: unknown entity "${entityId}"`);
	}

	const typeFields = JSON.parse(row.typeFields) as FieldDef[];
	const fields = JSON.parse(row.fields) as Record<string, FieldRecord>;
	const sources = new Set<string>();
	const lines: string[] = [];

	for (const [name, field] of Object.entries(fields)) {
		sources.add(field.source);
		const def = typeFields.find((candidate) => candidate.name === name);
		let observed = `observed ${field.observedAt}`;
		if (def?.horizonDays !== undefined) {
			const observedMs = Date.parse(`${field.observedAt}T00:00:00Z`);
			if (
				!Number.isNaN(observedMs) &&
				now - observedMs > def.horizonDays * DAY_MS
			) {
				observed += ", stale";
			}
		}
		lines.push(`${name}: ${formatField(field.value)} (${observed})`);
	}

	const roles = db
		.raw()
		.prepare(
			`SELECT i.question AS question, r.role AS role, r.reason AS reason
			 FROM roles r JOIN inquiries i ON i.id = r.inquiryId
			 WHERE r.entityId = ? ORDER BY i.question`,
		)
		.all(entityId) as { question: string; role: string; reason: string | null }[];
	for (const role of roles) {
		const reason = role.reason === null ? "" : ` — ${role.reason}`;
		lines.push(`${role.question}: ${role.role}${reason}`);
	}

	return {
		title: `${row.typeName} — ${row.name}`,
		text: lines.join("\n"),
		date: new Date(now).toISOString().slice(0, 10),
		sources: [...sources],
	};
}
