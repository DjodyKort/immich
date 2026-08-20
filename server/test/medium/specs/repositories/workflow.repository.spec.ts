import { Kysely } from 'kysely';
import { AssetSurface, AssetVisibility } from 'src/enum';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { WorkflowRepository } from 'src/repositories/workflow.repository';
import { DB } from 'src/schema';
import { BaseService } from 'src/services/base.service';
import { toHiddenFromMask } from 'src/utils/visibility-policy';
import { newMediumService } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

/**
 * `album_asset.updateId` is a uuid column, and the backfill pages over it with a cursor. Both the
 * cursor and the owner id are plain `string` in TypeScript, and the unit tests mock this repository,
 * so neither can tell a valid uuid from a value Postgres rejects. Only a real database can, which is
 * why the backfill's paging contract is pinned here rather than in the unit suite.
 */

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(WorkflowRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(WorkflowRepository.name, () => {
  describe('getForAlbumAssetV1Backfill', () => {
    it('should accept the nil uuid as a starting cursor', async () => {
      const { sut } = setup();

      // Regression: the cursor started life as `''`, which fails the whole query with `invalid input
      // syntax for type uuid: ""` on the first page of every backfill. The nil uuid sorts below every
      // generated uuid, so it is the correct starting point for a uuid cursor.
      await expect(sut.getForAlbumAssetV1Backfill(NIL_UUID, NIL_UUID)).resolves.toEqual([]);
    });

    it('should return an album asset that already existed, and keep a locked one', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: visible.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: locked.id });

      const results = await sut.getForAlbumAssetV1Backfill(user.id, NIL_UUID);

      // A locked asset stays in: it would have reached the live `AlbumAssetsAdded` trigger, and the
      // backfill exists to replay exactly what that trigger would have seen.
      expect(results.map(({ assetId }) => assetId).sort()).toEqual([visible.id, locked.id].sort());
    });

    it('should exclude a trashed asset and a motion part', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset: kept } = await ctx.newAsset({ ownerId: user.id });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
      const { asset: motionPart } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Hidden });
      for (const assetId of [kept.id, trashed.id, motionPart.id]) {
        await ctx.newAlbumAsset({ albumId: album.id, assetId });
      }

      const results = await sut.getForAlbumAssetV1Backfill(user.id, NIL_UUID);

      // Neither would ever have reached the live trigger, so neither belongs in a replay of it.
      expect(results.map(({ assetId }) => assetId)).toEqual([kept.id]);
    });

    it("should exclude another user's asset sitting in the owner's album", async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: owner.id });
      const { asset: mine } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: mine.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: theirs.id });

      const results = await sut.getForAlbumAssetV1Backfill(owner.id, NIL_UUID);

      // A workflow only ever acts on its owner's assets -- `runQueue` re-checks the same thing before
      // writing -- so a shared album's foreign assets must not even be enqueued.
      expect(results.map(({ assetId }) => assetId)).toEqual([mine.id]);
    });

    it('should page forward from a cursor without repeating a row', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      for (let i = 0; i < 3; i++) {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      }

      const first = await sut.getForAlbumAssetV1Backfill(user.id, NIL_UUID);
      expect(first).toHaveLength(3);

      // Ascending by updateId, so the last row of a page is its high-water mark. Passing it back must
      // return only what comes after it -- the property the cursor-advance regression violated.
      const second = await sut.getForAlbumAssetV1Backfill(user.id, first.at(-1)!.updateId);
      expect(second).toEqual([]);

      const fromFirstRow = await sut.getForAlbumAssetV1Backfill(user.id, first[0].updateId);
      expect(fromFirstRow.map(({ assetId }) => assetId)).toEqual(first.slice(1).map(({ assetId }) => assetId));
    });
  });

  /**
   * The plugin-facing payload speaks in `AssetSurface` names, never in `hiddenFrom` bit values.
   *
   * That boundary is why the numbering in `SURFACE_BIT` is still movable: the bits are persisted, but
   * nothing outside `visibility-policy.ts` knows them. A plugin is the one consumer that could end that
   * -- its config is stored, it may be third-party, and it is the one place we cannot migrate. Mobile
   * made the same call by having sync carry names.
   */
  describe('hiddenFrom translation', () => {
    it('should report no exclusions as an empty array, not null', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      // Every row upstream writes is null. A plugin iterating the field must not have to null-check it.
      await expect(sut.getForAssetV1(asset.id)).resolves.toMatchObject({ hiddenFrom: [] });
    });

    it('should translate every surface, so no bit reaches a plugin unnamed', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const surfaces = Object.values(AssetSurface);
      const { asset } = await ctx.newAsset({ ownerId: user.id, hiddenFrom: toHiddenFromMask(surfaces) });

      const payload = await sut.getForAssetV1(asset.id);
      expect([...payload.hiddenFrom].sort()).toEqual([...surfaces].sort());
    });

    it('should carry the names through the album-asset path the queue is built from', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user.id });
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        hiddenFrom: toHiddenFromMask([AssetSurface.Search]),
      });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      // This path's rows are serialised into `workflow_queue.data` and read back by `runQueue`, so a
      // raw bitmask leaking here would be persisted rather than merely passed.
      const rows = await sut.getForAlbumAssetV1(NIL_UUID);
      const row = rows.find(({ assetId }) => assetId === asset.id);
      expect(row?.asset?.hiddenFrom).toEqual([AssetSurface.Search]);
    });
  });
});
