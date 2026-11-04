import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
const SCHEMA = `
	CREATE TABLE IF NOT EXISTS types (
		id INTEGER PRIMARY KEY,
		name TEXT NOT NULL UNIQUE,
		description TEXT NOT NULL,
		parentId INTEGER REFERENCES types(id),
		fields TEXT NOT NULL,
		version INTEGER NOT NULL,
		archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
	);
	CREATE TABLE IF NOT EXISTS entities (
		id TEXT PRIMARY KEY,
		typeId INTEGER NOT NULL REFERENCES types(id),
		name TEXT NOT NULL,
		keys TEXT NOT NULL DEFAULT '[]',
		fields TEXT NOT NULL DEFAULT '{}',
		attributes TEXT NOT NULL DEFAULT '{}',
		cls TEXT NOT NULL DEFAULT 'normal' CHECK (cls IN ('normal', 'local-only')),
		indexedAt INTEGER,
		archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
	);
	CREATE TABLE IF NOT EXISTS entity_keys (
		id INTEGER PRIMARY KEY,
		entityId TEXT NOT NULL REFERENCES entities(id),
		typeFamilyRoot INTEGER NOT NULL REFERENCES types(id),
		key TEXT NOT NULL,
		normalized TEXT NOT NULL,
		UNIQUE (typeFamilyRoot, key, normalized)
	);
	CREATE TABLE IF NOT EXISTS inquiries (
		id INTEGER PRIMARY KEY,
		question TEXT NOT NULL,
		why TEXT,
		startedAt INTEGER NOT NULL,
		touchedAt INTEGER NOT NULL,
		conversations TEXT NOT NULL DEFAULT '[]',
		outcome TEXT
	);
	CREATE TABLE IF NOT EXISTS roles (
		id INTEGER PRIMARY KEY,
		inquiryId INTEGER NOT NULL REFERENCES inquiries(id),
		entityId TEXT NOT NULL REFERENCES entities(id),
		role TEXT NOT NULL,
		reason TEXT,
		UNIQUE (inquiryId, entityId)
	);
	CREATE TABLE IF NOT EXISTS versions (
		seq INTEGER PRIMARY KEY,
		changeId TEXT NOT NULL,
		"table" TEXT NOT NULL,
		rowId TEXT NOT NULL,
		before TEXT,
		after TEXT,
		at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS applied (
		callId TEXT PRIMARY KEY,
		changeId TEXT NOT NULL,
		result TEXT NOT NULL
	);
	CREATE TABLE IF NOT EXISTS maintenance (
		id INTEGER PRIMARY KEY,
		kind TEXT NOT NULL,
		changeId TEXT,
		payload TEXT NOT NULL DEFAULT '{}',
		cursor TEXT,
		at INTEGER NOT NULL
	);
	CREATE TABLE IF NOT EXISTS schema_version (
		version INTEGER NOT NULL
	);
`;
const SCHEMA_VERSION = 1;
/**
 * The per-user knowledge store. One database per directory user at
 * join(host.stores.user(user).paths.data, "knowledge.db").
 *
 * `typeFamilyRoot` on entity_keys is the topmost ancestor type id, so
 * identity keys de-duplicate across a type hierarchy.
 */
export class KnowledgeDb {
    db;
    constructor(db) {
        this.db = db;
    }
    static open(path) {
        if (path !== ":memory:")
            mkdirSync(dirname(path), { recursive: true });
        const db = new DatabaseSync(path);
        try {
            const opened = new KnowledgeDb(db);
            opened.migrate();
            return opened;
        }
        catch (error) {
            db.close();
            throw error;
        }
    }
    migrate() {
        this.transaction(() => {
            this.db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
            const current = this.db
                .prepare("SELECT version FROM schema_version")
                .get();
            if (current === undefined) {
                this.db.exec(SCHEMA);
                this.db
                    .prepare("INSERT INTO schema_version (version) VALUES (?)")
                    .run(SCHEMA_VERSION);
            }
        });
    }
    /** Raw handle for the scaffold; table accessors land with Task 9. */
    raw() {
        return this.db;
    }
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        }
        catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    close() {
        this.db.close();
    }
}
