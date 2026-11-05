import type { KnowledgeDb } from "./db.js";
import { type FieldDef, type TypeHierarchyRow, effectiveFields } from "./schema.js";

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

/** Parse an observedAt as a date-only string or a full ISO timestamp. */
function parseObserved(observedAt: string): number | null {
	const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
	const parsed = Date.parse(
		dateOnly.test(observedAt) ? `${observedAt}T00:00:00Z` : observedAt,
	);
	return Number.isNaN(parsed) ? null : parsed;
}

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
			`SELECT e.id, e.name, e.fields, e.typeId, t.name AS typeName
			 FROM entities e JOIN types t ON t.id = e.typeId WHERE e.id = ?`,
		)
		.get(entityId) as
		| {
				id: string;
				name: string;
				fields: string;
				typeId: number;
				typeName: string;
			}
		| undefined;
	if (row === undefined) {
		throw new Error(`renderCard: unknown entity "${entityId}"`);
	}

	// Inherited fields carry their defs (horizonDays) down the hierarchy.
	const typeRows = db
		.raw()
		.prepare("SELECT id, parentId, fields FROM types")
		// SAFETY: the types table columns are fixed by db.ts's schema;
		// node:sqlite types rows generically.
		.all() as unknown as TypeHierarchyRow[];
	const typeFields = effectiveFields(
		new Map(typeRows.map((type) => [type.id, type])),
		row.typeId,
	);
	const fields = JSON.parse(row.fields) as Record<string, FieldRecord>;
	const sources = new Set<string>();
	// The card body leads with the title line: recall indexes a doc's TEXT
	// (never its title), so the type/entity name must appear here for the
	// card to be findable by name.
	const title = `${row.typeName} — ${row.name}`;
	const lines: string[] = [title];

	for (const [name, field] of Object.entries(fields)) {
		sources.add(field.source);
		const def = typeFields.find((candidate) => candidate.name === name);
		// observedAt may be date-only or a full ISO timestamp: parse both
		// for staleness, but always render the date part.
		const observedMs = parseObserved(field.observedAt);
		const observedDate =
			observedMs === null
				? field.observedAt
				: new Date(observedMs).toISOString().slice(0, 10);
		let observed = `observed ${observedDate}`;
		if (
			def?.horizonDays !== undefined &&
			observedMs !== null &&
			now - observedMs > def.horizonDays * DAY_MS
		) {
			observed += ", stale";
		}
		lines.push(`${name}: ${formatField(field.value)} (${observed})`);
	}

	const roles = db
		.raw()
		.prepare(
			`SELECT i.question AS question, r.role AS role, r.reason AS reason
			FROM roles r JOIN inquiries i ON i.id = r.inquiryId
			WHERE r.entityId = ? AND i.archived = 0 ORDER BY i.question`,
		)
		.all(entityId) as { question: string; role: string; reason: string | null }[];
	for (const role of roles) {
		const reason = role.reason === null ? "" : ` — ${role.reason}`;
		lines.push(`${role.question}: ${role.role}${reason}`);
	}

	return {
		title,
		text: lines.join("\n"),
		date: new Date(now).toISOString(),
		sources: [...sources],
	};
}
