import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/repositories/remote_asset.repository.dart';

import '../repository_context.dart';

void main() {
  late MediumRepositoryContext ctx;
  late RemoteAssetRepository sut;

  setUp(() {
    ctx = MediumRepositoryContext();
    sut = RemoteAssetRepository(ctx.db);
  });

  tearDown(() async {
    await ctx.dispose();
  });

  group('getByChecksum', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    test('returns all assets when a partner shares the checksum', () async {
      const checksum = 'shared-partner-checksum';
      final mine = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);
      final mineResult = result.firstWhere((asset) => asset.id == mine.id);
      final theirResult = result.firstWhere((asset) => asset.id == theirs.id);

      expect(result, isNotEmpty);
      expect(mineResult.id, mine.id);
      expect(mineResult.ownerId, userId);

      expect(theirResult.id, theirs.id);
      expect(theirResult.ownerId, partner.id);
    });

    test('returns partner asset only if there is no matching user asset', () async {
      const checksum = 'partner-only';
      final partner = await ctx.newUser();
      final theirs = await ctx.newRemoteAsset(ownerId: partner.id, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, theirs.id);
    });

    test('returns the current user\'s asset', () async {
      const checksum = 'simple';
      final remote = await ctx.newRemoteAsset(ownerId: userId, checksum: checksum);

      final result = await sut.getAllDebugForChecksum(checksum);

      expect(result.length, 1);
      expect(result[0].id, remote.id);
    });
  });

  group('hiddenFrom', () {
    late String userId;

    setUp(() async {
      final user = await ctx.newUser();
      userId = user.id;
      await ctx.newAuthUser(id: userId);
    });

    test('an untouched asset is withheld from nothing', () async {
      final asset = await ctx.newRemoteAsset(ownerId: userId);

      final result = await sut.get(asset.id);

      expect(result!.hiddenFrom, isEmpty);
    });

    test('reads the stored mask back as surface names', () async {
      final asset = await ctx.newRemoteAsset(
        ownerId: userId,
        hiddenFrom: const [AssetSurface.search, AssetSurface.memories],
      );

      final result = await sut.get(asset.id);

      expect(result!.hiddenFrom, {AssetSurface.search, AssetSurface.memories});
    });

    test('writes a set and reads back exactly it', () async {
      final asset = await ctx.newRemoteAsset(ownerId: userId);

      await sut.updateHiddenFrom([asset.id], {AssetSurface.timeline, AssetSurface.folders});

      final result = await sut.get(asset.id);
      expect(result!.hiddenFrom, {AssetSurface.timeline, AssetSurface.folders});
    });

    test('replaces the whole set rather than merging into it', () async {
      final asset = await ctx.newRemoteAsset(ownerId: userId, hiddenFrom: const [AssetSurface.timeline]);

      await sut.updateHiddenFrom([asset.id], {AssetSurface.map});

      final result = await sut.get(asset.id);
      expect(result!.hiddenFrom, {AssetSurface.map});
    });

    test('an empty set clears the column back to null', () async {
      final asset = await ctx.newRemoteAsset(
        ownerId: userId,
        hiddenFrom: const [AssetSurface.timeline, AssetSurface.people],
      );

      await sut.updateHiddenFrom([asset.id], const {});

      final stored = await ctx.db.managers.remoteAssetEntity
          .filter((row) => row.id.equals(asset.id))
          .map((row) => row.hiddenFrom)
          .getSingle();
      expect(stored, isNull, reason: 'withheld from nothing must have one spelling in the column');
      expect((await sut.get(asset.id))!.hiddenFrom, isEmpty);
    });

    test('leaves the assets it was not given alone', () async {
      final target = await ctx.newRemoteAsset(ownerId: userId);
      final bystander = await ctx.newRemoteAsset(ownerId: userId, hiddenFrom: const [AssetSurface.timeline]);

      await sut.updateHiddenFrom([target.id], {AssetSurface.search});

      expect((await sut.get(bystander.id))!.hiddenFrom, {AssetSurface.timeline});
    });
  });
}
