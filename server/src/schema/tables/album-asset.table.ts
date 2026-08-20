import {
  AfterDeleteTrigger,
  AfterInsertTrigger,
  CreateDateColumn,
  ForeignKeyColumn,
  Generated,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import {
  album_asset_delete_audit,
  album_asset_hidden_from_delete,
  album_asset_hidden_from_insert,
} from 'src/schema/functions';
import { AlbumTable } from 'src/schema/tables/album.table';
import { AssetTable } from 'src/schema/tables/asset.table';

@Table({ name: 'album_asset' })
@UpdatedAtTrigger('album_asset_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: album_asset_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() <= 1',
})
// Album membership is what an asset inherits its album-level exclusions from, so both directions have to
// resync it. No `pg_trigger_depth` guard, unlike the audit trigger above: a cascade from deleting an
// album is exactly the case that must still recompute, and the recompute is idempotent so re-entry is
// harmless.
@AfterInsertTrigger({
  scope: 'statement',
  function: album_asset_hidden_from_insert,
  referencingNewTableAs: 'inserted_rows',
})
@AfterDeleteTrigger({
  scope: 'statement',
  function: album_asset_hidden_from_delete,
  referencingOldTableAs: 'deleted_rows',
})
export class AlbumAssetTable {
  @ForeignKeyColumn(() => AlbumTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  albumId!: string;

  @ForeignKeyColumn(() => AssetTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false, primary: true })
  assetId!: string;

  @CreateDateColumn()
  createdAt!: Generated<Timestamp>;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;
}
