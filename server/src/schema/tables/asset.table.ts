import {
  AfterDeleteTrigger,
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  ForeignKeyColumn,
  Generated,
  Index,
  PrimaryGeneratedColumn,
  Table,
  Timestamp,
  UpdateDateColumn,
} from '@immich/sql-tools';
import { UpdatedAtTrigger, UpdateIdColumn } from 'src/decorators';
import { AssetStatus, AssetType, AssetVisibility, ChecksumAlgorithm } from 'src/enum';
import { asset_checksum_algorithm_enum, asset_visibility_enum, assets_status_enum } from 'src/schema/enums';
import { asset_delete_audit } from 'src/schema/functions';
import { LibraryTable } from 'src/schema/tables/library.table';
import { StackTable } from 'src/schema/tables/stack.table';
import { UserTable } from 'src/schema/tables/user.table';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database';

@Table('asset')
@UpdatedAtTrigger('asset_updatedAt')
@AfterDeleteTrigger({
  scope: 'statement',
  function: asset_delete_audit,
  referencingOldTableAs: 'old',
  when: 'pg_trigger_depth() = 0',
})
// Checksums must be unique per user and library
@Index({
  name: ASSET_CHECKSUM_CONSTRAINT,
  columns: ['ownerId', 'checksum'],
  unique: true,
  where: '"libraryId" IS NULL',
})
@Index({
  columns: ['ownerId', 'libraryId', 'checksum'],
  unique: true,
  where: '"libraryId" IS NOT NULL',
})
@Index({
  name: 'asset_localDateTime_idx',
  expression: `("localDateTime" at time zone 'UTC')::date`,
})
@Index({
  name: 'asset_localDateTime_month_idx',
  expression: `date_trunc('MONTH'::text, ("localDateTime" AT TIME ZONE 'UTC'::text)) AT TIME ZONE 'UTC'::text`,
})
@Index({ columns: ['originalPath', 'libraryId'] })
@Index({ columns: ['id', 'stackId'] })
@Index({
  name: 'asset_originalFilename_trigram_idx',
  using: 'gin',
  expression: 'f_unaccent("originalFileName") gin_trgm_ops',
})
@Index({
  name: 'asset_id_timeline_notDeleted_idx',
  columns: ['id'],
  where: `visibility = 'timeline' AND "deletedAt" IS NULL`,
})
// For all assets, each originalpath must be unique per user and library
export class AssetTable {
  @PrimaryGeneratedColumn()
  id!: Generated<string>;

  @ForeignKeyColumn(() => UserTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: false })
  ownerId!: string;

  @Column()
  type!: AssetType;

  @Column()
  originalPath!: string;

  @Column({ type: 'timestamp with time zone', index: true })
  fileCreatedAt!: Timestamp;

  @Column({ type: 'timestamp with time zone' })
  fileModifiedAt!: Timestamp;

  @Column({ type: 'boolean', default: false })
  isFavorite!: Generated<boolean>;

  @Column({ type: 'integer', nullable: true })
  duration!: number | null;

  @Column({ type: 'bytea', index: true })
  checksum!: Buffer; // sha1 checksum

  @Column({ enum: asset_checksum_algorithm_enum })
  checksumAlgorithm!: ChecksumAlgorithm;

  @ForeignKeyColumn(() => AssetTable, { nullable: true, onUpdate: 'CASCADE', onDelete: 'SET NULL' })
  livePhotoVideoId!: string | null;

  @UpdateDateColumn()
  updatedAt!: Generated<Timestamp>;

  @CreateDateColumn({ index: true })
  createdAt!: Generated<Timestamp>;

  @Column({ index: true })
  originalFileName!: string;

  @Column({ type: 'bytea', nullable: true })
  thumbhash!: Buffer | null;

  @Column({ type: 'boolean', default: false })
  isOffline!: Generated<boolean>;

  @ForeignKeyColumn(() => LibraryTable, { onDelete: 'CASCADE', onUpdate: 'CASCADE', nullable: true })
  libraryId!: string | null;

  @Column({ type: 'boolean', default: false })
  isExternal!: Generated<boolean>;

  @DeleteDateColumn()
  deletedAt!: Timestamp | null;

  @Column({ type: 'timestamp with time zone' })
  localDateTime!: Timestamp;

  @ForeignKeyColumn(() => StackTable, { nullable: true, onDelete: 'SET NULL', onUpdate: 'CASCADE' })
  stackId!: string | null;

  @Column({ type: 'uuid', nullable: true, index: true })
  duplicateId!: string | null;

  @Column({ enum: assets_status_enum, default: AssetStatus.Active })
  status!: Generated<AssetStatus>;

  @UpdateIdColumn({ index: true })
  updateId!: Generated<string>;

  @Column({ enum: asset_visibility_enum, default: AssetVisibility.Timeline })
  visibility!: Generated<AssetVisibility>;

  /**
   * Per-asset, per-surface exclusions, as a bitmask of `Surface` bits. See
   * `src/utils/visibility-policy.ts`, which is the only code that reads it.
   *
   * Deliberately nullable with no default and deliberately separate from `visibility`. `null` means "no
   * per-asset exclusions", so every row written by upstream code behaves exactly as upstream intends and
   * the enum keeps its meaning. That keeps the ~38 call sites that exclude values implicitly working
   * untouched, and keeps upstream changes merging cleanly.
   */
  @Column({ type: 'integer', nullable: true })
  hiddenFrom!: number | null;

  /**
   * The OR of `hiddenFrom` across every album this asset is currently in. **Derived: never write this
   * by hand.**
   *
   * Recomputed - not adjusted - whenever the asset joins an album, leaves one, or a containing album's
   * rule changes. Recomputing from the current memberships is what makes removal work: there is no
   * provenance to guess, so taking a photo out of a hidden album restores it without having to know
   * which bits came from where.
   */
  @Column({ type: 'integer', nullable: true })
  hiddenFromInherited!: number | null;

  /**
   * Surfaces this asset is explicitly shown on, overriding {@link hiddenFromInherited}.
   *
   * The escape hatch for "this one photo, despite its album": album rules compose by union and can
   * never reveal, so this is the only way back. Kept disjoint from `hiddenFrom` on write, since the two
   * are opposite positions of one control and "explicitly hidden and explicitly shown" has no meaning.
   */
  @Column({ type: 'integer', nullable: true })
  hiddenFromShown!: number | null;

  @Column({ type: 'integer', nullable: true })
  width!: number | null;

  @Column({ type: 'integer', nullable: true })
  height!: number | null;

  @Column({ type: 'boolean', default: false })
  isEdited!: Generated<boolean>;
}
