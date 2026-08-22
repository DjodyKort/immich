import { Kysely } from 'kysely';
import { BulkIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AlbumUserRole, AssetVisibility, SharedLinkType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Locking and unlocking an album that already exists.
 *
 * Upstream only allowed locking at creation, which made locked albums assemble-only: setting an asset to
 * Locked evicts it from every album, so an ordinary album whose assets were all already locked could not
 * exist, and "lock this album" had no path. `setLocked` is that path, and it is the riskiest operation in
 * this area because it rewrites both the album and the visibility of everything in it.
 *
 * Every precondition is a refusal rather than a fix-up, which is what most of these assert. The reason is
 * that a wrong guess here is invisible to the user: their photos leave the timeline and the album they
 * were browsing, and nothing on screen says why.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const made = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, JobRepository, EventRepository],
  });

  // Every successful path through setLocked queues sidecar writes and emits AlbumUpdate, so give both
  // an implementation here rather than per-test - a test that builds its own fixtures instead of
  // calling `seed` would otherwise fail on the mock, not on the behaviour it is asserting.
  made.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  made.ctx.getMock(EventRepository).emit.mockResolvedValue();

  return made;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Ctx = Awaited<ReturnType<typeof setup>>['ctx'];

/** An owned album with two owned, ordinary assets - the normal starting point. */
const seed = async (ctx: Ctx) => {
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const { asset: first } = await ctx.newAsset({ ownerId: user.id });
  const { asset: second } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: first.id });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: second.id });

  return {
    user,
    album,
    assets: [first, second],
    elevated: factory.auth({ user, session: { hasElevatedPermission: true } }),
    plain: factory.auth({ user }),
  };
};

const visibilityOf = async (ctx: Ctx, id: string) => {
  const row = await ctx.database
    .selectFrom('asset')
    .select('visibility')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.visibility;
};

const isLocked = async (ctx: Ctx, id: string) => {
  const row = await ctx.database.selectFrom('album').select('isLocked').where('id', '=', id).executeTakeFirstOrThrow();
  return row.isLocked;
};

describe('locking an existing album', () => {
  it('should lock the album and every asset in it', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated } = await seed(ctx);

    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(isLocked(ctx, album.id)).resolves.toBe(true);
    for (const asset of assets) {
      await expect(visibilityOf(ctx, asset.id)).resolves.toBe(AssetVisibility.Locked);
    }
  });

  // The leak this exists to prevent: album membership grants asset reads via `checkAlbumAccess`, so the
  // same photo sitting behind the PIN here and in an ordinary album would be readable without the PIN.
  it('should remove the newly locked assets from every other album', async () => {
    const { sut, ctx } = setup();
    const { user, album, assets, elevated } = await seed(ctx);
    const { album: other } = await ctx.newAlbum({ ownerId: user.id });
    await ctx.newAlbumAsset({ albumId: other.id, assetId: assets[0].id });

    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(ctx.get(AlbumRepository).getAssetIds(other.id, [assets[0].id])).resolves.toEqual(new Set());
    // ...while leaving the membership it was told to keep.
    await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [assets[0].id])).resolves.toEqual(
      new Set([assets[0].id]),
    );
  });

  it('should put the assets back on the timeline when unlocked, and keep them in the album', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated } = await seed(ctx);

    await sut.setLocked(elevated, album.id, { isLocked: true });
    await sut.setLocked(elevated, album.id, { isLocked: false });

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    for (const asset of assets) {
      await expect(visibilityOf(ctx, asset.id)).resolves.toBe(AssetVisibility.Timeline);
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [asset.id])).resolves.toEqual(new Set([asset.id]));
    }
  });

  it('should refuse without an elevated session', async () => {
    const { sut, ctx } = setup();
    const { album, assets, plain } = await seed(ctx);

    await expect(sut.setLocked(plain, album.id, { isLocked: true })).rejects.toThrow('Elevated permission');

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });

  // Unlocking is gated too: otherwise an unelevated session could empty a locked folder it cannot open.
  //
  // Two gates catch this, and which one fires depends on the album. The `AlbumUpdate` access check
  // already refuses a *locked* album to an unelevated session, so that is what answers here; the explicit
  // `requireElevatedPermission` is what answers when locking an ordinary one. Asserting either message
  // rather than the specific one keeps this test about the refusal instead of about which layer got
  // there first.
  it('should refuse to unlock without an elevated session', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated, plain } = await seed(ctx);
    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(sut.setLocked(plain, album.id, { isLocked: false })).rejects.toThrow(
      /Elevated permission|album\.update access/,
    );

    await expect(isLocked(ctx, album.id)).resolves.toBe(true);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Locked);
  });

  it('should refuse to lock a shared album rather than silently revoking access', async () => {
    const { sut, ctx } = setup();
    const { user, album, assets, elevated } = await seed(ctx);
    const { user: guest } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId: album.id, userId: guest.id, role: AlbumUserRole.Viewer });

    await expect(sut.setLocked(elevated, album.id, { isLocked: true })).rejects.toThrow('Unshare');

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
    expect(user.id).not.toEqual(guest.id);
  });

  // A shared link fails closed on its own - it carries no session, so it is never elevated and the album
  // access check turns it away - but refusing here means the user is never left holding a link that has
  // quietly stopped working.
  it('should refuse to lock an album that has a shared link', async () => {
    const { sut, ctx } = setup();
    const { user, album, assets, elevated } = await seed(ctx);
    await ctx.get(SharedLinkRepository).create({
      allowUpload: false,
      key: Buffer.from('album-link'),
      type: SharedLinkType.Album,
      userId: user.id,
      albumId: album.id,
    });

    await expect(sut.setLocked(elevated, album.id, { isLocked: true })).rejects.toThrow('Unshare');

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });

  // Locking someone else's contribution would hide their own photo from them.
  it("should refuse to lock an album containing another user's asset", async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated } = await seed(ctx);
    const { user: other } = await ctx.newUser();
    const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });
    await ctx.newAlbumAsset({ albumId: album.id, assetId: theirs.id });

    await expect(sut.setLocked(elevated, album.id, { isLocked: true })).rejects.toThrow('own every asset');

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, theirs.id)).resolves.toBe(AssetVisibility.Timeline);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });

  it('should refuse when the caller is an editor rather than the owner', async () => {
    const { sut, ctx } = setup();
    const { album, elevated } = await seed(ctx);
    const { user: editor } = await ctx.newUser();
    await ctx.newAlbumUser({ albumId: album.id, userId: editor.id, role: AlbumUserRole.Editor });
    const editorAuth = factory.auth({ user: editor, session: { hasElevatedPermission: true } });

    // Shared, so this trips the unshare guard for the owner too - the point here is the editor is
    // refused on ownership grounds regardless of that.
    await expect(sut.setLocked(editorAuth, album.id, { isLocked: true })).rejects.toThrow(/owner|Unshare/);
    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    expect(elevated.user.id).not.toEqual(editor.id);
  });

  it('should be a no-op when the album is already in the requested state', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated } = await seed(ctx);

    await sut.setLocked(elevated, album.id, { isLocked: false });

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });

  it('should lock an empty album without complaint', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(isLocked(ctx, album.id)).resolves.toBe(true);
  });

  // Locking rewrites the visibility of every member asset, so every client holding those rows is now
  // wrong. `AlbumUpdate` is what tells them: it becomes the `on_album_update` websocket message, which
  // mobile maps onto a sync. Without it the change needed an app restart to appear.
  it('should tell the clients the album changed', async () => {
    const { sut, ctx } = setup();
    const { user, album, elevated } = await seed(ctx);

    await sut.setLocked(elevated, album.id, { isLocked: true });

    expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AlbumUpdate', {
      id: album.id,
      userIds: [user.id],
      // Empty on purpose: this field drives the "album updated" email, and the owner does not need
      // mailing about their own edit.
      recipientIds: [],
    });
  });

  // A locked album may only hold locked assets, and locking an asset evicts it from every album -- so
  // "put this timeline photo in my locked album" was two operations that could not be expressed
  // together. This route is the one operation, and these assert the whole of it: the photo ends up
  // locked, in this album, and out of the album it came from.
  describe('moving timeline assets straight into a locked album', () => {
    it('should lock the assets, add them, and take them out of their other albums', async () => {
      const { sut, ctx } = setup();
      const { user, album, assets, elevated } = await seed(ctx);
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });

      const results = await sut.addLockedAssets(elevated, locked.id, { ids: [assets[0].id] });

      expect(results).toEqual([{ id: assets[0].id, success: true }]);
      await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Locked);
      await expect(ctx.get(AlbumRepository).getAssetIds(locked.id, [assets[0].id])).resolves.toEqual(
        new Set([assets[0].id]),
      );
      // The invariant that makes locking mean anything: album membership grants asset reads, so the
      // photo must not still be reachable through the ordinary album it came from.
      await expect(ctx.get(AlbumRepository).getAssetIds(album.id, [assets[0].id])).resolves.toEqual(new Set());
    });

    it('should refuse without an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user, assets, plain } = await seed(ctx);
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });

      // Two gates catch this and the access layer gets there first: `AlbumAssetCreate` resolves through
      // `excludeLockedAlbumsUnlessElevated`, so an unelevated session cannot see the locked album at
      // all. The `requireElevatedPermission` below it is what would answer if that ever widened.
      // Matching either keeps the test about the refusal rather than about which layer won.
      await expect(sut.addLockedAssets(plain, locked.id, { ids: [assets[0].id] })).rejects.toThrow(
        /Elevated permission|albumAsset\.create access/,
      );

      await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
    });

    // The ordinary add endpoint exists for this and locks nothing. Falling back to it here would make
    // the route a way to lock photos by accident.
    it('should refuse an album that is not locked', async () => {
      const { sut, ctx } = setup();
      const { album, assets, elevated } = await seed(ctx);

      await expect(sut.addLockedAssets(elevated, album.id, { ids: [assets[0].id] })).rejects.toThrow('not locked');

      await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
    });

    // Locking someone else's photo hides it from them. Refuse the request rather than dropping the
    // offending asset from the results, which would report partial success as success.
    it('should refuse assets the caller does not own, without moving the ones they do', async () => {
      const { sut, ctx } = setup();
      const { user, assets, elevated } = await seed(ctx);
      const { user: other } = await ctx.newUser();
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });

      await expect(sut.addLockedAssets(elevated, locked.id, { ids: [assets[0].id, theirs.id] })).rejects.toThrow(
        'assets you own',
      );

      await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
      await expect(visibilityOf(ctx, theirs.id)).resolves.toBe(AssetVisibility.Timeline);
    });

    it('should report an asset already in the album as a duplicate rather than failing', async () => {
      const { sut, ctx } = setup();
      const { user, assets, elevated } = await seed(ctx);
      const { album: locked } = await ctx.newAlbum({ ownerId: user.id, isLocked: true });
      await sut.addLockedAssets(elevated, locked.id, { ids: [assets[0].id] });

      const results = await sut.addLockedAssets(elevated, locked.id, { ids: [assets[0].id] });

      expect(results).toEqual([{ id: assets[0].id, success: false, error: BulkIdErrorReason.DUPLICATE }]);
    });
  });

  // The refusal above only held at the moment of locking. `Permission.AlbumShare` resolves through
  // `forViewer`, so an elevated owner passed it for a locked album and could invite someone afterwards -
  // producing the one state the clients then refused to unlock.
  it('should refuse to share an album that is already locked', async () => {
    const { sut, ctx } = setup();
    const { album, elevated } = await seed(ctx);
    const { user: guest } = await ctx.newUser();
    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(
      sut.addUsers(elevated, album.id, { albumUsers: [{ userId: guest.id, role: AlbumUserRole.Viewer }] }),
    ).rejects.toThrow('A locked album cannot be shared');
  });

  // Sharing blocks locking, never unlocking, and both clients now follow that. Pinned because the state
  // still exists on any instance that predates the refusal above, and it must not be a dead end: the way
  // out of a shared locked album is to unlock it.
  it('should still unlock an album that is shared', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated } = await seed(ctx);
    const { user: guest } = await ctx.newUser();
    await sut.setLocked(elevated, album.id, { isLocked: true });
    // Straight to the fixture rather than through addUsers, which now refuses exactly this.
    await ctx.newAlbumUser({ albumId: album.id, userId: guest.id, role: AlbumUserRole.Viewer });

    await sut.setLocked(elevated, album.id, { isLocked: false });

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });
});
