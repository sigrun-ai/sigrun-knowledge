import { type Sharing } from "@sigrun/shared/access";
/**
 * The audience rule (a private copy of recall's src/audience.ts, kept in
 * lockstep): whether an item from `item` may surface to every ordinary
 * reader of `current`. Superuser access is deliberately not part of this
 * decision.
 */
export interface ConversationAccess {
    readonly owner?: string;
    readonly sharing?: Sharing;
}
export declare function audienceCovers(current: ConversationAccess, item: ConversationAccess): boolean;
