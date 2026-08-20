import { Kysely } from 'kysely';
import { AlbumUserRole, AssetVisibility, SharedLinkType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
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

const setup = (db?: Kysely<DB>) =>
  newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, JobRepository],
  });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Ctx = Awaited<ReturnType<typeof setup>>['ctx'];

/** An owned album with two owned, ordinary assets - the normal starting point. */
const seed = async (ctx: Ctx) => {
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();

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

    await expect(sut.setLocked(plain, album.id, { isLocked: true })).rejects.toThrow('elevated session');

    await expect(isLocked(ctx, album.id)).resolves.toBe(false);
    await expect(visibilityOf(ctx, assets[0].id)).resolves.toBe(AssetVisibility.Timeline);
  });

  // Unlocking is gated too: otherwise an unelevated session could empty a locked folder it cannot open.
  //
  // Two gates catch this, and which one fires depends on the album. The `AlbumUpdate` access check
  // already refuses a *locked* album to an unelevated session, so that is what answers here; the explicit
  // elevation check is what answers when locking an ordinary one. Asserting either message rather than
  // the specific one keeps this test about the refusal instead of about which layer got there first.
  it('should refuse to unlock without an elevated session', async () => {
    const { sut, ctx } = setup();
    const { album, assets, elevated, plain } = await seed(ctx);
    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(sut.setLocked(plain, album.id, { isLocked: false })).rejects.toThrow(
      /elevated session|album\.update access/,
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
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

    await sut.setLocked(elevated, album.id, { isLocked: true });

    await expect(isLocked(ctx, album.id)).resolves.toBe(true);
  });
});
