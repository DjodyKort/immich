import { Column, CreateDateColumn, ForeignKeyColumn, Generated, Table, Timestamp } from '@immich/sql-tools';
import { AssetVisibility } from 'src/enum';
import { asset_visibility_enum } from 'src/schema/enums';
import { AssetTable } from 'src/schema/tables/asset.table';

/**
 * What locking an asset overwrote, so unlocking can put it back.
 *
 * Locking is destructive in two ways that nothing recorded until this table existed. It assigns
 * `asset.visibility = 'locked'`, and `visibility` is one exclusive column, so an asset that was
 * *archived* lost that fact; unlocking returned it to the timeline instead. And it evicts the asset
 * from every album it belonged to, because `checkAlbumAccess` grants asset reads through album
 * membership and a locked asset reachable that way is the locked folder leaking. Neither the previous
 * visibility nor the memberships were kept anywhere, so "unlock" was never the inverse of "lock".
 *
 * Its own table rather than columns on `asset` for two reasons. It is read only while unlocking, so it
 * has no business on the row every timeline query fetches. And `asset.table.ts` is the file upstream
 * changes most, so every column added there is a merge conflict on every sync, forever.
 *
 * Rows live exactly as long as the lock: written when an asset is locked, deleted when it is unlocked.
 * That is deliberately *not* how `album_asset_audit` works -- that table would have answered the
 * membership half, but it is pruned at `MAX_DAYS + 1` days and exists to feed sync tombstones, so
 * restoring from it would silently stop working after a month and would couple this to a retention
 * knob upstream owns.
 */
@Table({ name: 'asset_lock_restore' })
export class AssetLockRestoreTable {
  @ForeignKeyColumn(() => AssetTable, {
    primary: true,
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    comment: 'The locked asset this restore point belongs to',
  })
  assetId!: string;

  /**
   * The value `visibility` held before locking.
   *
   * Written with `ON CONFLICT DO NOTHING` so it always describes the state before the *first* lock.
   * Moving an already-locked asset between locked albums locks it again, and overwriting here would
   * record `locked` as the thing to restore -- turning the restore point into a no-op.
   */
  @Column({ enum: asset_visibility_enum })
  priorVisibility!: AssetVisibility;

  /**
   * Albums the asset was evicted from, so unlocking can return it to them.
   *
   * A plain array rather than a child table: it is only ever read whole, for one asset at a time. Ids
   * of albums deleted while the asset was locked are dropped by the join in the restore query rather
   * than by a foreign key, which keeps this table out of the way of album deletion.
   */
  @Column({ type: 'uuid', array: true })
  priorAlbumIds!: string[];

  @CreateDateColumn()
  lockedAt!: Generated<Timestamp>;
}
