import * as SQLite from 'expo-sqlite';

import { SCHEMA_STATEMENTS } from './schema';

const DATABASE_NAME = 'milelift.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let migrated = false;

/**
 * Lazily opens (once) and returns the local SQLite database, running the
 * schema migration on first open. All repositories go through this — never
 * call `expo-sqlite` directly from a screen or component.
 */
export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DATABASE_NAME).then(async (db) => {
      if (!migrated) {
        await runMigrations(db);
        migrated = true;
      }
      return db;
    });
  }
  return dbPromise;
}

async function runMigrations(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (const statement of SCHEMA_STATEMENTS) {
      await db.execAsync(statement);
    }
  });
}

/** Test-only: force a fresh in-memory-equivalent state between test cases. */
export function __resetDbForTests(): void {
  dbPromise = null;
  migrated = false;
}
