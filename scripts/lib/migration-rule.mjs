// The changeset migration rule (docs/release.md, *Migration-bearing releases*; ADR 0006): a change that adds a
// migration carries a changeset with the line `Migration: NNNN_name.sql` for it, a `Migration:` line names a file
// the change adds, and every migration file opens with the expand-only header comment.

export const EXPAND_ONLY_HEADER = "-- Expand-only: compatible with the previous release's Worker (ADR 0006).";

const MIGRATION_LINE = /^Migration: (\d{4}_[A-Za-z0-9_-]+\.sql)$/gm;

/**
 * @param {{
 *   migrations: { file: string, text: string }[],
 *   addedMigrations: string[],
 *   addedChangesets: { file: string, text: string }[],
 * }} input every migration file with its text; the migration file names and the changesets this change adds
 * @returns {string[]} one problem per entry; empty when the rule holds
 */
export function checkMigrationRule({ migrations, addedMigrations, addedChangesets }) {
  const problems = [];
  for (const { file, text } of migrations) {
    if (!text.startsWith(EXPAND_ONLY_HEADER)) {
      problems.push(`${file} does not start with the expand-only header \`${EXPAND_ONLY_HEADER}\``);
    }
  }
  const named = new Map();
  for (const { file, text } of addedChangesets) {
    for (const [, migration] of text.matchAll(MIGRATION_LINE)) named.set(migration, file);
  }
  const added = new Set(addedMigrations);
  for (const migration of addedMigrations) {
    if (!named.has(migration)) {
      problems.push(
        `${migration} is a new migration, but no changeset in this change carries the line \`Migration: ${migration}\``,
      );
    }
  }
  for (const [migration, file] of named) {
    if (!added.has(migration)) {
      problems.push(`${file} names \`Migration: ${migration}\`, but this change adds no migration of that name`);
    }
  }
  return problems;
}
