import type { KnowledgeDb } from "./db.js";
import { renderCard } from "./card.js";

/**
 * The recall payload shapes this extension sends (mirrored locally — the
 * plan's shapes, recall Task 7; knowledge treats recall as optional and
 * never imports it).
 */
export interface RecallIndexPayload {
	id: string;
	kind: "record";
	title: string;
	text: string;
	date: string;
	sources: string[];
}

type HookResult =
	| { status: "absent" }
	| { status: "ok"; value?: unknown }
	| { status: "rejected" | "failed"; [key: string]: unknown };

export interface MirrorHost {
	publishedHooks: {
		call(
			name: string,
			payload: unknown,
			opts?: { user?: string; conversationId?: number },
		): Promise<HookResult>;
	};
}

interface EntityRow {
	id: string;
	archived: number;
	indexedAt: number | null;
}

/**
 * Mirror each touched entity into recall: live entities are indexed from
 * their rendered card (kind "record"), archived ones removed. `ok` stores
 * the returned class and stamps indexedAt; `absent` does nothing;
 * `failed`/`rejected` leaves indexedAt behind so the next idle pass
 * retries. Pass `user` explicitly — undo and maintenance have no
 * conversation.
 */
export async function mirrorEntities(
	host: MirrorHost,
	db: KnowledgeDb,
	user: string,
	entityIds: readonly string[],
	now: number,
): Promise<void> {
	for (const entityId of entityIds) {
		const row = db
			.raw()
			.prepare("SELECT id, archived, indexedAt FROM entities WHERE id = ?")
			.get(entityId) as EntityRow | undefined;
		if (row === undefined) continue;

		if (row.archived === 1) {
			try {
				await host.publishedHooks.call(
					"recall.remove",
					{ id: entityId },
					{ user },
				);
			} catch (error) {
				console.error("knowledge: recall.remove failed", error);
			}
			continue;
		}

		const card = renderCard(db, entityId, now);
		const payload: RecallIndexPayload = {
			id: entityId,
			kind: "record",
			title: card.title,
			text: card.text,
			date: card.date,
			sources: card.sources,
		};
		let result: HookResult;
		try {
			result = await host.publishedHooks.call("recall.index", payload, {
				user,
			});
		} catch (error) {
			console.error("knowledge: recall.index failed", error);
			continue;
		}
		if (result.status !== "ok") {
			// A rejected/failed hook leaves indexedAt behind so the idle pass
			// retries — but never silently: name the hook and status so the
			// shape-mismatch class the e2e exposed surfaces immediately.
			console.error(
				`knowledge: recall.index answered ${result.status} for entity ${entityId}`,
			);
			continue;
		}
		const value = result.value as
			| { handle?: string; class?: string; changed?: boolean }
			| undefined;
		const cls =
			value?.class === "local-only" ? "local-only" : ("normal" as const);
		db.raw()
			.prepare("UPDATE entities SET cls = ?, indexedAt = ? WHERE id = ?")
			.run(cls, now, entityId);
	}
}
