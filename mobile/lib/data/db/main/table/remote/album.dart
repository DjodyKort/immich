import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.dart';
import 'package:immich_mobile/data/db/util/defaults_mixin.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';

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

  /// Mirrors `album.hiddenFrom`: the surfaces this album's **photos** are withheld from, as a bitmask
  /// over `VisibilityPolicy.surfaceBit`.
  ///
  /// A third, independent thing from [isLocked] and [isHidden], and the only one that acts on the
  /// contents: [isHidden] keeps the album out of the album list and touches no photo, while this leaves
  /// the album where it is and takes its photos off the surfaces named. Stored here so the album's own
  /// settings screen can render its switches; the per-asset effect arrives separately, already computed,
  /// in `remote_asset_entity.hidden_from_inherited`.
  IntColumn get hiddenFrom => integer().nullable()();

  /// Mirrors `album.parentId`: the album this one sits inside, or null at the top level.
  ///
  /// Deliberately *not* a foreign key onto this table. Sync delivers rows in no particular order, so a
  /// child can arrive before its parent, and a reference would reject it. The tree is built in memory
  /// from the rows present, which also gives the behaviour the list needs anyway: a child whose parent
  /// is missing -- not yet synced, trashed, or withheld from an unelevated session -- is shown at the
  /// top level rather than disappearing with it.
  TextColumn get parentId => text().nullable()();

  IntColumn get order => intEnum<AlbumAssetOrder>()();

  @override
  Set<Column> get primaryKey => {id};
}
