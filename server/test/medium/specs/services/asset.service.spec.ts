import { Kysely } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetStatus,
  AssetSurface,
  AssetVisibility,
  JobName,
  SharedLinkType,
} from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository';
import { AssetJobRepository } from 'src/repositories/asset-job.repository';
import { AssetLockRestoreRepository } from 'src/repositories/asset-lock-restore.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { OcrRepository } from 'src/repositories/ocr.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { StackRepository } from 'src/repositories/stack.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AssetService } from 'src/services/asset.service';
import { forSystem, fromHiddenFromMask, toHiddenFromMask } from 'src/utils/visibility-policy';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(AssetService, {
    database: db || defaultDatabase,
    real: [
      AssetRepository,
      AssetEditRepository,
      AssetJobRepository,
      AssetLockRestoreRepository,
      AlbumRepository,
      AccessRepository,
      SharedLinkAssetRepository,
      StackRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, JobRepository, StorageRepository, OcrRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// Every unlock path queues a sidecar write, so give the mock an implementation rather than letting a
// test fail on the mock instead of on the behaviour it is asserting.
const setupWithJobs = () => {
  const made = setup();
  made.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  return made;
};

type Ctx = Awaited<ReturnType<typeof setup>>['ctx'];

/** The surfaces an asset is actually withheld from, read back from the column. */
const hiddenFromOf = async (ctx: Ctx, id: string) => {
  const row = await ctx.database
    .selectFrom('asset')
    .select('hiddenFrom')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return fromHiddenFromMask(row.hiddenFrom).sort();
};

/** Three assets withheld from *different* places - the case a replacing set would flatten. */
const seedMixed = async (ctx: Ctx, ownerId: string) => {
  const { asset: onTimeline } = await ctx.newAsset({
    ownerId,
    hiddenFrom: toHiddenFromMask([AssetSurface.Timeline]),
  });
  const { asset: onMap } = await ctx.newAsset({ ownerId, hiddenFrom: toHiddenFromMask([AssetSurface.Map]) });
  const { asset: onNothing } = await ctx.newAsset({ ownerId, hiddenFrom: null });
  return { onTimeline, onMap, onNothing };
};

describe(AssetService.name, () => {
  describe('get', () => {
    it('should not return an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.get(factory.auth({ user: otherUser }), asset.id)).rejects.toThrow(
        'Not found or no asset.read access',
      );
    });
  });

  describe('getStatistics', () => {
    it('should return stats as numbers, not strings', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, fileSizeInByte: 12_345 });
      const auth = factory.auth({ user: { id: user.id } });
      await expect(sut.getStatistics(auth, {})).resolves.toEqual({ images: 1, total: 1, videos: 0 });
    });
  });

  describe('copy', () => {
    it('should copy albums', async () => {
      const { sut, ctx } = setup();
      const albumRepo = ctx.get(AlbumRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      const { album } = await ctx.newAlbum({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: oldAsset.id });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(albumRepo.getAssetIds(album.id, [oldAsset.id, newAsset.id])).resolves.toEqual(
        new Set([oldAsset.id, newAsset.id]),
      );
    });

    it('should copy shared links', async () => {
      const { sut, ctx } = setup();
      const sharedLinkRepo = ctx.get(SharedLinkRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const { id: sharedLinkId } = await sharedLinkRepo.create({
        allowUpload: false,
        key: Buffer.from('123'),
        type: SharedLinkType.Individual,
        userId: user.id,
        assetIds: [oldAsset.id],
      });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });
      await expect(sharedLinkRepo.get(user.id, sharedLinkId)).resolves.toEqual(
        expect.objectContaining({
          assets: [expect.objectContaining({ id: oldAsset.id }), expect.objectContaining({ id: newAsset.id })],
        }),
      );
    });

    it('should merge stacks', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });
      await ctx.newExif({ assetId: asset2.id, description: 'foo' });

      await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const {
        stack: { id: newStackId },
      } = await ctx.newStack({ ownerId: user.id }, [newAsset.id, asset2.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(stackRepo.getById(oldAsset.id, forSystem())).resolves.toEqual(undefined);

      const newStack = await stackRepo.getById(newStackId, forSystem());
      expect(newStack).toEqual(
        expect.objectContaining({
          primaryAssetId: newAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: asset2.id })]),
        }),
      );
      expect(newStack!.assets.length).toEqual(4);
    });

    it('should copy stack', async () => {
      const { sut, ctx } = setup();
      const stackRepo = ctx.get(StackRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: asset1.id, description: 'bar' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const {
        stack: { id: stackId },
      } = await ctx.newStack({ ownerId: user.id }, [oldAsset.id, asset1.id]);

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      const stack = await stackRepo.getById(stackId, forSystem());
      expect(stack).toEqual(
        expect.objectContaining({
          primaryAssetId: oldAsset.id,
          assets: expect.arrayContaining([expect.objectContaining({ id: newAsset.id })]),
        }),
      );
      expect(stack!.assets.length).toEqual(3);
    });

    it('should copy favorite status', async () => {
      const { sut, ctx } = setup();
      const assetRepo = ctx.get(AssetRepository);

      const { user } = await ctx.newUser();
      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });
      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      await expect(assetRepo.getById(newAsset.id)).resolves.toEqual(expect.objectContaining({ isFavorite: true }));
    });

    it('should copy sidecar file', async () => {
      const { sut, ctx } = setup();
      const storageRepo = ctx.getMock(StorageRepository);
      const jobRepo = ctx.getMock(JobRepository);

      storageRepo.copyFile.mockResolvedValue();
      jobRepo.queue.mockResolvedValue();

      const { user } = await ctx.newUser();

      const { asset: oldAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: oldAsset.id,
        path: '/path/to/my/sidecar.xmp',
        type: AssetFileType.Sidecar,
      });

      const { asset: newAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newExif({ assetId: oldAsset.id, description: 'foo' });
      await ctx.newExif({ assetId: newAsset.id, description: 'bar' });

      const auth = factory.auth({ user: { id: user.id } });

      await sut.copy(auth, { sourceId: oldAsset.id, targetId: newAsset.id });

      expect(storageRepo.copyFile).toHaveBeenCalledWith('/path/to/my/sidecar.xmp', `${newAsset.originalPath}.xmp`);

      expect(jobRepo.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: newAsset.id },
      });
    });
  });

  describe('delete', () => {
    it('should delete asset', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      const sidecarPath = '/path/to/sidecar.xmp';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: sidecarPath }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath, sidecarPath, asset.originalPath] },
      });
    });

    it('should delete a stacked primary asset (2 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id]);

      const stackRepo = ctx.get(StackRepository);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(stackRepo.getById(stack.id, forSystem())).resolves.toBe(undefined);
    });

    it('should delete a stacked primary asset (3 assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // new primary asset is picked
      await expect(ctx.get(StackRepository).getById(stack.id, forSystem())).resolves.toMatchObject({
        primaryAssetId: asset2.id,
      });
    });

    it('should delete a stacked primary asset (3 trashed assets)', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset3 } = await ctx.newAsset({ ownerId: user.id });
      const { stack, result } = await ctx.newStack({ ownerId: user.id }, [asset1.id, asset2.id, asset3.id]);

      await ctx.get(AssetRepository).updateAll([asset1.id, asset2.id, asset3.id], {
        deletedAt: new Date(),
        status: AssetStatus.Deleted,
      });

      expect(result).toMatchObject({ primaryAssetId: asset1.id });

      await sut.handleAssetDeletion({ id: asset1.id, deleteOnDisk: true });

      // stack is deleted as well
      await expect(ctx.get(StackRepository).getById(stack.id, forSystem())).resolves.toBe(undefined);
    });

    it('should not delete offline assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(EventRepository).emit.mockResolvedValue();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, isOffline: true });
      const thumbnailPath = '/path/to/thumbnail.jpg';
      const previewPath = '/path/to/preview.jpg';
      await Promise.all([
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: thumbnailPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: previewPath }),
        ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: `/path/to/sidecar.xmp` }),
      ]);

      await sut.handleAssetDeletion({ id: asset.id, deleteOnDisk: true });

      expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [thumbnailPath, previewPath] },
      });
    });
  });

  describe('update', () => {
    it('should not update an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await expect(sut.update(factory.auth({ user: otherUser }), asset.id, {})).rejects.toThrow(
        'Not found or no asset.update access',
      );
    });

    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.update(auth, asset.id, {
        latitude: 42,
        longitude: 42,
        rating: 3,
        description: 'foo',
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone UTC+0', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.update(auth, asset.id, { dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  /**
   * The point of `hiddenFromAdd`/`hiddenFromRemove`: a selection can hold assets withheld from
   * different places, and `hiddenFrom` replaces the whole set, so using it across a mixed selection
   * discards the difference. These assert the arithmetic on real Postgres, since the whole thing is
   * one bitwise statement rather than application logic.
   */
  describe('updateAll hiddenFrom arithmetic', () => {
    it('should add a surface without disturbing exclusions it was not told about', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { onTimeline, onMap, onNothing } = await seedMixed(ctx, user.id);

      await sut.updateAll(auth, {
        ids: [onTimeline.id, onMap.id, onNothing.id],
        hiddenFromAdd: [AssetSurface.Search],
      });

      // This is the case a plain `hiddenFrom: ['search']` would have got wrong, flattening all three
      // to search alone and losing the timeline and map exclusions.
      await expect(hiddenFromOf(ctx, onTimeline.id)).resolves.toEqual([AssetSurface.Search, AssetSurface.Timeline]);
      await expect(hiddenFromOf(ctx, onMap.id)).resolves.toEqual([AssetSurface.Map, AssetSurface.Search]);
      await expect(hiddenFromOf(ctx, onNothing.id)).resolves.toEqual([AssetSurface.Search]);
    });

    it('should remove only the named surface', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Timeline, AssetSurface.Map, AssetSurface.People]),
      });

      await sut.updateAll(auth, { ids: [asset.id], hiddenFromRemove: [AssetSurface.Map] });

      await expect(hiddenFromOf(ctx, asset.id)).resolves.toEqual([AssetSurface.People, AssetSurface.Timeline]);
    });

    it('should apply an add and a remove in one call', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Timeline]),
      });

      await sut.updateAll(auth, {
        ids: [asset.id],
        hiddenFromAdd: [AssetSurface.Memories],
        hiddenFromRemove: [AssetSurface.Timeline],
      });

      await expect(hiddenFromOf(ctx, asset.id)).resolves.toEqual([AssetSurface.Memories]);
    });

    // A stored 0 would read as "has exclusions" to `hiddenFrom is not null`, which is what decides
    // membership of the Hidden view -- so a fully-unhidden asset would be stuck in it forever.
    it('should store null rather than zero once the last exclusion is removed', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Timeline]),
      });

      await sut.updateAll(auth, { ids: [asset.id], hiddenFromRemove: [AssetSurface.Timeline] });

      await expect(
        ctx.database.selectFrom('asset').select('hiddenFrom').where('id', '=', asset.id).executeTakeFirstOrThrow(),
      ).resolves.toEqual({ hiddenFrom: null });
    });

    it('should be a no-op when removing a surface the asset was never hidden from', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Timeline]),
      });

      await sut.updateAll(auth, { ids: [asset.id], hiddenFromRemove: [AssetSurface.Folders] });

      await expect(hiddenFromOf(ctx, asset.id)).resolves.toEqual([AssetSurface.Timeline]);
    });

    it('should not touch assets outside the id list', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: target } = await ctx.newAsset({ ownerId: user.id, hiddenFrom: null });
      const { asset: bystander } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Map]),
      });

      await sut.updateAll(auth, { ids: [target.id], hiddenFromAdd: [AssetSurface.Search] });

      await expect(hiddenFromOf(ctx, bystander.id)).resolves.toEqual([AssetSurface.Map]);
    });
  });

  describe('updateAll', () => {
    it('should automatically lock lockable columns', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ lockedProperties: null });

      await sut.updateAll(auth, {
        ids: [asset.id],
        latitude: 42,
        description: 'foo',
        longitude: 42,
        rating: 3,
        dateTimeOriginal: '2023-11-19T18:11:00+01:00',
      });

      await expect(
        ctx.database
          .selectFrom('asset_exif')
          .select('lockedProperties')
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({
        lockedProperties: ['timeZone', 'rating', 'description', 'latitude', 'longitude', 'dateTimeOriginal'],
      });
    });

    it('should relatively update assets', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
          }),
        }),
      );
    });

    it('should relatively update assets with timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC+5' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -1441 });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-18T18:10:00+00:00',
            timeZone: 'UTC+5',
            lockedProperties: ['timeZone', 'dateTimeOriginal'],
          }),
        }),
      );
    });

    it('should relatively update assets and set a timezone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeRelative: -11, timeZone: 'UTC+5' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:00:00+00:00',
            timeZone: 'UTC+5',
          }),
        }),
      );
    });

    it('should set asset time zones to UTC', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, dateTimeOriginal: '2023-11-19T18:11:00', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], timeZone: 'UTC' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({
            dateTimeOriginal: '2023-11-19T18:11:00+00:00',
            timeZone: 'UTC',
          }),
        }),
      );
    });

    it('should update dateTimeOriginal', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: null }),
        }),
      );
    });

    it('should update dateTimeOriginal with time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000-07:00' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-20T01:11:00+00:00', timeZone: 'UTC-7' }),
        }),
      );
    });

    it('should update dateTimeOriginal with UTC time zone', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: 'test', timeZone: 'UTC-7' });

      await sut.updateAll(auth, { ids: [asset.id], dateTimeOriginal: '2023-11-19T18:11:00.000Z' });

      await expect(ctx.get(AssetRepository).getById(asset.id, { exifInfo: true })).resolves.toEqual(
        expect.objectContaining({
          exifInfo: expect.objectContaining({ dateTimeOriginal: '2023-11-19T18:11:00+00:00', timeZone: 'UTC' }),
        }),
      );
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('getOcr', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(sut.getOcr(auth, asset.id)).rejects.toThrow('Not found or no asset.read access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ x1: 0.1, x2: 0.3, x3: 0.3, x4: 0.1, y1: 0.2, y2: 0.2, y3: 0.4, y4: 0.4 }),
      ]);
    });

    it('should apply rotation', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });
      await ctx.database
        .insertInto('asset_edit')
        .values({ assetId: asset.id, action: AssetEditAction.Rotate, parameters: { angle: 90 }, sequence: 1 })
        .execute();
      ctx.getMock(OcrRepository).getByAssetId.mockResolvedValue([factory.assetOcr()]);

      await expect(sut.getOcr(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({
          x1: 0.6,
          x2: 0.8,
          x3: 0.8,
          x4: 0.6,
          y1: expect.any(Number),
          y2: expect.any(Number),
          y3: 0.3,
          y4: 0.3,
        }),
      ]);
    });
  });

  describe('upsertBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(1);
      expect(metadata[0]).toEqual(
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } }),
      );
    });

    it('should work on conflict', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } });

      // verify existing metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'old-id' } }),
      ]);

      const items = [{ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }];
      await sut.upsertBulkMetadata(auth, { items });

      // verify updated metadata
      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'new-id' } }),
      ]);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata1 = await ctx.get(AssetRepository).getMetadata(asset1.id);
      expect(metadata1).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } }),
      ]);

      const metadata2 = await ctx.get(AssetRepository).getMetadata(asset2.id);
      expect(metadata2).toEqual([
        expect.objectContaining({ key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } }),
      ]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      const items = [
        { assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } },
        { assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } },
      ];

      await sut.upsertBulkMetadata(auth, { items });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: AssetMetadataKey.MobileApp,
            value: { iCloudId: 'id1' },
          }),
          expect.objectContaining({
            key: 'some-other-key',
            value: { foo: 'bar' },
          }),
        ]),
      );
    });
  });

  describe('deleteBulkMetadata', () => {
    it('should work', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'foo' } });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work even if the item does not exist', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await sut.deleteBulkMetadata(auth, { items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }] });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata.length).toEqual(0);
    });

    it('should work with multiple assets', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset: asset1 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset1.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      const { asset: asset2 } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset2.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id2' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset1.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset2.id, key: AssetMetadataKey.MobileApp },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset1.id)).resolves.toEqual([]);
      await expect(ctx.get(AssetRepository).getMetadata(asset2.id)).resolves.toEqual([]);
    });

    it('should work with multiple metadata for the same asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [
          { assetId: asset.id, key: AssetMetadataKey.MobileApp },
          { assetId: asset.id, key: 'some-other-key' },
        ],
      });

      await expect(ctx.get(AssetRepository).getMetadata(asset.id)).resolves.toEqual([]);
    });

    it('should not delete unspecified keys', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newMetadata({ assetId: asset.id, key: AssetMetadataKey.MobileApp, value: { iCloudId: 'id1' } });
      await ctx.newMetadata({ assetId: asset.id, key: 'some-other-key', value: { foo: 'bar' } });

      await sut.deleteBulkMetadata(auth, {
        items: [{ assetId: asset.id, key: AssetMetadataKey.MobileApp }],
      });

      const metadata = await ctx.get(AssetRepository).getMetadata(asset.id);
      expect(metadata).toEqual([expect.objectContaining({ key: 'some-other-key', value: { foo: 'bar' } })]);
    });
  });

  describe('editAsset', () => {
    it('should require access', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });

      await expect(
        sut.editAsset(auth, asset.id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] }),
      ).rejects.toThrow('Not found or no asset.edit.create access');
    });

    it('should work', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queue.mockResolvedValue();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 42, exifImageWidth: 69, orientation: '1' });

      const editAction = { action: AssetEditAction.Rotate, parameters: { angle: 90 } } as const;
      const editResponse = { ...editAction, id: expect.any(String) };
      await expect(sut.editAsset(auth, asset.id, { edits: [editAction] })).resolves.toEqual({
        assetId: asset.id,
        edits: [editResponse],
      });

      await expect(ctx.get(AssetRepository).getById(asset.id)).resolves.toEqual(
        expect.objectContaining({ isEdited: true }),
      );
      await expect(ctx.get(AssetEditRepository).getAll(asset.id)).resolves.toEqual([editResponse]);
    });
  });
});

/**
 * Locking a single asset from the timeline, and taking it back out again.
 *
 * The album path has its own suite; this is the other caller of the same pair, and the one where the
 * caller gets to name where the asset lands. Both halves of a restore point are exercised here because
 * they are independent: the visibility defers to an explicit request, the album memberships never do.
 */
describe('unlocking a single asset', () => {
  it('should return an archived asset to the archive and to its albums', async () => {
    const { sut, ctx } = setupWithJobs();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

    await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Locked });
    await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set());

    await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Timeline });

    await expect(visibilityOfAsset(ctx, asset.id)).resolves.toBe(AssetVisibility.Archive);
    await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
  });

  // The asymmetry worth pinning: a caller that names a destination gets it, but nobody ever *asks* to
  // lose the albums an asset was in, so those come back either way.
  it('should honour an explicit visibility while still restoring the albums', async () => {
    const { sut, ctx } = setupWithJobs();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Timeline });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

    await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Locked });
    await sut.updateAll(auth, { ids: [asset.id], visibility: AssetVisibility.Archive });

    await expect(visibilityOfAsset(ctx, asset.id)).resolves.toBe(AssetVisibility.Archive);
    await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
  });
});

const visibilityOfAsset = async (ctx: Ctx, id: string) => {
  const row = await ctx.database
    .selectFrom('asset')
    .select('visibility')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.visibility;
};
