import 'package:drift/drift.dart' as drift;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/album/local_album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart' as domain;
import 'package:immich_mobile/infrastructure/entities/local_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/remote_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/repositories/sync_stream.repository.dart';
import 'package:immich_mobile/infrastructure/utils/visibility_policy.dart';
import 'package:openapi/api.dart';

SyncUserV1 _createUser({String id = 'user-1'}) {
  return SyncUserV1(
    id: id,
    name: 'Test User',
    email: 'test@test.com',
    deletedAt: null,
    avatarColor: const Optional.absent(),
    hasProfileImage: false,
    profileChangedAt: DateTime(2024, 1, 1),
  );
}

SyncAssetV1 _createAsset({
  required String id,
  required String checksum,
  required String fileName,
  String ownerId = 'user-1',
  int? width,
  int? height,
}) {
  return SyncAssetV1(
    id: id,
    checksum: checksum,
    originalFileName: fileName,
    type: AssetTypeEnum.IMAGE,
    ownerId: ownerId,
    isFavorite: false,
    fileCreatedAt: DateTime(2024, 1, 1),
    fileModifiedAt: DateTime(2024, 1, 1),
    createdAt: DateTime(2024, 1, 1),
    localDateTime: DateTime(2024, 1, 1),
    visibility: AssetVisibility.timeline,
    width: width,
    height: height,
    deletedAt: null,
    duration: null,
    libraryId: null,
    livePhotoVideoId: null,
    stackId: null,
    thumbhash: null,
    isEdited: false,
  );
}

SyncAssetV2 _createAssetV2({required String id, List<AssetSurface> hiddenFrom = const [], String ownerId = 'user-1'}) {
  return SyncAssetV2(
    id: id,
    checksum: 'checksum-$id',
    originalFileName: '$id.jpg',
    type: AssetTypeEnum.IMAGE,
    ownerId: ownerId,
    isFavorite: false,
    fileCreatedAt: DateTime(2024, 1, 1),
    fileModifiedAt: DateTime(2024, 1, 1),
    createdAt: DateTime(2024, 1, 1),
    localDateTime: DateTime(2024, 1, 1),
    visibility: AssetVisibility.timeline,
    hiddenFrom: hiddenFrom,
    width: 100,
    height: 100,
    deletedAt: null,
    duration: null,
    libraryId: null,
    livePhotoVideoId: null,
    stackId: null,
    thumbhash: null,
    isEdited: false,
  );
}

SyncAssetExifV1 _createExif({
  required String assetId,
  required int width,
  required int height,
  required String orientation,
}) {
  return SyncAssetExifV1(
    assetId: assetId,
    exifImageWidth: width,
    exifImageHeight: height,
    orientation: orientation,
    city: null,
    country: null,
    dateTimeOriginal: null,
    description: null,
    exposureTime: null,
    fNumber: null,
    fileSizeInByte: null,
    focalLength: null,
    fps: null,
    iso: null,
    latitude: null,
    lensModel: null,
    longitude: null,
    make: null,
    model: null,
    modifyDate: null,
    profileDescription: null,
    projectionType: null,
    rating: null,
    state: null,
    timeZone: null,
  );
}

SyncAlbumV2 _createAlbumV2({required String id, bool isLocked = false}) {
  return SyncAlbumV2(
    id: id,
    name: 'album_$id',
    description: '',
    isActivityEnabled: true,
    isLocked: isLocked,
    order: AssetOrder.desc,
    thumbnailAssetId: null,
    createdAt: DateTime(2024, 1, 1),
    updatedAt: DateTime(2024, 1, 1),
  );
}

void main() {
  late Drift db;
  late SyncStreamRepository sut;

  setUp(() async {
    db = Drift(drift.DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    sut = SyncStreamRepository(db);
  });

  tearDown(() async {
    await db.close();
  });

  group('SyncStreamRepository - Dimension swapping based on orientation', () {
    test('swaps dimensions for asset with rotated orientation', () async {
      final flippedOrientations = ['5', '6', '7', '8', '90', '-90'];

      for (final orientation in flippedOrientations) {
        final assetId = 'asset-$orientation-degrees';

        await sut.updateUsersV1([_createUser()]);

        final asset = _createAsset(
          id: assetId,
          checksum: 'checksum-$orientation',
          fileName: 'rotated_$orientation.jpg',
        );
        await sut.updateAssetsV1([asset]);

        final exif = _createExif(
          assetId: assetId,
          width: 1920,
          height: 1080,
          orientation: orientation, // EXIF orientation value for 90 degrees CW
        );
        await sut.updateAssetsExifV1([exif]);

        final query = db.remoteAssetEntity.select()..where((tbl) => tbl.id.equals(assetId));
        final result = await query.getSingle();

        expect(result.width, equals(1080));
        expect(result.height, equals(1920));
      }
    });

    test('does not swap dimensions for asset with normal orientation', () async {
      final nonFlippedOrientations = ['1', '2', '3', '4'];
      for (final orientation in nonFlippedOrientations) {
        final assetId = 'asset-$orientation-degrees';

        await sut.updateUsersV1([_createUser()]);

        final asset = _createAsset(id: assetId, checksum: 'checksum-$orientation', fileName: 'normal_$orientation.jpg');
        await sut.updateAssetsV1([asset]);

        final exif = _createExif(
          assetId: assetId,
          width: 1920,
          height: 1080,
          orientation: orientation, // EXIF orientation value for normal
        );
        await sut.updateAssetsExifV1([exif]);

        final query = db.remoteAssetEntity.select()..where((tbl) => tbl.id.equals(assetId));
        final result = await query.getSingle();

        expect(result.width, equals(1920));
        expect(result.height, equals(1080));
      }
    });

    test('does not update dimensions if asset already has width and height', () async {
      const assetId = 'asset-with-dimensions';
      const existingWidth = 1920;
      const existingHeight = 1080;
      const exifWidth = 3840;
      const exifHeight = 2160;

      await sut.updateUsersV1([_createUser()]);

      final asset = _createAsset(
        id: assetId,
        checksum: 'checksum-with-dims',
        fileName: 'with_dimensions.jpg',
        width: existingWidth,
        height: existingHeight,
      );
      await sut.updateAssetsV1([asset]);

      final exif = _createExif(assetId: assetId, width: exifWidth, height: exifHeight, orientation: '6');
      await sut.updateAssetsExifV1([exif]);

      // Verify the asset still has original dimensions (not updated from EXIF)
      final query = db.remoteAssetEntity.select()..where((tbl) => tbl.id.equals(assetId));
      final result = await query.getSingle();

      expect(result.width, equals(existingWidth), reason: 'Width should remain as originally set');
      expect(result.height, equals(existingHeight), reason: 'Height should remain as originally set');
    });
  });

  group('SyncStreamRepository - updateAlbumsV2()', () {
    // The server sends `album.isLocked` and leaves enforcement to each client. Dropping it on ingest is
    // what made a locked album arrive looking ordinary, so pin that it lands in the column.
    test('persists isLocked', () async {
      await sut.updateAlbumsV2([_createAlbumV2(id: 'album-open'), _createAlbumV2(id: 'album-locked', isLocked: true)]);

      final rows = await db.remoteAlbumEntity.select().get();

      expect({for (final row in rows) row.id: row.isLocked}, {'album-open': false, 'album-locked': true});
    });

    test('carries isLocked changes through on conflict, in both directions', () async {
      Future<bool> isLocked() async =>
          (await (db.remoteAlbumEntity.select()..where((tbl) => tbl.id.equals('album-1'))).getSingle()).isLocked;

      await sut.updateAlbumsV2([_createAlbumV2(id: 'album-1')]);
      await sut.updateAlbumsV2([_createAlbumV2(id: 'album-1', isLocked: true)]);
      expect(await isLocked(), isTrue, reason: 'locking an existing album must reach the column');

      await sut.updateAlbumsV2([_createAlbumV2(id: 'album-1')]);
      expect(await isLocked(), isFalse, reason: 'unlocking must not leave a stale true behind');
    });
  });

  group('SyncStreamRepository - reset()', () {
    test('nulls linkedRemoteAlbumId on localAlbumEntity so FK refs do not dangle', () async {
      const localAlbumId = 'local-1';
      const remoteAlbumId = 'remote-1';

      await db.remoteAlbumEntity.insertOne(
        RemoteAlbumEntityCompanion.insert(id: remoteAlbumId, name: 'Movies', order: AlbumAssetOrder.desc),
      );
      await db.localAlbumEntity.insertOne(
        LocalAlbumEntityCompanion.insert(
          id: localAlbumId,
          name: 'Movies',
          backupSelection: BackupSelection.selected,
          linkedRemoteAlbumId: const drift.Value(remoteAlbumId),
        ),
      );

      // sanity: link is set before reset
      final before = await (db.localAlbumEntity.select()..where((t) => t.id.equals(localAlbumId))).getSingle();
      expect(before.linkedRemoteAlbumId, equals(remoteAlbumId));

      await sut.reset();

      final after = await (db.localAlbumEntity.select()..where((t) => t.id.equals(localAlbumId))).getSingle();
      expect(
        after.linkedRemoteAlbumId,
        isNull,
        reason:
            'reset() runs with PRAGMA foreign_keys = OFF so the ON DELETE SET NULL cascade does not fire — the link must be nulled manually',
      );
      expect(after.name, equals('Movies'), reason: 'local album row itself must be preserved');
      expect(after.backupSelection, equals(BackupSelection.selected));

      final remoteRows = await db.remoteAlbumEntity.select().get();
      expect(remoteRows, isEmpty, reason: 'reset() still wipes remoteAlbumEntity');
    });

    test('preserves localAlbumEntity rows that have no linkedRemoteAlbumId', () async {
      const localAlbumId = 'local-unlinked';
      await db.localAlbumEntity.insertOne(
        LocalAlbumEntityCompanion.insert(id: localAlbumId, name: 'Camera', backupSelection: BackupSelection.none),
      );

      await sut.reset();

      final after = await (db.localAlbumEntity.select()..where((t) => t.id.equals(localAlbumId))).getSingle();
      expect(after.linkedRemoteAlbumId, isNull);
      expect(after.name, equals('Camera'));
      expect(after.backupSelection, equals(BackupSelection.none));
    });
  });

  group('SyncStreamRepository - hiddenFrom', () {
    // Sync carries surface *names* (the unprefixed AssetSurface here is the wire enum from the generated
    // client); the column holds mobile's own mask, whose literal values visibility_policy_test.dart pins.
    // These tests assert the translation between the two, in both directions.
    Future<int?> storedMask(String id) async {
      final row = await (db.remoteAssetEntity.select()..where((tbl) => tbl.id.equals(id))).getSingle();
      return row.hiddenFrom;
    }

    setUp(() async {
      await sut.updateUsersV1([_createUser()]);
    });

    test('round-trips a surface name array into the mask', () async {
      await sut.updateAssetsV2([
        _createAssetV2(id: 'asset-hidden', hiddenFrom: const [AssetSurface.search, AssetSurface.memories]),
      ]);

      const expected = [domain.AssetSurface.search, domain.AssetSurface.memories];
      final mask = await storedMask('asset-hidden');
      expect(mask, VisibilityPolicy.maskFor(expected));
      expect(VisibilityPolicy.namesFor(mask), unorderedEquals(expected));
    });

    test('maps every wire surface to the local surface of the same name', () async {
      // Guards the one place the two vocabularies meet. A surface added on the server and mistranslated
      // here would mean an asset the user hid staying visible, so the mapping is checked exhaustively.
      for (final wire in AssetSurface.values) {
        final id = 'asset-$wire';
        await sut.updateAssetsV2([
          _createAssetV2(id: id, hiddenFrom: [wire]),
        ]);

        expect(VisibilityPolicy.namesFor(await storedMask(id)), [
          domain.AssetSurface.values.firstWhere((local) => local.name == wire.name),
        ], reason: 'wire surface $wire');
      }
    });

    test('stores null for an empty array, matching every pre-existing row', () async {
      await sut.updateAssetsV2([_createAssetV2(id: 'asset-plain')]);

      expect(await storedMask('asset-plain'), isNull);
    });

    test('clears the mask when the server stops withholding the asset', () async {
      await sut.updateAssetsV2([
        _createAssetV2(id: 'asset-toggle', hiddenFrom: const [AssetSurface.timeline]),
      ]);
      expect(await storedMask('asset-toggle'), isNotNull);

      await sut.updateAssetsV2([_createAssetV2(id: 'asset-toggle')]);
      expect(await storedMask('asset-toggle'), isNull);
    });
  });
}
