import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/data/db/main/table/user/user.dart';
import 'package:immich_mobile/data/db/util/asset_mixin.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/utils/visibility_policy.dart';

@TableIndex.sql('''
CREATE UNIQUE INDEX IF NOT EXISTS UQ_remote_assets_owner_checksum
ON remote_asset_entity (owner_id, checksum)
WHERE (library_id IS NULL);
''')
@TableIndex.sql('''
CREATE UNIQUE INDEX IF NOT EXISTS UQ_remote_assets_owner_library_checksum
ON remote_asset_entity (owner_id, library_id, checksum)
WHERE (library_id IS NOT NULL);
''')
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_remote_asset_checksum ON remote_asset_entity (checksum)')
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_remote_asset_stack_id ON remote_asset_entity (stack_id)')
@TableIndex.sql('''
CREATE INDEX IF NOT EXISTS idx_remote_asset_owner_visibility_deleted_created
ON remote_asset_entity (owner_id, visibility, deleted_at, created_at DESC)
''')
@TableIndex.sql('CREATE INDEX IF NOT EXISTS idx_remote_asset_uploaded ON remote_asset_entity (uploaded_at)')
class RemoteAssetEntity extends Table with DriftDefaultsMixin, AssetEntityMixin {
  const RemoteAssetEntity();

  TextColumn get id => text()();

  TextColumn get checksum => text()();

  BoolColumn get isFavorite => boolean().withDefault(const Constant(false))();

  TextColumn get ownerId => text().references(UserEntity, #id, onDelete: KeyAction.cascade)();

  DateTimeColumn get localDateTime => dateTime().nullable()();

  TextColumn get thumbHash => text().nullable()();

  DateTimeColumn get deletedAt => dateTime().nullable()();

  DateTimeColumn get uploadedAt => dateTime().nullable()();

  TextColumn get livePhotoVideoId => text().nullable()();

  IntColumn get visibility => intEnum<AssetVisibility>()();

  /// Per-asset, per-surface exclusions, as a bitmask over `VisibilityPolicy.surfaceBit`.
  ///
  /// Independent of `visibility`: an asset withheld from a surface is otherwise a normal asset. `null`
  /// means "withheld from nothing", which is what every row written before this column existed holds, so
  /// the queries that read it are no-ops until something sets it.
  IntColumn get hiddenFrom => integer().nullable()();

  /// What this asset's albums withhold it from, as the same kind of bitmask.
  ///
  /// Mirrors the server's derived column rather than being computed here. The server recomputes and
  /// rewrites it on every membership or rule change, so the row is synced anyway, and one authority for
  /// the arithmetic beats two that can disagree between syncs.
  IntColumn get hiddenFromInherited => integer().nullable()();

  /// Surfaces this asset is explicitly shown on despite an album rule.
  ///
  /// Cancels [hiddenFromInherited] only, never [hiddenFrom] - see `VisibilityPolicy.notHiddenFrom`.
  IntColumn get hiddenFromShown => integer().nullable()();

  TextColumn get stackId => text().nullable()();

  TextColumn get libraryId => text().nullable()();

  BoolColumn get isEdited => boolean().withDefault(const Constant(false))();

  @override
  Set<Column> get primaryKey => {id};
}

extension RemoteAssetEntityDataDomainEx on RemoteAssetEntityData {
  RemoteAsset toDto({String? localId}) => RemoteAsset(
    id: id,
    name: name,
    ownerId: ownerId,
    checksum: checksum,
    type: type,
    createdAt: createdAt,
    updatedAt: updatedAt,
    uploadedAt: uploadedAt,
    durationMs: durationMs,
    isFavorite: isFavorite,
    height: height,
    width: width,
    thumbHash: thumbHash,
    visibility: visibility,
    // The stored bitmask is a local encoding; the domain layer only ever sees surface names.
    hiddenFrom: VisibilityPolicy.namesFor(hiddenFrom).toSet(),
    livePhotoVideoId: livePhotoVideoId,
    localId: localId,
    stackId: stackId,
    isEdited: isEdited,
    deletedAt: deletedAt,
  );
}
