import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/repositories/timeline.repository.dart';
import 'package:intl/date_symbol_data_local.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late DriftTimelineRepository sut;

  setUpAll(() async {
    await initializeDateFormatting();
  });

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = DriftTimelineRepository(ctx.db);
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
      // A locked album syncs down looking ordinary, because RemoteAlbumEntity has no isLocked column,
      // so the visibility predicate on the album queries is the only thing keeping locked-folder
      // assets from rendering with no PIN.
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

    test('withholds an asset from the person grid it shares with the timeline surface', () async {
      // The server routes a person's photo grid through Surface.Timeline, not Surface.People; People is
      // the people *list* and its counts. Mobile mirrors that split, so the timeline bit is the one that
      // empties this grid.
      final user = await ctx.newUser();
      final visible = await ctx.newRemoteAsset(ownerId: user.id);
      final hidden = await ctx.newRemoteAsset(ownerId: user.id, hiddenFrom: const [AssetSurface.timeline]);
      final person = await ctx.newPerson(ownerId: user.id, name: 'Someone');
      await ctx.newFace(assetId: visible.id, personId: person.id);
      await ctx.newFace(assetId: hidden.id, personId: person.id);

      final assets = await sut.person(user.id, person.id, .day).assetSource(0, 10);
      expect(assets.map((item) => (item as RemoteAsset).id), [visible.id]);
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
}
