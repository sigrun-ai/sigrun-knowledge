import { accessOf } from "@sigrun/shared/access";
export function audienceCovers(current, item) {
    // Ownerless items are readable by everyone.
    if (item.owner === undefined)
        return true;
    if (current.sharing?.scope === "people") {
        const users = new Set(current.sharing.users);
        if (current.owner !== undefined)
            users.add(current.owner);
        for (const user of users) {
            if (accessOf({ user }, item) === "none")
                return false;
        }
        return (current.sharing.groups ?? []).every((group) => item.sharing?.scope === "household" ||
            (item.sharing?.scope === "people" &&
                item.sharing.groups?.includes(group) === true));
    }
    if (current.sharing?.scope === "household") {
        return item.sharing?.scope === "household";
    }
    if (current.owner === undefined) {
        return item.sharing?.scope === "household";
    }
    // Private, including an absent sharing grant: only the owner reads current.
    return accessOf({ user: current.owner }, item) !== "none";
}
