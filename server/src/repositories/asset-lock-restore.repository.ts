import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';
import { anyUuid } from 'src/utils/database';

export type AssetLockRestorePoint = {
  assetId: string;
  priorVisibility: AssetVisibility;
  /** Albums that still exist and can be rejoined. */
  priorAlbumIds: string[];
  /** How many albums were recorded, including ones since deleted. */
  priorAlbumCount: number;
};

/**
 * The albums the outer `asset` row currently belongs to.
 *
 * Correlated on `asset.id`, so it only makes sense inside a query that selects from `asset`.
 * `array(...)` already yields '{}' when the asset is in no album, so there is nothing to coalesce.
 */
const currentAlbumIds = sql<string[]>`array(
  select "album_asset"."albumId" from "album_asset" where "album_asset"."assetId" = "asset"."id"
)`;

/**
 * The recorded albums an asset can actually be returned to.
 *
 * Deleted and trashed albums are gone, and a membership that cannot come back is not a failure. An
 * album that became *locked* is excluded for a stronger reason: a locked album may only contain locked
 * assets, so returning a now-unlocked asset to one would break the invariant the eviction protects.
 */
const restorableAlbumIds = sql<string[]>`array(
  select "album"."id" from "album"
  where "album"."id" = any("asset_lock_restore"."priorAlbumIds")
    and "album"."deletedAt" is null
    and "album"."isLocked" = false
)`;

/**
 * The restore points that make unlocking the inverse of locking.
 *
 * See `asset-lock-restore.table.ts` for why this exists at all. Every method here is written so that
 * losing a restore point degrades the unlock rather than failing it: an asset with no row still
 * unlocks, it just returns to the timeline the way it always did.
 */
@Injectable()
export class AssetLockRestoreRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /**
   * Record what locking [assetIds] is about to overwrite.
   *
   * Must run *before* the visibility update and the album eviction, since it reads both from the live
   * rows. Written as one INSERT ... SELECT rather than a read followed by a write so the snapshot
   * cannot interleave with another request's change.
   *
   * `ON CONFLICT DO NOTHING` is the load-bearing part: an already-locked asset moving between locked
   * albums is locked again, and overwriting its row would record `locked` as the value to restore,
   * quietly turning the restore point into a no-op. The first lock is the one worth remembering.
   *
   * Assets that are already Locked are skipped for the same reason -- their row, if any, already says
   * the right thing, and `locked` is never a useful value to keep here.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async snapshot(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('asset_lock_restore')
      .columns(['assetId', 'priorVisibility', 'priorAlbumIds'])
      .expression((eb) =>
        eb
          .selectFrom('asset')
          .select(['asset.id', 'asset.visibility', currentAlbumIds.as('priorAlbumIds')])
          .where('asset.id', '=', anyUuid(assetIds))
          .where('asset.visibility', '!=', AssetVisibility.Locked),
      )
      .onConflict((oc) => oc.column('assetId').doNothing())
      .execute();
  }

  /**
   * Read the restore points for [assetIds], dropping album ids whose album is gone.
   *
   * The subquery against `album` is what keeps this table out of the way of album deletion: a restore
   * point may name an album deleted or trashed while the asset sat in the locked folder, and that is a
   * membership which simply cannot come back. Filtering here rather than failing means the visibility
   * half still restores, and `priorAlbumCount` lets the caller say how many were lost.
   *
   * Albums that became *locked* meanwhile are excluded for a different reason: a locked album may only
   * contain locked assets, so returning a now-unlocked asset to one would break the invariant the
   * eviction exists to protect. Losing that membership is the correct outcome, not a failure.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getMany(assetIds: string[]): Promise<AssetLockRestorePoint[]> {
    if (assetIds.length === 0) {
      return [];
    }

    return this.db
      .selectFrom('asset_lock_restore')
      .select([
        'asset_lock_restore.assetId',
        'asset_lock_restore.priorVisibility',
        restorableAlbumIds.as('priorAlbumIds'),
        sql<number>`coalesce(array_length("asset_lock_restore"."priorAlbumIds", 1), 0)`.as('priorAlbumCount'),
      ])
      .where('asset_lock_restore.assetId', '=', anyUuid(assetIds))
      .execute();
  }

  /** Drop the restore points for [assetIds], once they have been applied. */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async deleteMany(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db.deleteFrom('asset_lock_restore').where('assetId', '=', anyUuid(assetIds)).execute();
  }
}
