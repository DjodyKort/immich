import 'package:drift/drift.dart' hide isNull;
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/entities/remote_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/repositories/db.repository.dart';
import 'package:immich_mobile/infrastructure/utils/visibility_policy.dart';

void main() {
  group('hiddenFrom bit assignment', () {
    // These literals are the whole point of the test. The mask is written into
    // remote_asset_entity.hidden_from, so an app update that renumbered a bit would silently
    // reinterpret every row already on the device -- an asset hidden from Search would come back as
    // hidden from the timeline instead. Spelling the numbers out here means that change cannot land
    // quietly. They are also deliberately NOT the server's numbers: sync carries surface names, and
    // VisibilityPolicy.maskFor is the only translation between the two vocabularies.
    test('pins each surface to its literal bit', () {
      expect(VisibilityPolicy.surfaceBit, {
        AssetSurface.timeline: 1,
        AssetSurface.search: 2,
        AssetSurface.map: 4,
        AssetSurface.people: 8,
        AssetSurface.memories: 16,
        AssetSurface.folders: 32,
      });
    });

    test('covers every surface, so no surface silently fails to be hidden', () {
      expect(VisibilityPolicy.surfaceBit.keys, containsAll(AssetSurface.values));
    });

    test('assigns a distinct single bit to each surface', () {
      final bits = VisibilityPolicy.surfaceBit.values.toList();
      expect(bits.toSet(), hasLength(bits.length));
      for (final bit in bits) {
        expect(bit & (bit - 1), 0, reason: '$bit is not a single bit');
      }
    });
  });

  group('maskFor', () {
    test('is null for an empty set, so "hidden from nothing" has one spelling', () {
      expect(VisibilityPolicy.maskFor(const []), isNull);
    });

    test('ors the bits of the surfaces given', () {
      expect(VisibilityPolicy.maskFor([AssetSurface.timeline, AssetSurface.memories]), 1 | 16);
    });

    test('is idempotent for a repeated surface', () {
      expect(
        VisibilityPolicy.maskFor([AssetSurface.people, AssetSurface.people]),
        VisibilityPolicy.maskFor([AssetSurface.people]),
      );
    });
  });

  group('namesFor', () {
    test('is the inverse of maskFor', () {
      for (final surfaces in [
        [AssetSurface.timeline],
        [AssetSurface.search],
        [AssetSurface.map],
        [AssetSurface.people],
        [AssetSurface.memories],
        [AssetSurface.folders],
        [AssetSurface.timeline, AssetSurface.people],
        AssetSurface.values,
      ]) {
        expect(VisibilityPolicy.namesFor(VisibilityPolicy.maskFor(surfaces)), unorderedEquals(surfaces));
      }
    });

    test('reports nothing for null or zero', () {
      expect(VisibilityPolicy.namesFor(null), isEmpty);
      expect(VisibilityPolicy.namesFor(0), isEmpty);
    });

    test('ignores a bit it does not know, rather than throwing', () {
      // A newer build of the app writes a bit, the user downgrades. Reading must still work.
      expect(VisibilityPolicy.namesFor(1 | 1 << 20), [AssetSurface.timeline]);
    });
  });

  group('albumListing', () {
    late Drift db;

    setUp(() {
      db = Drift(DatabaseConnection(NativeDatabase.memory(), closeStreamsSynchronously: true));
    });

    tearDown(() async {
      await db.close();
    });

    Future<void> insertAlbum(String id, {bool isHidden = false, bool isLocked = false}) {
      return db
          .into(db.remoteAlbumEntity)
          .insert(
            RemoteAlbumEntityCompanion.insert(
              id: id,
              name: 'album_$id',
              order: AlbumAssetOrder.asc,
              isHidden: Value(isHidden),
              isLocked: Value(isLocked),
            ),
          );
    }

    Future<Set<String>> idsMatching({required bool isElevated, bool hidden = false}) async {
      final rows = await (db.remoteAlbumEntity.select()
            ..where((album) => VisibilityPolicy.albumListing(album, isElevated: isElevated, hidden: hidden)))
          .get();
      return rows.map((row) => row.id).toSet();
    }

    // Mirrors the server's two-state `hidden` option in `album.repository.ts`: hidden albums are
    // either the whole point of the request or excluded from it, never mixed in.
    test('default listing (hidden: false) excludes hidden albums', () async {
      await insertAlbum('shown');
      await insertAlbum('hidden', isHidden: true);

      expect(await idsMatching(isElevated: false), {'shown'});
    });

    test('hidden listing (hidden: true) includes only hidden albums', () async {
      await insertAlbum('shown');
      await insertAlbum('hidden', isHidden: true);

      expect(await idsMatching(isElevated: false, hidden: true), {'hidden'});
    });

    // Locking still wins when elevation is absent, exactly like before this method also considered
    // isHidden: the hidden review list must not become a way to enumerate locked albums.
    test('excludes a hidden AND locked album from the hidden listing when not elevated', () async {
      await insertAlbum('hidden-and-locked', isHidden: true, isLocked: true);

      expect(await idsMatching(isElevated: false, hidden: true), isEmpty);
      expect(await idsMatching(isElevated: true, hidden: true), {'hidden-and-locked'});
    });

    // The locked clause is only added when unelevated; an elevated hidden listing must still respect
    // isHidden, since hidden and locked are unrelated, independent flags.
    test('an elevated session still only sees hidden albums when hidden is requested', () async {
      await insertAlbum('shown');
      await insertAlbum('hidden', isHidden: true);

      expect(await idsMatching(isElevated: true, hidden: true), {'hidden'});
      expect(await idsMatching(isElevated: true, hidden: false), {'shown'});
    });
  });
}
