import { renderCard } from "./card.js";
/**
 * Mirror each touched entity into recall: live entities are indexed from
 * their rendered card (kind "record"), archived ones removed. `ok` stores
 * the returned class and stamps indexedAt; `absent` does nothing;
 * `failed`/`rejected` leaves indexedAt behind so the next idle pass
 * retries. Pass `user` explicitly — undo and maintenance have no
 * conversation.
 */
export async function mirrorEntities(host, db, user, entityIds, now) {
    for (const entityId of entityIds) {
        const row = db
            .raw()
            .prepare("SELECT id, archived, indexedAt FROM entities WHERE id = ?")
            .get(entityId);
        if (row === undefined)
            continue;
        if (row.archived === 1) {
            try {
                await host.publishedHooks.call("recall.remove", { id: entityId }, { user });
            }
            catch (error) {
                console.error("knowledge: recall.remove failed", error);
            }
            continue;
        }
        const card = renderCard(db, entityId, now);
        const payload = {
            id: entityId,
            kind: "record",
            title: card.title,
            text: card.text,
            date: card.date,
            sources: card.sources,
        };
        let result;
        try {
            result = await host.publishedHooks.call("recall.index", payload, {
                user,
            });
        }
        catch (error) {
            console.error("knowledge: recall.index failed", error);
            continue;
        }
        if (result.status !== "ok") {
            // A rejected/failed hook leaves indexedAt behind so the idle pass
            // retries — but never silently: name the hook and status so the
            // shape-mismatch class the e2e exposed surfaces immediately.
            console.error(`knowledge: recall.index answered ${result.status} for entity ${entityId}`);
            continue;
        }
        const value = result.value;
        const cls = value?.class === "local-only" ? "local-only" : "normal";
        db.raw()
            .prepare("UPDATE entities SET cls = ?, indexedAt = ? WHERE id = ?")
            .run(cls, now, entityId);
    }
}
