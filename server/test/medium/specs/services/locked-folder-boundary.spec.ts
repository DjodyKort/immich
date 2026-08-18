import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AlbumUserRole, AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { MapRepository } from 'src/repositories/map.repository';
import { OcrRepository } from 'src/repositories/ocr.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { AssetService } from 'src/services/asset.service';
import { TimelineService } from 'src/services/timeline.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Locked-folder boundary characterization tests.
 *
 * `asset.visibility = 'locked'` is only ever supposed to be reachable through the PIN-gated
 * locked folder. Today that invariant is upheld by two service-layer guards
 * (`Permission.AssetShare` hardcoding `hasElevatedPermission: false`, and
 * `AssetService.updateAll` evicting an asset from every album when it becomes Locked) rather
 * than by a visibility filter at every read path that can reach an asset through an album.
 *
 * These tests assert the properties that must continue to hold regardless of which mechanism
 * enforces them - today's guards, or a future "locked albums" feature. Where a property does not
 * hold today, the test is kept (so a future fix flips it green) but skipped with a comment
 * documenting the gap, per the project's `describe.skip`/`it.skip` idiom (see
 * `src/maintenance/maintenance-worker.service.spec.ts`).
 *
 * To reach the state a locked asset must never be in outside of a bug or an unbuilt feature, the
 * asset is inserted into `album_asset` directly via `ctx.newAlbumAsset`, which calls
 * `AlbumRepository.addAssetIds` - a bare INSERT with no visibility or permission check - bypassing
 * `AlbumService.addAssets` / `Permission.AssetShare` entirely. That is the intended use of the
 * helper (see e.g. `album.service.spec.ts`'s "should copy albums" test) and is the only way to
 * reach this state without the guards already blocking it.
 */

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const setupTimeline = (db?: Kysely<DB>) => {
  return newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });
};

const setupAlbum = (db?: Kysely<DB>) => {
  return newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AlbumRepository, UserRepository, AccessRepository, MapRepository],
    mock: [LoggingRepository, EventRepository],
  });
};

const setupAsset = (db?: Kysely<DB>) => {
  return newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository],
  });
};

describe('locked folder boundary', () => {
  describe('album timeline buckets', () => {
    it('should not include a locked asset in album bucket counts for a non-elevated session', async () => {
      const { sut, ctx } = setupTimeline();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        visibility: AssetVisibility.Locked,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      await expect(sut.getTimeBuckets(auth, { albumId: album.id })).resolves.toEqual([]);
    });

    it('should not include a locked asset in an album time bucket for a non-elevated session', async () => {
      const { sut, ctx } = setupTimeline();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        visibility: AssetVisibility.Locked,
        localDateTime: new Date('1970-02-12'),
      });
      await ctx.newExif({ assetId: asset.id, make: 'Canon' });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      const rawResponse = await sut.getTimeBucket(auth, { albumId: album.id, timeBucket: '1970-02-01' });
      const response = JSON.parse(rawResponse);

      expect(response.id).toEqual([]);
    });
  });

  describe('album map markers', () => {
    // SKIPPED: documents a real gap. `MapRepository.getAlbumMapMarkers`
    // (server/src/repositories/map.repository.ts:74) has no visibility predicate at all, so a
    // locked asset placed into an album - by a bug, or by a future locked-albums feature - is
    // returned to a non-elevated session via `AlbumService.getMapMarkers`.
    it.skip('should not expose a locked asset via album map markers to a non-elevated session', async () => {
      const { sut, ctx } = setupAlbum();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newExif({ assetId: asset.id, latitude: 40.7128, longitude: -74.006 });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      const auth = factory.auth({ user: { id: user.id } });

      const markers = await sut.getMapMarkers(auth, album.id);

      expect(markers.map((marker) => marker.id)).not.toContain(asset.id);
    });
  });

  describe('album-derived asset access', () => {
    // SKIPPED: documents a real gap. `AccessRepository`'s `AssetAccess.checkAlbumAccess`
    // (server/src/repositories/access.repository.ts:146-183) has no visibility predicate, so once
    // a locked asset is a member of `album_asset` it is treated as accessible through the album by
    // `Permission.AssetRead` / `AssetView` / `AssetDownload` (server/src/utils/access.ts) to any
    // user with album access, elevated or not.
    it.skip('should not grant access to a locked asset via shared album membership to a non-elevated session', async () => {
      const { sut, ctx } = setupAsset();
      const { user: owner } = await ctx.newUser();
      const { user: viewer } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: owner.id });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id, role: AlbumUserRole.Viewer });

      const auth = factory.auth({ user: { id: viewer.id } });

      await expect(sut.get(auth, asset.id)).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('existing invariants (pin against regression)', () => {
    it('should remove an asset from every album when its visibility is set to locked', async () => {
      const { sut, ctx } = setupAsset();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      const auth = factory.auth({ user: { id: user.id } });
      await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Locked });

      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set());
    });

    it('should not allow adding a locked asset to an album through the service layer', async () => {
      const { sut, ctx } = setupAlbum();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

      const auth = factory.auth({ user: { id: user.id } });
      const results = await sut.addAssets(auth, album.id, { ids: [asset.id] });

      expect(results).toEqual([{ id: asset.id, success: false, error: BulkIdErrorReason.NO_PERMISSION }]);
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set());
    });
  });
});
