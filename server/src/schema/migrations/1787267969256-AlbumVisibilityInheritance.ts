import { Kysely, sql } from 'kysely';

export async function up(db: Kysely<any>): Promise<void> {
  await sql`CREATE OR REPLACE FUNCTION asset_sync_hidden_from_inherited(p_asset_ids uuid[])
  RETURNS void
  VOLATILE LANGUAGE PLPGSQL
  AS $$
    BEGIN
    WITH target AS (
      SELECT
        asset.id,
        nullif(coalesce((
          SELECT bit_or(coalesce(album."hiddenFrom", 0))
          FROM album_asset
          INNER JOIN album ON album.id = album_asset."albumId"
          WHERE album_asset."assetId" = asset.id AND album."deletedAt" IS NULL
        ), 0), 0) AS mask
      FROM asset
      WHERE asset.id = ANY(p_asset_ids)
    )
    UPDATE asset
    SET "hiddenFromInherited" = target.mask
    FROM target
    WHERE asset.id = target.id AND asset."hiddenFromInherited" IS DISTINCT FROM target.mask;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_hidden_from_insert()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT "assetId" FROM inserted_rows));
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_asset_hidden_from_delete()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT "assetId" FROM deleted_rows));
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`CREATE OR REPLACE FUNCTION album_hidden_from_update()
  RETURNS TRIGGER
  LANGUAGE PLPGSQL
  AS $$
    BEGIN
      PERFORM asset_sync_hidden_from_inherited(ARRAY(
        SELECT DISTINCT album_asset."assetId"
        FROM album_asset
        INNER JOIN new_rows ON new_rows.id = album_asset."albumId"
        INNER JOIN old_rows ON old_rows.id = new_rows.id
        WHERE new_rows."hiddenFrom" IS DISTINCT FROM old_rows."hiddenFrom"
           OR (new_rows."deletedAt" IS NULL) IS DISTINCT FROM (old_rows."deletedAt" IS NULL)
      ));
      RETURN NULL;
    END
  $$;`.execute(db);
  await sql`ALTER TABLE "asset" ADD "hiddenFromInherited" integer;`.execute(db);
  await sql`ALTER TABLE "asset" ADD "hiddenFromShown" integer;`.execute(db);
  await sql`ALTER TABLE "album" ADD "hiddenFrom" integer;`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_hidden_from_update"
  AFTER UPDATE ON "album"
  REFERENCING OLD TABLE AS "old_rows" NEW TABLE AS "new_rows"
  FOR EACH STATEMENT
  EXECUTE FUNCTION album_hidden_from_update();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_asset_hidden_from_delete"
  AFTER DELETE ON "album_asset"
  REFERENCING OLD TABLE AS "deleted_rows"
  FOR EACH STATEMENT
  EXECUTE FUNCTION album_asset_hidden_from_delete();`.execute(db);
  await sql`CREATE OR REPLACE TRIGGER "album_asset_hidden_from_insert"
  AFTER INSERT ON "album_asset"
  REFERENCING NEW TABLE AS "inserted_rows"
  FOR EACH STATEMENT
  EXECUTE FUNCTION album_asset_hidden_from_insert();`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_asset_sync_hidden_from_inherited', '{"type":"function","name":"asset_sync_hidden_from_inherited","sql":"CREATE OR REPLACE FUNCTION asset_sync_hidden_from_inherited(p_asset_ids uuid[])\\n  RETURNS void\\n  VOLATILE LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n    WITH target AS (\\n      SELECT\\n        asset.id,\\n        nullif(coalesce((\\n          SELECT bit_or(coalesce(album.\\"hiddenFrom\\", 0))\\n          FROM album_asset\\n          INNER JOIN album ON album.id = album_asset.\\"albumId\\"\\n          WHERE album_asset.\\"assetId\\" = asset.id AND album.\\"deletedAt\\" IS NULL\\n        ), 0), 0) AS mask\\n      FROM asset\\n      WHERE asset.id = ANY(p_asset_ids)\\n    )\\n    UPDATE asset\\n    SET \\"hiddenFromInherited\\" = target.mask\\n    FROM target\\n    WHERE asset.id = target.id AND asset.\\"hiddenFromInherited\\" IS DISTINCT FROM target.mask;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_album_asset_hidden_from_insert', '{"type":"function","name":"album_asset_hidden_from_insert","sql":"CREATE OR REPLACE FUNCTION album_asset_hidden_from_insert()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT \\"assetId\\" FROM inserted_rows));\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_album_asset_hidden_from_delete', '{"type":"function","name":"album_asset_hidden_from_delete","sql":"CREATE OR REPLACE FUNCTION album_asset_hidden_from_delete()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT \\"assetId\\" FROM deleted_rows));\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('function_album_hidden_from_update', '{"type":"function","name":"album_hidden_from_update","sql":"CREATE OR REPLACE FUNCTION album_hidden_from_update()\\n  RETURNS TRIGGER\\n  LANGUAGE PLPGSQL\\n  AS $$\\n    BEGIN\\n      PERFORM asset_sync_hidden_from_inherited(ARRAY(\\n        SELECT DISTINCT album_asset.\\"assetId\\"\\n        FROM album_asset\\n        INNER JOIN new_rows ON new_rows.id = album_asset.\\"albumId\\"\\n        INNER JOIN old_rows ON old_rows.id = new_rows.id\\n        WHERE new_rows.\\"hiddenFrom\\" IS DISTINCT FROM old_rows.\\"hiddenFrom\\"\\n           OR (new_rows.\\"deletedAt\\" IS NULL) IS DISTINCT FROM (old_rows.\\"deletedAt\\" IS NULL)\\n      ));\\n      RETURN NULL;\\n    END\\n  $$;"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_hidden_from_update', '{"type":"trigger","name":"album_hidden_from_update","sql":"CREATE OR REPLACE TRIGGER \\"album_hidden_from_update\\"\\n  AFTER UPDATE ON \\"album\\"\\n  REFERENCING OLD TABLE AS \\"old_rows\\" NEW TABLE AS \\"new_rows\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION album_hidden_from_update();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_asset_hidden_from_delete', '{"type":"trigger","name":"album_asset_hidden_from_delete","sql":"CREATE OR REPLACE TRIGGER \\"album_asset_hidden_from_delete\\"\\n  AFTER DELETE ON \\"album_asset\\"\\n  REFERENCING OLD TABLE AS \\"deleted_rows\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION album_asset_hidden_from_delete();"}'::jsonb);`.execute(db);
  await sql`INSERT INTO "migration_overrides" ("name", "value") VALUES ('trigger_album_asset_hidden_from_insert', '{"type":"trigger","name":"album_asset_hidden_from_insert","sql":"CREATE OR REPLACE TRIGGER \\"album_asset_hidden_from_insert\\"\\n  AFTER INSERT ON \\"album_asset\\"\\n  REFERENCING NEW TABLE AS \\"inserted_rows\\"\\n  FOR EACH STATEMENT\\n  EXECUTE FUNCTION album_asset_hidden_from_insert();"}'::jsonb);`.execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP FUNCTION asset_sync_hidden_from_inherited;`.execute(db);
  await sql`DROP TRIGGER "album_asset_hidden_from_insert" ON "album_asset";`.execute(db);
  await sql`DROP FUNCTION album_asset_hidden_from_insert;`.execute(db);
  await sql`DROP TRIGGER "album_asset_hidden_from_delete" ON "album_asset";`.execute(db);
  await sql`DROP FUNCTION album_asset_hidden_from_delete;`.execute(db);
  await sql`DROP TRIGGER "album_hidden_from_update" ON "album";`.execute(db);
  await sql`DROP FUNCTION album_hidden_from_update;`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "hiddenFromInherited";`.execute(db);
  await sql`ALTER TABLE "asset" DROP COLUMN "hiddenFromShown";`.execute(db);
  await sql`ALTER TABLE "album" DROP COLUMN "hiddenFrom";`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_asset_sync_hidden_from_inherited';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_album_asset_hidden_from_insert';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_album_asset_hidden_from_delete';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'function_album_hidden_from_update';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_hidden_from_update';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_asset_hidden_from_delete';`.execute(db);
  await sql`DELETE FROM "migration_overrides" WHERE "name" = 'trigger_album_asset_hidden_from_insert';`.execute(db);
}
