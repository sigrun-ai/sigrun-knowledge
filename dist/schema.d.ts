import { type TSchema } from "@earendil-works/pi-ai";
export type FieldType = "string" | "number" | "boolean" | "date" | "url" | "money" | "enum" | "list";
export interface FieldDef {
    name: string;
    type: FieldType;
    /** Allowed values when type is "enum". */
    values?: string[];
    /** Item type when type is "list". */
    item?: Exclude<FieldType, "list">;
    /** Identity fields participate in the entity's identity keys. */
    identity?: boolean;
    /** Freshness horizon in days, for fields that age. */
    horizonDays?: number;
    description?: string;
}
export interface TypeDef {
    /** Lowercase singular phrase, e.g. "clinic" or "service visit". */
    name: string;
    description: string;
    /** Parent type name (same hierarchy = one identity family). */
    parent?: string;
    fields: FieldDef[];
}
/** Type names are lowercase singular phrases. */
export declare const TYPE_NAME_PATTERN: RegExp;
export declare const TypeDefSchema: TSchema;
/**
 * Validate one field value against its definition. Returns undefined when
 * the value is valid, otherwise a short human-readable error text.
 */
export declare function validateValue(def: FieldDef, value: unknown): string | undefined;
