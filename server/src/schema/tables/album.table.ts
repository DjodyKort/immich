import {
  AfterUpdateTrigger,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Generated,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AssetOrder } from 'src/enum';
import { album_hidden_from_update } from 'src/schema/functions';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table({ name: 'album' })
@UpdatedAtTrigger('album_updatedAt')
// Changing the album's rule - or soft-deleting/restoring the album, since a deleted album stops
// contributing - changes what every member inherits. The trigger function filters to rows where one of
// those actually changed, so an ordinary rename costs nothing.
@AfterUpdateTrigger({
  scope: 'statement',
  function: album_hidden_from_update,
  referencingOldTableAs: 'old_rows',
  referencingNewTableAs: 'new_rows',
})
export class AlbumTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @Column({ default: 'Untitled Album' })
  albumName!: Generated<string>;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @ForeignKeyColumn(() => AssetTable, {
    nullable: true,
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    comment: 'Asset ID to be used as thumbnail',
  })
  albumThumbnailAssetId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'boolean', default: true })
  isActivityEnabled!: Generated<boolean>;

  @Column({ type: 'boolean', default: false })
  isLocked!: Generated<boolean>;

  /**
   * Kept out of the album list, without being locked.
   *
   * Separate from `isLocked` on purpose: locking is about confidentiality and costs a PIN to undo,
   * while this is only about tidiness. A hidden album stays reachable by its own URL, from an asset's
   * "in albums" list, and through the hidden-albums listing, so hiding one is never a way to lose it.
   */
  @Column({ type: 'boolean', default: false })
  isHidden!: Generated<boolean>;

  /**
   * Surfaces the album's **photos** are withheld from, as a bitmask of `Surface` bits.
   *
   * A third, independent thing from `isLocked` and `isHidden`, and the one that acts on the contents
   * rather than the album: `isHidden` keeps the album out of the album list and touches no photo, while
   * this leaves the album exactly where it is and takes its photos off the surfaces named here.
   *
   * Members inherit it through `asset.hiddenFromInherited`. Rules from several albums compose by union,
   * and a photo can opt back out through `asset.hiddenFromShown`.
   */
  @Column({ type: 'integer', nullable: true })
  hiddenFrom!: number | null;

  @Column({ default: AssetOrder.Desc })
  order!: Generated<AssetOrder>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
