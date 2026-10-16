import assert from "node:assert/strict";
import { test } from "node:test";
import { checkMigrationRule } from "./migration-rule.mjs";

const HEADER = "-- Expand-only: compatible with the previous release's Worker (ADR 0006).\n";
const migration = (file, body = "CREATE TABLE t (x INTEGER);\n") => ({ file, text: `${HEADER}\n${body}` });
const changeset = (file, body) => ({ file, text: `---\n"furea": patch\n---\n\n${body}\n` });

test("a migration added with a changeset naming it passes", () => {
  const problems = checkMigrationRule({
    migrations: [migration("0001_init.sql"), migration("0002_add_tags.sql")],
    addedMigrations: ["0002_add_tags.sql"],
    addedChangesets: [changeset("brave-tags.md", "Tags on links.\n\nMigration: 0002_add_tags.sql")],
  });
  assert.deepEqual(problems, []);
});

test("a migration added without a changeset line is refused, naming the line to add", () => {
  const problems = checkMigrationRule({
    migrations: [migration("0001_init.sql"), migration("0002_add_tags.sql")],
    addedMigrations: ["0002_add_tags.sql"],
    addedChangesets: [changeset("brave-tags.md", "Tags on links.")],
  });
  assert.deepEqual(problems, [
    "0002_add_tags.sql is a new migration, but no changeset in this change carries the line `Migration: 0002_add_tags.sql`",
  ]);
});

test("a Migration: line naming a file this change does not add is refused", () => {
  const problems = checkMigrationRule({
    migrations: [migration("0001_init.sql")],
    addedMigrations: [],
    addedChangesets: [changeset("odd.md", "Migration: 0002_add_tags.sql")],
  });
  assert.deepEqual(problems, [
    "odd.md names `Migration: 0002_add_tags.sql`, but this change adds no migration of that name",
  ]);
});

test("the line must be exactly `Migration: NNNN_name.sql` at the start of a line", () => {
  const problems = checkMigrationRule({
    migrations: [migration("0001_init.sql"), migration("0002_add_tags.sql")],
    addedMigrations: ["0002_add_tags.sql"],
    addedChangesets: [changeset("loose.md", "Adds migration: 0002_add_tags.sql\n  Migration: 0002_add_tags.sql")],
  });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /no changeset in this change carries the line `Migration: 0002_add_tags.sql`/);
});

test("every migration file must open with the expand-only header comment", () => {
  const problems = checkMigrationRule({
    migrations: [migration("0001_init.sql"), { file: "0002_drop.sql", text: "ALTER TABLE links DROP COLUMN title;\n" }],
    addedMigrations: [],
    addedChangesets: [],
  });
  assert.deepEqual(problems, [
    "0002_drop.sql does not start with the expand-only header `-- Expand-only: compatible with the previous release's Worker (ADR 0006).`",
  ]);
});
