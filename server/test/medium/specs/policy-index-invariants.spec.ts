import { Kysely, sql } from 'kysely';
import { DB } from 'src/schema';
import { getKyselyDB } from 'test/utils';

/**
 * The partial index the visibility policy leans on.
 *
 * `asset_id_timeline_notDeleted_idx` is predicated on `visibility = 'timeline'`, and the policy
 * helpers use `sql.lit` specifically so the generated SQL keeps inlining that literal and the planner
 * keeps choosing this index. Two ways that can break without anything else noticing:
 *
 * 1. An upstream migration drops, renames, or re-predicates it. Nothing in our code references the
 *    index by name, so no test and no compile step would fail; queries would simply get slower on a
 *    large library, which is invisible on a small test database.
 * 2. The enum label `'timeline'` changes, which would leave the index in place but no longer matching
 *    what the policy asks for.
 *
 * This is a characterization test against the live schema rather than against a source file, because
 * the schema is what the planner actually sees, and migrations are what change it.
 */

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('visibility policy database invariants', () => {
  it('should keep asset_id_timeline_notDeleted_idx predicated on visibility = timeline', async () => {
    const { rows } = await sql<{
      indexdef: string;
    }>`select indexdef from pg_indexes where indexname = 'asset_id_timeline_notDeleted_idx'`.execute(defaultDatabase);

    expect(rows).toHaveLength(1);

    const [{ indexdef }] = rows;
    // Asserted on the pieces rather than the whole string, so Postgres reformatting the definition or
    // upstream adding a column to the index does not fail this for no reason. What must hold is the
    // predicate: both halves of it, and the table and column it is on.
    expect(indexdef).toContain('ON public.asset');
    expect(indexdef).toContain('btree (id)');
    expect(indexdef).toMatch(/visibility = 'timeline'/);
    expect(indexdef).toMatch(/"deletedAt" IS NULL/);
  });

  it('should still have timeline as a value of the visibility enum', async () => {
    // If this label is ever renamed, the index above would survive while quietly matching nothing the
    // policy asks for, which is the harder version of the same failure.
    const { rows } = await sql<{ label: string }>`
      select enumlabel as label
      from pg_enum
      join pg_type on pg_type.oid = pg_enum.enumtypid
      where pg_type.typname = 'asset_visibility_enum'
    `.execute(defaultDatabase);

    expect(rows.map(({ label }) => label).sort()).toEqual(['archive', 'hidden', 'locked', 'timeline']);
  });
});
