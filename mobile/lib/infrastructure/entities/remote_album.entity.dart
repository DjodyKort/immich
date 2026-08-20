import 'package:drift/drift.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/infrastructure/entities/remote_asset.entity.dart';
import 'package:immich_mobile/infrastructure/utils/drift_default.mixin.dart';

class RemoteAlbumEntity extends Table with DriftDefaultsMixin {
  const RemoteAlbumEntity();

  TextColumn get id => text()();

  TextColumn get name => text()();

  TextColumn get description => text().withDefault(const Constant(''))();

  DateTimeColumn get createdAt => dateTime().withDefault(currentDateAndTime)();

  DateTimeColumn get updatedAt => dateTime().withDefault(currentDateAndTime)();

  TextColumn get thumbnailAssetId =>
      text().references(RemoteAssetEntity, #id, onDelete: KeyAction.setNull).nullable()();

  BoolColumn get isActivityEnabled => boolean().withDefault(const Constant(true))();

  /// Mirrors `album.isLocked` from sync. A locked album lives behind the locked folder: the server
  /// sends the flag and leaves enforcement to each client, so without this column the field is
  /// dropped on ingest and a locked album arrives looking ordinary.
  BoolColumn get isLocked => boolean().withDefault(const Constant(false))();

  /// Mirrors `album.isHidden` from sync. A hidden album is kept out of the album list for tidiness,
  /// not confidentiality — separate from locking, which is about confidentiality. It stays fully
  /// reachable by its own route, from an asset's album list, and from the hidden albums section, so
  /// hiding can never lose an album.
  BoolColumn get isHidden => boolean().withDefault(const Constant(false))();

  IntColumn get order => intEnum<AlbumAssetOrder>()();

  @override
  Set<Column> get primaryKey => {id};
}
