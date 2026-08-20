import { registerFunction } from '@immich/sql-tools';

export const immich_uuid_v7 = registerFunction({
  name: 'immich_uuid_v7',
  arguments: ['p_timestamp timestamp with time zone default clock_timestamp()'],
  returnType: 'uuid',
  language: 'SQL',
  behavior: 'volatile',
  body: `
    SELECT encode(
      set_bit(
        set_bit(
          overlay(uuid_send(gen_random_uuid())
                  placing substring(int8send(floor(extract(epoch from p_timestamp) * 1000)::bigint) from 3)
                  from 1 for 6
          ),
          52, 1
        ),
        53, 1
      ),
      'hex')::uuid;
`,
});

export const album_user_after_insert = registerFunction({
  name: 'album_user_after_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE album SET "updatedAt" = clock_timestamp(), "updateId" = immich_uuid_v7(clock_timestamp())
      WHERE "id" IN (SELECT "albumId" FROM inserted_rows)
        AND NOT EXISTS (SELECT FROM inserted_rows WHERE role = 'owner');
      RETURN NULL;
    END`,
});

export const updated_at = registerFunction({
  name: 'updated_at',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    DECLARE
        clock_timestamp TIMESTAMP := clock_timestamp();
    BEGIN
        new."updatedAt" = clock_timestamp;
        new."updateId" = immich_uuid_v7(clock_timestamp);
        return new;
    END;`,
});

export const f_concat_ws = registerFunction({
  name: 'f_concat_ws',
  arguments: ['text', 'text[]'],
  returnType: 'text',
  language: 'SQL',
  parallel: 'safe',
  behavior: 'immutable',
  body: `SELECT array_to_string($2, $1)`,
});

export const f_unaccent = registerFunction({
  name: 'f_unaccent',
  arguments: ['text'],
  returnType: 'text',
  language: 'SQL',
  parallel: 'safe',
  strict: true,
  behavior: 'immutable',
  return: `unaccent('unaccent', $1)`,
});

export const ll_to_earth_public = registerFunction({
  name: 'll_to_earth_public',
  arguments: ['latitude double precision', 'longitude double precision'],
  returnType: 'public.earth',
  language: 'SQL',
  parallel: 'safe',
  strict: true,
  behavior: 'immutable',
  body: `SELECT public.cube(public.cube(public.cube(public.earth()*cos(radians(latitude))*cos(radians(longitude))),public.earth()*cos(radians(latitude))*sin(radians(longitude))),public.earth()*sin(radians(latitude)))::public.earth`,
});

export const user_delete_audit = registerFunction({
  name: 'user_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO user_audit ("userId")
      SELECT "id"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const partner_delete_audit = registerFunction({
  name: 'partner_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO partner_audit ("sharedById", "sharedWithId")
      SELECT "sharedById", "sharedWithId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_delete_audit = registerFunction({
  name: 'asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_audit ("assetId", "ownerId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const album_asset_delete_audit = registerFunction({
  name: 'album_asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO album_asset_audit ("albumId", "assetId")
      SELECT "albumId", "assetId" FROM OLD
      WHERE "albumId" IN (SELECT "id" FROM album WHERE "id" IN (SELECT "albumId" FROM OLD));
      RETURN NULL;
    END`,
});

export const album_user_delete = registerFunction({
  name: 'album_user_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      DELETE FROM "album"
      WHERE "album"."id" = OLD."albumId"
      AND NOT EXISTS (SELECT "albumId" FROM "album_user" WHERE "album_user"."albumId" = "album"."id" AND "album_user"."role" = 'owner');

      RETURN NULL;
    END`,
});

export const album_user_delete_audit = registerFunction({
  name: 'album_user_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO album_audit ("albumId", "userId")
      SELECT "albumId", "userId"
      FROM OLD;

      IF pg_trigger_depth() = 1 THEN
        INSERT INTO album_user_audit ("albumId", "userId")
        SELECT "albumId", "userId"
        FROM OLD;
      END IF;

      RETURN NULL;
    END`,
});

export const memory_delete_audit = registerFunction({
  name: 'memory_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO memory_audit ("memoryId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const memory_asset_delete_audit = registerFunction({
  name: 'memory_asset_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO memory_asset_audit ("memoryId", "assetId")
      SELECT "memoriesId", "assetId" FROM OLD
      WHERE "memoriesId" IN (SELECT "id" FROM memory WHERE "id" IN (SELECT "memoriesId" FROM OLD));
      RETURN NULL;
    END`,
});

export const stack_delete_audit = registerFunction({
  name: 'stack_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO stack_audit ("stackId", "userId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const person_delete_audit = registerFunction({
  name: 'person_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO person_audit ("personId", "ownerId")
      SELECT "id", "ownerId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const user_metadata_audit = registerFunction({
  name: 'user_metadata_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO user_metadata_audit ("userId", "key")
      SELECT "userId", "key"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_metadata_audit = registerFunction({
  name: 'asset_metadata_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_metadata_audit ("assetId", "key")
      SELECT "assetId", "key"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_face_audit = registerFunction({
  name: 'asset_face_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_face_audit ("assetFaceId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_edit_insert = registerFunction({
  name: 'asset_edit_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE asset
      SET "isEdited" = true
      FROM inserted_edit
      WHERE asset.id = inserted_edit."assetId" AND NOT asset."isEdited";
      RETURN NULL;
    END
  `,
});

export const asset_edit_delete = registerFunction({
  name: 'asset_edit_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      UPDATE asset
      SET "isEdited" = false
      FROM deleted_edit
      WHERE asset.id = deleted_edit."assetId" AND asset."isEdited"
        AND NOT EXISTS (SELECT FROM asset_edit edit WHERE edit."assetId" = asset.id);
      RETURN NULL;
    END
  `,
});

export const asset_edit_audit = registerFunction({
  name: 'asset_edit_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_edit_audit ("editId", "assetId")
      SELECT "id", "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

export const asset_ocr_delete_audit = registerFunction({
  name: 'asset_ocr_delete_audit',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      INSERT INTO asset_ocr_audit ("assetId")
      SELECT "assetId"
      FROM OLD;
      RETURN NULL;
    END`,
});

/**
 * Recomputes `asset.hiddenFromInherited` for the given assets: the OR of `hiddenFrom` across every album
 * each asset currently belongs to.
 *
 * Recompute rather than adjust, always. There is no provenance on the asset saying which bit came from
 * which album, so an incremental update could never undo one - which is exactly what has to work when a
 * photo leaves a hidden album. Deriving from current membership sidesteps the question.
 *
 * `IS DISTINCT FROM` is load-bearing, not an optimisation. `asset` carries an `updatedAt`/`updateId`
 * trigger, so writing an unchanged value would still bump `updateId` and push a sync change for that
 * asset to every client. Adding one photo to an album must not look like every other photo in it changed.
 *
 * `nullif(..., 0)` keeps "inherits nothing" spelled exactly one way. A stored 0 would read as "has
 * inherited exclusions" to anything testing for null, the same trap `updateAllHiddenFrom` avoids.
 */
export const asset_sync_hidden_from_inherited = registerFunction({
  name: 'asset_sync_hidden_from_inherited',
  arguments: ['p_asset_ids uuid[]'],
  returnType: 'void',
  // PLPGSQL rather than SQL, and not by preference. The migration generator emits every CREATE FUNCTION
  // before the ALTER TABLE ADD COLUMN statements, and Postgres parse-analyses a SQL-language body at
  // creation time - so a SQL version of this fails on a fresh database with `column album.hiddenFrom does
  // not exist`, while working fine on any database that already had the columns. PLPGSQL defers that
  // check to first execution, which makes the generated order irrelevant.
  language: 'PLPGSQL',
  behavior: 'volatile',
  body: `
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
    END`,
});

/**
 * The three events that can change what an asset inherits, as statement-level triggers.
 *
 * Deliberately in the database rather than the service layer. Nine repository methods mutate
 * `album_asset` today and upstream adds more; a derived column maintained by call sites is a column that
 * is eventually wrong, and the failure is silent - a photo stays hidden after leaving the album, or never
 * becomes hidden on joining. Here it cannot be forgotten, including by upstream code we do not touch.
 *
 * Statement-level with transition tables, so a 30,000-row album insert costs one recompute rather than
 * 30,000.
 */
export const album_asset_hidden_from_insert = registerFunction({
  name: 'album_asset_hidden_from_insert',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT "assetId" FROM inserted_rows));
      RETURN NULL;
    END`,
});

export const album_asset_hidden_from_delete = registerFunction({
  name: 'album_asset_hidden_from_delete',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
    BEGIN
      PERFORM asset_sync_hidden_from_inherited(ARRAY(SELECT DISTINCT "assetId" FROM deleted_rows));
      RETURN NULL;
    END`,
});

/**
 * An album's rule changing, or the album being soft-deleted or restored, changes what all of its members
 * inherit. Soft delete counts because the recompute above only counts albums with `deletedAt IS NULL`.
 */
export const album_hidden_from_update = registerFunction({
  name: 'album_hidden_from_update',
  returnType: 'TRIGGER',
  language: 'PLPGSQL',
  body: `
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
    END`,
});
