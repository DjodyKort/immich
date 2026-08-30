import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late TimelineRepository sut;

  setUpAll(() async {
    await initializeDateFormatting();
  });

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = TimelineRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('remoteAlbum assets', () {
    test('no duplicate assets when identical checksum appears in multiple local asset rows', () async {
      // Regression check for #23273: a LEFT OUTER JOIN on checksum would fan out and create duplicates
      // happens when same photo exists in multiple albums on device
      final user = await ctx.newUser();
      const checksum = 'yolo';
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final remoteAsset = await ctx.newRemoteAsset(ownerId: user.id, checksum: checksum);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: remoteAsset.id);

      final localAsset1 = await ctx.newLocalAsset(checksum: checksum);
      final localAsset2 = await ctx.newLocalAsset(checksum: checksum);

      final query = sut.remoteAlbum(album.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);

      final assets = await query.assetSource(0, 10);
      expect(assets, hasLength(1));
      expect((assets.first as RemoteAsset).id, remoteAsset.id);
      expect([localAsset1.id, localAsset2.id], contains((assets.first as RemoteAsset).localId));
    });

    test('does not expose locked assets in an album view', () async {
      // The visibility predicate on the album queries is the only thing keeping locked-folder assets from
      // rendering without a PIN: album membership alone says nothing about visibility, and a locked asset
      // can sit in an ordinary album if it was there before being locked.
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final visible = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.timeline);
      final locked = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.locked);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: visible.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: locked.id);

      final query = sut.remoteAlbum(album.id, .day);

      final assets = await query.assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [visible.id]);

      final buckets = await query.bucketSource().first;
      expect(buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount), 1);
    });

    test('does not count locked assets in an ungrouped album bucket', () async {
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final visible = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.timeline);
      final locked = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.locked);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: visible.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: locked.id);

      final buckets = await sut.remoteAlbum(album.id, .none).bucketSource().first;
      expect(buckets.single.assetCount, 1);
    });

    // The other half of the rule, and the reason locked albums were web-only on this client: a locked
    // album contains nothing but locked assets, so without this branch an elevated user opening one saw an
    // empty album rather than their photos.
    test('shows locked assets in an album view once the session is elevated', () async {
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final locked = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.locked);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: locked.id);

      final query = sut.remoteAlbum(album.id, .day, isElevated: true);

      final assets = await query.assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [locked.id]);

      final buckets = await query.bucketSource().first;
      expect(buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount), 1);
    });

    test('counts locked assets in an ungrouped album bucket once elevated', () async {
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final visible = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.timeline);
      final locked = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.locked);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: visible.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: locked.id);

      final buckets = await sut.remoteAlbum(album.id, .none, isElevated: true).bucketSource().first;
      expect(buckets.single.assetCount, 2);
    });

    // Elevation widens the album view to locked and nothing else. `hidden` is the motion-photo video-part
    // marker here, not a confidentiality state, so entering a PIN must not start showing video halves.
    test('still hides motion-part assets from an album view when elevated', () async {
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final visible = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.timeline);
      final motionPart = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.hidden);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: visible.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: motionPart.id);

      final assets = await sut.remoteAlbum(album.id, .day, isElevated: true).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [visible.id]);
    });
  });

  group('hiddenFrom', () {
    test('withholds an asset from the main timeline but not from an album view', () async {
      // The whole point of the column: per-asset, per-surface. Hiding from the timeline is not hiding
      // from an album -- an album is a container the user opened on purpose, and the server draws the
      // same line (AssetSurface.timeline maps to Surface.Timeline only, never Surface.AlbumTimeline).
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final visible = await ctx.newRemoteAsset(ownerId: user.id);
      final hidden = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline]);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: visible.id);
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: hidden.id);

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline.map((asset) => (asset as RemoteAsset).id), [visible.id]);

      final timelineBuckets = await sut.main([user.id], .day).bucketSource().first;
      expect(timelineBuckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount), 1);

      final albumAssets = await sut.remoteAlbum(album.id, .day).assetSource(0, 10);
      expect(albumAssets.map((asset) => (asset as RemoteAsset).id), unorderedEquals([visible.id, hidden.id]));
    });

    test('withholding from another surface leaves the timeline alone', () async {
      // If the six surfaces shared a bit, or the timeline query read the wrong one, this would fail.
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.people]);

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline.map((item) => (item as RemoteAsset).id), [asset.id]);
    });

    test('a null mask changes nothing', () async {
      // Every row that existed before this column did holds null. The clause has to be a no-op there.
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline.map((item) => (item as RemoteAsset).id), [asset.id]);

      final person = await ctx.newPerson(ownerId: user.id, name: 'Someone');
      await ctx.newFace(assetId: asset.id, personId: person.id);
      final personAssets = await sut.person(user.id, person.id, .day).assetSource(0, 10);
      expect(personAssets.map((item) => (item as RemoteAsset).id), [asset.id]);
    });

    test('withholds an asset from the person grid only when it is hidden from People', () async {
      // A person's grid is the People surface, not the timeline. Hiding a photo from the timeline is a
      // statement about the main grid, and leaves the person alone; only the People bit empties this
      // view. The server draws the same line -- ASSET_SURFACE_POLICY makes Timeline and People
      // independently hideable, and bit 512 exists for exactly this.
      //
      // This test previously asserted the opposite, because the server had no personId branch in
      // `timelineSurfaceFor` and I read that omission as the design. Both ends were wrong together,
      // which is why a photo in an album hidden from the timeline showed a count of 22 and an empty
      // grid.
      final user = await ctx.newUser();
      final visible = await ctx.newRemoteAsset(ownerId: user.id);
      final hiddenFromTimeline = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline]);
      final hiddenFromPeople = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.people]);
      final person = await ctx.newPerson(ownerId: user.id, name: 'Someone');
      for (final asset in [visible, hiddenFromTimeline, hiddenFromPeople]) {
        await ctx.newFace(assetId: asset.id, personId: person.id);
      }

      final assets = await sut.person(user.id, person.id, .day).assetSource(0, 10);
      expect(assets.map((item) => (item as RemoteAsset).id), unorderedEquals([visible.id, hiddenFromTimeline.id]));

      // The buckets are a separate query and have to agree, or the header count and the grid diverge.
      final buckets = await sut.person(user.id, person.id, .day).bucketSource().first;
      expect(buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount), 2);
    });
  });

  group('locked folder', () {
    test('withholds a locked asset hidden from the timeline surface', () async {
      // The locked folder is the timeline with visibility pinned to locked, and the server's buckets
      // for it resolve to Surface.Timeline, so the same bit has to empty it here. This view was
      // unmasked once, which meant a photo hidden from the locked folder on the web still showed on
      // the phone.
      final user = await ctx.newUser();
      final visible = await ctx.newRemoteAsset(ownerId: user.id, visibility: AssetVisibility.locked);
      final hidden = await ctx.newRemoteAsset(
        ownerId: user.id,
        visibility: AssetVisibility.locked,
        hiddenFrom: const [AssetSurface.timeline],
      );

      final assets = await sut.locked(user.id, .day).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [visible.id]);
      expect(assets.map((asset) => (asset as RemoteAsset).id), isNot(contains(hidden.id)));
    });

    test('still shows it in its locked album, which is the point of hiding it from the folder', () async {
      // The server's guarantee is "hidden from the locked folder, still in my locked album". Mobile
      // could not assert it while album views admitted only timeline and archive visibility - a locked
      // asset never reached one. The elevated branch closed that, so the guarantee is now testable
      // here, and it holds for two independent reasons: elevation admits locked visibility, and album
      // views take no hiddenFrom mask at all.
      final user = await ctx.newUser();
      final album = await ctx.newRemoteAlbum(ownerId: user.id);
      final hidden = await ctx.newRemoteAsset(
        ownerId: user.id,
        visibility: AssetVisibility.locked,
        hiddenFrom: const [AssetSurface.timeline],
      );
      await ctx.newRemoteAlbumAsset(albumId: album.id, assetId: hidden.id);

      final lockedFolder = await sut.locked(user.id, .day).assetSource(0, 10);
      expect(lockedFolder, isEmpty);

      final inAlbum = await sut.remoteAlbum(album.id, .day, isElevated: true).assetSource(0, 10);
      expect(inAlbum.map((asset) => (asset as RemoteAsset).id), [hidden.id]);
    });

    test('still lists it in the Hidden view, so hiding it from the folder is not losing it', () async {
      // The other route back to it, and the one that holds for an asset in no album at all. The Hidden
      // view takes no surface bit by design.
      final user = await ctx.newUser();
      final hidden = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline]);

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [hidden.id]);
    });
  });

  group('hidden assets view', () {
    test('shows only assets withheld from at least one surface', () async {
      final user = await ctx.newUser();
      await ctx.newRemoteAsset(ownerId: user.id);
      final hidden = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline]);

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [hidden.id]);

      final buckets = await sut.hidden(user.id, .day).bucketSource().first;
      expect(buckets.fold<int>(0, (sum, bucket) => sum + bucket.assetCount), 1);
    });

    test('is not itself filtered by the hiddenFrom mask', () async {
      // Every other query subtracts an asset withheld from its own surface. This view must not, or a
      // photo hidden from every surface would disappear from the one place that guarantees it stays
      // findable.
      final user = await ctx.newUser();
      final hidden = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: AssetSurface.values);

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [hidden.id]);
    });

    test('excludes a locked asset even when it is also withheld from a surface', () async {
      // This view has no PIN gate of its own, unlike the locked folder, so a locked asset must not
      // surface here regardless of its hiddenFrom mask.
      final user = await ctx.newUser();
      await ctx.newRemoteAsset(
        ownerId: user.id,
        visibility: AssetVisibility.locked,
        hiddenFrom: const [AssetSurface.timeline],
      );

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets, isEmpty);
    });

    test('excludes a hidden-and-trashed asset, findable through trash instead', () async {
      final user = await ctx.newUser();
      await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline], deletedAt: DateTime(2026));

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets, isEmpty);
    });

    test('admits an archived asset that is withheld from a surface', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(
        ownerId: user.id,
        visibility: AssetVisibility.archive,
        hiddenFrom: const [AssetSurface.folders],
      );

      final assets = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(assets.map((item) => (item as RemoteAsset).id), [asset.id]);
    });

    test('orders shifted album assets in both directions and keeps normal asset order (#28852)', () async {
      final user = await ctx.newUser();
      final descendingAlbum = await ctx.newRemoteAlbum(ownerId: user.id, order: .desc);
      final ascendingAlbum = await ctx.newRemoteAlbum(ownerId: user.id, order: .asc);
      final shiftedLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 2, 12),
        localDateTime: DateTime.utc(2024, 9, 3, 12),
      );
      final shiftedEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 3, 12),
        localDateTime: DateTime.utc(2024, 9, 2, 12),
      );
      final normalLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 4, 14),
        localDateTime: DateTime.utc(2024, 9, 4, 14),
      );
      final normalEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 4, 12),
        localDateTime: DateTime.utc(2024, 9, 4, 12),
      );
      final seeded = [shiftedLater, shiftedEarlier, normalLater, normalEarlier];
      for (final asset in seeded) {
        await ctx.newRemoteAlbumAsset(albumId: descendingAlbum.id, assetId: asset.id);
        await ctx.newRemoteAlbumAsset(albumId: ascendingAlbum.id, assetId: asset.id);
      }

      final descending = sut.remoteAlbum(descendingAlbum.id, .day);
      final ascending = sut.remoteAlbum(ascendingAlbum.id, .day);

      final buckets = await descending.bucketSource().first;
      expect(buckets, hasLength(3));
      expect(buckets.map((bucket) => bucket.assetCount), [2, 1, 1]);

      final descendingAssets = await descending.assetSource(0, 10);
      expect(descendingAssets.map((asset) => (asset as RemoteAsset).id), [
        normalLater.id,
        normalEarlier.id,
        shiftedLater.id,
        shiftedEarlier.id,
      ]);

      final ascendingAssets = await ascending.assetSource(0, 10);
      expect(ascendingAssets.map((asset) => (asset as RemoteAsset).id), [
        shiftedEarlier.id,
        shiftedLater.id,
        normalEarlier.id,
        normalLater.id,
      ]);
    });
  });

  group('person assets', () {
    test('does not duplicate an asset that has multiple face records for the same person', () async {
      // Regression check for #26723: an INNER JOIN between remote_asset_entity and asset_face_entity
      // fanned out one asset into N rows when N face records pointed at the same (asset, person) pair
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id);

      final person = await ctx.newPerson(ownerId: user.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);
      await ctx.newFace(assetId: asset.id, personId: person.id);

      final query = sut.person(user.id, person.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);

      final assets = await query.assetSource(0, 10);
      expect(assets, hasLength(1));
      expect((assets.first as RemoteAsset).id, asset.id);
    });

    test('orders shifted person assets by effective date (#28852)', () async {
      final user = await ctx.newUser();
      final person = await ctx.newPerson(ownerId: user.id);
      final shiftedLater = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 2, 12),
        localDateTime: DateTime.utc(2024, 9, 3, 12),
      );
      final shiftedEarlier = await ctx.newRemoteAsset(
        ownerId: user.id,
        createdAt: DateTime.utc(2024, 9, 3, 12),
        localDateTime: DateTime.utc(2024, 9, 2, 12),
      );
      await ctx.newFace(assetId: shiftedLater.id, personId: person.id);
      await ctx.newFace(assetId: shiftedEarlier.id, personId: person.id);

      final query = sut.person(user.id, person.id, .day);

      final buckets = await query.bucketSource().first;
      expect(buckets, hasLength(2));

      final assets = await query.assetSource(0, 10);
      expect(assets.map((asset) => (asset as RemoteAsset).id), [shiftedLater.id, shiftedEarlier.id]);
    });
  });

  group('live photos', () {
    test('remote-only live photo contains livePhotoVideoId and is marked as a motion photo', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(ownerId: user.id, livePhotoVideoId: 'motion-photo-1');

      final assets = await sut.main([user.id], .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final remote = assets.single as RemoteAsset;
      expect(remote.id, asset.id);
      expect(remote.livePhotoVideoId, 'motion-photo-1');
      expect(remote.isMotionPhoto, isTrue);
      expect(remote.localId, isNull);
    });

    test('merged live photo resolves localId and is marked as a motion photo', () async {
      final user = await ctx.newUser();
      const checksum = 'shared-live-photo-checksum';
      final asset = await ctx.newRemoteAsset(ownerId: user.id, checksum: checksum, livePhotoVideoId: 'motion-photo-2');
      final local = await ctx.newLocalAsset(checksum: checksum);

      final assets = await sut.main([user.id], .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final remote = assets.single as RemoteAsset;
      expect(remote.id, asset.id);
      expect(remote.livePhotoVideoId, 'motion-photo-2');
      expect(remote.isMotionPhoto, isTrue);
      expect(remote.localId, local.id);
    });
  });

  group('localAlbum assets', () {
    late String userId;
    late String otherUserId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
      final other = await ctx.newUser();
      otherUserId = other.id;
    });

    test('does not duplicate assets when a partner shares the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final album = await ctx.newLocalAlbum();
      final local = await ctx.newLocalAsset(checksum: checksum);
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      final myRemote = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      await ctx.newRemoteAsset(ownerId: otherUserId, checksum: checksum);

      final assets = await sut.localAlbum(album.id, .day).assetSource(0, 10);

      expect(assets, hasLength(1));
      final asset = assets.single as LocalAsset;
      expect(asset.id, local.id);
      // Must resolve the current user's remote id
      expect(asset.remoteId, myRemote.id);
    });

    test('bucket count ignores a partner sharing the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final album = await ctx.newLocalAlbum();
      final local = await ctx.newLocalAsset(checksum: checksum);
      await ctx.newLocalAlbumAsset(albumId: album.id, assetId: local.id);
      await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      await ctx.newRemoteAsset(ownerId: otherUserId, checksum: checksum);

      final buckets = await sut.localAlbum(album.id, .day).bucketSource().first;

      expect(buckets, hasLength(1));
      expect(buckets.single.assetCount, 1);
    });
  });

  /// Album-level rules, inherited onto the asset and overridable per photo.
  ///
  /// The arithmetic mirrors the server's `EFFECTIVE_HIDDEN_FROM` exactly:
  /// `hiddenFrom | (hiddenFromInherited & ~hiddenFromShown)`. Diverging here would mean the same photo
  /// appearing on the phone and not on the web, which is the failure this file exists to catch.
  group('album-inherited hiding', () {
    test('withholds an asset its album withholds, with no setting of its own', () async {
      final user = await ctx.newUser();
      final visible = await ctx.newRemoteAsset(ownerId: user.id);
      final inherited = await ctx.newRemoteAsset(ownerId: user.id, hiddenFromInherited: const [AssetSurface.timeline]);

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline.map((asset) => (asset as RemoteAsset).id), [visible.id]);
      expect(timeline.map((asset) => (asset as RemoteAsset).id), isNot(contains(inherited.id)));
    });

    test('shows it again when the photo overrides the album', () async {
      // The escape hatch, and the reason hiddenFromShown exists: album rules combine by union, so no
      // other album can reveal a photo one of them hid.
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(
        ownerId: user.id,
        hiddenFromInherited: const [AssetSurface.timeline],
        hiddenFromShown: const [AssetSurface.timeline],
      );

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline.map((a) => (a as RemoteAsset).id), [asset.id]);
    });

    test('keeps the asset hidden when the override names a different surface', () async {
      final user = await ctx.newUser();
      final asset = await ctx.newRemoteAsset(
        ownerId: user.id,
        hiddenFromInherited: const [AssetSurface.timeline],
        hiddenFromShown: const [AssetSurface.search],
      );

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline, isEmpty);
      expect(asset.id, isNotEmpty);
    });

    test("an override cannot cancel the photo's own hiding", () async {
      // The point of bracketing the override around the inherited term alone. If the formula were
      // (own | inherited) & ~shown, this photo would reappear on the timeline it was explicitly hidden
      // from, because of a bit that only ever meant "despite the album".
      final user = await ctx.newUser();
      await ctx.newRemoteAsset(
        ownerId: user.id,
        hiddenFrom: const [AssetSurface.timeline],
        hiddenFromShown: const [AssetSurface.timeline],
      );

      final timeline = await sut.main([user.id], .day).assetSource(0, 10);
      expect(timeline, isEmpty);
    });

    test('lists an album-hidden asset in the Hidden view', () async {
      // Hiding is never a one-way door, and an album rule is no less able to lose a photo than a manual
      // exclusion, so the effective mask decides membership here rather than the asset's own setting.
      final user = await ctx.newUser();
      final inherited = await ctx.newRemoteAsset(ownerId: user.id, hiddenFromInherited: const [AssetSurface.timeline]);
      await ctx.newRemoteAsset(ownerId: user.id);

      final hidden = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(hidden.map((a) => (a as RemoteAsset).id), [inherited.id]);
    });

    test('drops it from the Hidden view once fully overridden', () async {
      final user = await ctx.newUser();
      await ctx.newRemoteAsset(
        ownerId: user.id,
        hiddenFromInherited: const [AssetSurface.timeline],
        hiddenFromShown: const [AssetSurface.timeline],
      );

      final hidden = await sut.hidden(user.id, .day).assetSource(0, 10);
      expect(hidden, isEmpty);
    });
  });
}
