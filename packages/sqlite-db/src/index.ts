import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  DatabaseSync,
  type SQLInputValue,
  type SQLOutputValue,
} from "node:sqlite";

type Row = Record<string, SQLOutputValue>;

export interface QueryResult<T = Row> {
  rows: T[];
  rowCount: number;
}

export interface QueryExecutor {
  query<T = Row>(
    sql: string,
    params?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface DatabaseClient extends QueryExecutor {
  release(): void;
}

export class SqliteDatabase implements QueryExecutor {
  private readonly db: DatabaseSync;

  constructor(private readonly databasePath: string) {
    if (databasePath !== ":memory:") {
      mkdirSync(path.dirname(databasePath), { recursive: true });
    }
    this.db = openDatabase(databasePath);
  }

  async query<T = Row>(
    sql: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    return execute<T>(this.db, sql, params);
  }

  async connect(): Promise<DatabaseClient> {
    const db = openDatabase(this.databasePath);
    return {
      query: async <T = Row>(
        sql: string,
        params: unknown[] = [],
      ) => execute<T>(db, sql, params),
      release: () => db.close(),
    };
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  async end(): Promise<void> {
    this.db.close();
  }
}

export type Database = SqliteDatabase;

export function createDatabase(databasePath: string): Database {
  return new SqliteDatabase(databasePath);
}

export async function withTransaction<T>(
  db: Database,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query("BEGIN IMMEDIATE");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the operation error when SQLite already ended the transaction.
    }
    throw error;
  } finally {
    client.release();
  }
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isoAfterSeconds(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export function toIsoString(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return new Date(String(value)).toISOString();
}

export function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("UNIQUE constraint failed")
  );
}

function openDatabase(databasePath: string): DatabaseSync {
  const db = new DatabaseSync(databasePath, {
    enableForeignKeyConstraints: true,
    timeout: 5_000,
  });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  return db;
}

function execute<T>(
  db: DatabaseSync,
  sql: string,
  params: unknown[],
): QueryResult<T> {
  const orderedParams: SQLInputValue[] = [];
  const statementSql = sql.replace(/\$(\d+)/g, (_match, index: string) => {
    orderedParams.push(normalizeParameter(params[Number(index) - 1]));
    return "?";
  });
  const statement = db.prepare(statementSql);
  const returnsRows = statement.columns().length > 0;
  if (returnsRows) {
    const rows = statement.all(...orderedParams) as T[];
    return { rows, rowCount: rows.length };
  }
  const result = statement.run(...orderedParams);
  return { rows: [], rowCount: Number(result.changes) };
}

function normalizeParameter(value: unknown): SQLInputValue {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}
