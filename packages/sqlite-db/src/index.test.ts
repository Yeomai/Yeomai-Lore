import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createDatabase,
  isUniqueConstraint,
} from "./index";

describe("sqlite adapter", () => {
  it("supports positional parameters and row counts", async () => {
    const db = createDatabase(":memory:");
    await db.query(
      "CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await db.query("INSERT INTO items (id, value) VALUES ($1, $2)", [
      "one",
      "value",
    ]);
    const result = await db.query<{ id: string; value: string }>(
      "SELECT id, value FROM items WHERE id = $1",
      ["one"],
    );
    expect(result.rows).toEqual([{ id: "one", value: "value" }]);
    await db.end();
  });

  it("isolates an explicit transaction on its own connection", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "lore-sqlite-test-"));
    const db = createDatabase(path.join(directory, "portal.sqlite"));
    try {
      await db.query("CREATE TABLE items (id TEXT PRIMARY KEY)");
      const client = await db.connect();
      await client.query("BEGIN");
      await client.query("INSERT INTO items (id) VALUES ($1)", ["one"]);
      await client.query("ROLLBACK");
      client.release();
      const result = await db.query("SELECT id FROM items");
      expect(result.rows).toEqual([]);
    } finally {
      await db.end();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("recognizes a unique constraint error", async () => {
    const db = createDatabase(":memory:");
    await db.query("CREATE TABLE items (id TEXT PRIMARY KEY)");
    await db.query("INSERT INTO items (id) VALUES ($1)", ["one"]);
    try {
      await db.query("INSERT INTO items (id) VALUES ($1)", ["one"]);
      throw new Error("Expected a unique constraint failure");
    } catch (error) {
      expect(isUniqueConstraint(error)).toBe(true);
    } finally {
      await db.end();
    }
  });
});
