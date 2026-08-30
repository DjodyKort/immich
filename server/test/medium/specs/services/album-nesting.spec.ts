import { Kysely } from 'kysely';
import { AlbumUserRole, AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetLockRestoreRepository } from 'src/repositories/asset-lock-restore.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { JobRepository } from 'src/repositories/job.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { ALBUM_MAX_DEPTH, AlbumNestingError } from 'src/utils/album.util';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Albums inside albums.
 *
 * The rule the locked cases enforce is asymmetric on purpose: *a public folder may hold a private
 * item; a private folder holds only private items.* Locked flows **down** a tree and never up. So a
 * locked album inside a normal one is allowed -- it is the case people actually want, and every child
 * listing already runs through `excludeLockedAlbumsUnlessElevated` -- while a normal album inside a
 * locked one is refused, because that would be an ordinary branch hanging off a private one.
 *
 * Nothing here cascades. Re-parenting never locks or unlocks anything, because doing so would move
 * photos between the locked folder and the timeline in albums the user never named -- the same class
 * of surprise `setLocked` refuses to inflict.
 */
let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const made = newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetLockRestoreRepository,
      AssetRepository,
      SharedLinkRepository,
      UserRepository,
    ],
    mock: [LoggingRepository, JobRepository, EventRepository],
  });

  made.ctx.getMock(JobRepository).queueAll.mockResolvedValue();
  made.ctx.getMock(EventRepository).emit.mockResolvedValue();

  return made;
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

type Ctx = Awaited<ReturnType<typeof setup>>['ctx'];

const parentOf = async (ctx: Ctx, id: string) => {
  const row = await ctx.database.selectFrom('album').select('parentId').where('id', '=', id).executeTakeFirstOrThrow();
  return row.parentId;
};

const isLocked = async (ctx: Ctx, id: string) => {
  const row = await ctx.database.selectFrom('album').select('isLocked').where('id', '=', id).executeTakeFirstOrThrow();
  return row.isLocked;
};

const visibilityOf = async (ctx: Ctx, id: string) => {
  const row = await ctx.database
    .selectFrom('asset')
    .select('visibility')
    .where('id', '=', id)
    .executeTakeFirstOrThrow();
  return row.visibility;
};

/** A user with two ordinary top-level albums. */
const seed = async (ctx: Ctx) => {
  const { user } = await ctx.newUser();
  const { album: parent } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Holidays' });
  const { album: child } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Italy 2025' });
  const { asset: first } = await ctx.newAsset({ ownerId: user.id });
  const { asset: second } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newAlbumAsset({ albumId: parent.id, assetId: first.id });
  await ctx.newAlbumAsset({ albumId: parent.id, assetId: second.id });
  return {
    user,
    parent,
    child,
    assets: [first, second],
    auth: factory.auth({ user, session: { hasElevatedPermission: true } }),
  };
};

describe('moving an album', () => {
  it('should nest an album under another', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);

    await sut.setParent(auth, child.id, { parentId: parent.id });

    await expect(parentOf(ctx, child.id)).resolves.toBe(parent.id);
  });

  it('should move an album back to the top level', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    await sut.setParent(auth, child.id, { parentId: null });

    await expect(parentOf(ctx, child.id)).resolves.toBeNull();
  });

  it('should report the child count', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    await expect(sut.get(auth, parent.id)).resolves.toMatchObject({ childCount: 1 });
    await expect(sut.get(auth, child.id)).resolves.toMatchObject({ childCount: 0, parentId: parent.id });
  });
});

describe('refusing a tree that cannot exist', () => {
  it('should refuse an album as its own parent', async () => {
    const { sut, ctx } = setup();
    const { child, auth } = await seed(ctx);

    await expect(sut.setParent(auth, child.id, { parentId: child.id })).rejects.toThrow(AlbumNestingError.SelfParent);
  });

  it('should refuse moving an album inside its own sub-album', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    await expect(sut.setParent(auth, parent.id, { parentId: child.id })).rejects.toThrow(AlbumNestingError.Cycle);
  });

  // Two levels down, not one: a one-level cycle is caught by the self-parent check, so this is the
  // case that actually exercises the ancestor walk.
  it('should refuse a cycle through a grandchild', async () => {
    const { sut, ctx } = setup();
    const { user, parent, child, auth } = await seed(ctx);
    const { album: grandchild } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Rome' });
    await sut.setParent(auth, child.id, { parentId: parent.id });
    await sut.setParent(auth, grandchild.id, { parentId: child.id });

    await expect(sut.setParent(auth, parent.id, { parentId: grandchild.id })).rejects.toThrow(AlbumNestingError.Cycle);
  });

  it('should refuse a tree deeper than the cap', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

    let previousId: string | null = null;
    const ids: string[] = [];
    for (let depth = 0; depth < ALBUM_MAX_DEPTH; depth++) {
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: `level ${depth}` });
      ids.push(album.id);
      if (previousId) {
        await sut.setParent(auth, album.id, { parentId: previousId });
      }
      previousId = album.id;
    }

    const { album: overflow } = await ctx.newAlbum({ ownerId: user.id, albumName: 'one too many' });
    await expect(sut.setParent(auth, overflow.id, { parentId: previousId! })).rejects.toThrow(
      AlbumNestingError.TooDeep,
    );
    expect(ids).toHaveLength(ALBUM_MAX_DEPTH);
  });

  // The moving album brings its subtree with it, so a move that looks shallow can still overflow.
  it('should count the moving album’s own descendants towards the depth cap', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });

    // A chain of ALBUM_MAX_DEPTH - 1 albums, then a two-deep branch moved onto its tip.
    let tip: string | null = null;
    for (let depth = 0; depth < ALBUM_MAX_DEPTH - 1; depth++) {
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: `chain ${depth}` });
      if (tip) {
        await sut.setParent(auth, album.id, { parentId: tip });
      }
      tip = album.id;
    }

    const { album: branchRoot } = await ctx.newAlbum({ ownerId: user.id, albumName: 'branch' });
    const { album: branchLeaf } = await ctx.newAlbum({ ownerId: user.id, albumName: 'leaf' });
    await sut.setParent(auth, branchLeaf.id, { parentId: branchRoot.id });

    await expect(sut.setParent(auth, branchRoot.id, { parentId: tip! })).rejects.toThrow(AlbumNestingError.TooDeep);
  });

  it('should refuse another user’s album as the parent', async () => {
    const { sut, ctx } = setup();
    const { child, auth } = await seed(ctx);
    const { user: stranger } = await ctx.newUser();
    const { album: theirs } = await ctx.newAlbum({ ownerId: stranger.id, albumName: 'Not yours' });

    await expect(sut.setParent(auth, child.id, { parentId: theirs.id })).rejects.toThrow(
      AlbumNestingError.DifferentOwner,
    );
  });
});

describe('locked flows down, never up', () => {
  // The case the asymmetry exists for. A private album inside an ordinary one is allowed, because
  // every listing already withholds locked albums from an unelevated session.
  it('should allow a locked album inside a normal album', async () => {
    const { sut, ctx } = setup();
    const { user, parent, auth } = await seed(ctx);
    const { album: locked } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Honeymoon', isLocked: true });

    await sut.setParent(auth, locked.id, { parentId: parent.id });

    await expect(parentOf(ctx, locked.id)).resolves.toBe(parent.id);
  });

  it('should refuse a normal album inside a locked album', async () => {
    const { sut, ctx } = setup();
    const { user, child, auth } = await seed(ctx);
    const { album: locked } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Private', isLocked: true });

    await expect(sut.setParent(auth, child.id, { parentId: locked.id })).rejects.toThrow(
      AlbumNestingError.UnlockedIntoLocked,
    );
  });

  it('should allow a locked album inside a locked album', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const { album: outer } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Private', isLocked: true });
    const { album: inner } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Inner', isLocked: true });

    await sut.setParent(auth, inner.id, { parentId: outer.id });

    await expect(parentOf(ctx, inner.id)).resolves.toBe(outer.id);
  });

  // Refused rather than cascaded: unlocking the parent too would return every sibling's photos to the
  // timeline, in albums the user never named.
  it('should refuse to unlock an album that sits inside a locked album', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const { album: outer } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Private', isLocked: true });
    const { album: inner } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Inner', isLocked: true });
    await sut.setParent(auth, inner.id, { parentId: outer.id });

    await expect(sut.setLocked(auth, inner.id, { isLocked: false })).rejects.toThrow(
      AlbumNestingError.UnlockChildOfLocked,
    );
  });

  it('should still unlock a locked album that sits inside a normal album', async () => {
    const { sut, ctx } = setup();
    const { user, parent, auth } = await seed(ctx);
    const { album: locked } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Honeymoon', isLocked: true });
    await sut.setParent(auth, locked.id, { parentId: parent.id });

    await sut.setLocked(auth, locked.id, { isLocked: false });

    const row = await ctx.database
      .selectFrom('album')
      .select(['isLocked', 'parentId'])
      .where('id', '=', locked.id)
      .executeTakeFirstOrThrow();
    expect(row.isLocked).toBe(false);
    // Still where the user put it -- unlocking is not a move.
    expect(row.parentId).toBe(parent.id);
  });
});

describe('deleting a parent', () => {
  // Soft delete deliberately leaves `parentId` alone, so restoring the parent re-nests its children
  // exactly as they were. Meanwhile the trashed parent drops out of the album list while its child
  // stays in it -- which is what makes the child render at the top level rather than disappearing
  // with its folder. The client builds the tree from that list, so a child whose parent is absent
  // has nowhere to hang but the root.
  it('should keep the link through trash and restore, while the child stays listed', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    // Straight to the column: `softDeleteAll` takes a user, not an album, and this is about one album.
    await ctx.database.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', parent.id).execute();

    await expect(parentOf(ctx, child.id)).resolves.toBe(parent.id);
    const whileTrashed = await sut.getAll(auth, {});
    const listedIds = whileTrashed.map(({ id }) => id);
    expect(listedIds).toContain(child.id);
    expect(listedIds).not.toContain(parent.id);

    await ctx.database.updateTable('album').set({ deletedAt: null }).where('id', '=', parent.id).execute();

    await expect(parentOf(ctx, child.id)).resolves.toBe(parent.id);
    await expect(ctx.get(AlbumRepository).getChildCounts([parent.id])).resolves.toEqual(new Map([[parent.id, 1]]));
  });

  // SET NULL, not CASCADE: deleting a folder must never delete the albums inside it.
  it('should orphan the children to the top level when the parent is hard deleted', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    await ctx.get(AlbumRepository).delete(parent.id);

    await expect(parentOf(ctx, child.id)).resolves.toBeNull();
  });
});

/**
 * Locking a branch, and being told what that means first.
 *
 * A tree is locked or it is not; there is no half-locked branch. So an album with sub-albums is either
 * taken as a whole or refused -- and because "taken as a whole" moves photos out of the timeline and
 * out of every other album they belong to, there is a read-only way to ask what that would cost before
 * agreeing to it.
 *
 * Downward only, always. None of this ever reaches up to a parent or across to a sibling.
 */
describe('locking a branch', () => {
  it('refuses to lock an album that has sub-albums, unless the branch is named', async () => {
    const { sut, ctx } = setup();
    const { parent, child, auth } = await seed(ctx);
    await sut.setParent(auth, child.id, { parentId: parent.id });

    await expect(sut.setLocked(auth, parent.id, { isLocked: true })).rejects.toThrow(
      AlbumNestingError.LockNeedsSubAlbums,
    );
  });

  it('locks the whole branch when asked', async () => {
    const { sut, ctx } = setup();
    const { user, parent, child, auth } = await seed(ctx);
    const { album: grandchild } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Rome' });
    await sut.setParent(auth, child.id, { parentId: parent.id });
    await sut.setParent(auth, grandchild.id, { parentId: child.id });

    await sut.setLocked(auth, parent.id, { isLocked: true, includeSubAlbums: true });

    for (const id of [parent.id, child.id, grandchild.id]) {
      await expect(isLocked(ctx, id)).resolves.toBe(true);
    }
  });

  // The property that makes the cascade safe to offer at all.
  it('never locks a parent or a sibling', async () => {
    const { sut, ctx } = setup();
    const { user, parent, child, auth } = await seed(ctx);
    const { album: sibling } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Japan 2026' });
    await sut.setParent(auth, child.id, { parentId: parent.id });
    await sut.setParent(auth, sibling.id, { parentId: parent.id });

    await sut.setLocked(auth, child.id, { isLocked: true });

    await expect(isLocked(ctx, child.id)).resolves.toBe(true);
    await expect(isLocked(ctx, parent.id)).resolves.toBe(false);
    await expect(isLocked(ctx, sibling.id)).resolves.toBe(false);
  });

  it('unlocks the whole branch, and restores what locking took', async () => {
    const { sut, ctx } = setup();
    const { user, parent, child, auth } = await seed(ctx);
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
    await ctx.newAlbumAsset({ albumId: child.id, assetId: asset.id });
    await sut.setParent(auth, child.id, { parentId: parent.id });
    await sut.setLocked(auth, parent.id, { isLocked: true, includeSubAlbums: true });

    await sut.setLocked(auth, parent.id, { isLocked: false, includeSubAlbums: true });

    await expect(isLocked(ctx, parent.id)).resolves.toBe(false);
    await expect(isLocked(ctx, child.id)).resolves.toBe(false);
    // Release 1's restore point is what makes the branch round-trip rather than flattening to timeline.
    await expect(visibilityOf(ctx, asset.id)).resolves.toBe(AssetVisibility.Archive);
  });

  describe('the impact preview', () => {
    it('counts the albums and photos the branch would take with it', async () => {
      const { sut, ctx } = setup();
      const { user, parent, child, assets, auth } = await seed(ctx);
      await sut.setParent(auth, child.id, { parentId: parent.id });
      const { asset: extra } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: child.id, assetId: extra.id });

      const impact = await sut.getLockImpact(auth, parent.id, true);

      expect(impact.albums.map(({ id }) => id).sort()).toEqual([parent.id, child.id].sort());
      expect(impact.assetCount).toBe(assets.length + 1);
      expect(impact.blockedReason).toBeNull();
    });

    // The number people are actually surprised by: not "852 photos move" but "41 of them leave albums
    // you did not name".
    it('names the other albums that would lose photos', async () => {
      const { sut, ctx } = setup();
      const { user, parent, assets, auth } = await seed(ctx);
      const { album: elsewhere } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Best of 2025' });
      await ctx.newAlbumAsset({ albumId: elsewhere.id, assetId: assets[0].id });

      const impact = await sut.getLockImpact(auth, parent.id, false);

      expect(impact.evictions).toEqual([{ id: elsewhere.id, albumName: 'Best of 2025', assetCount: 1 }]);
    });

    // The case a single-album branch cannot catch: with more than one album excluded, `!= any(...)`
    // would report the sub-albums themselves as collateral of their own locking.
    it('does not count the branch\u{2019}s own albums as albums losing photos', async () => {
      const { sut, ctx } = setup();
      const { user, parent, child, auth } = await seed(ctx);
      await sut.setParent(auth, child.id, { parentId: parent.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: child.id, assetId: asset.id });
      // The same asset in both the parent and the child, so each is "another album" for the other.
      await ctx.newAlbumAsset({ albumId: parent.id, assetId: asset.id });

      const impact = await sut.getLockImpact(auth, parent.id, true);

      expect(impact.evictions).toEqual([]);
    });

    it('reports a refusal rather than throwing, since the caller only asked', async () => {
      const { sut, ctx } = setup();
      const { parent, auth } = await seed(ctx);
      const { user: guest } = await ctx.newUser();
      await ctx.newAlbumUser({ albumId: parent.id, userId: guest.id, role: AlbumUserRole.Viewer });

      const impact = await sut.getLockImpact(auth, parent.id, false);

      expect(impact.blockedReason).toContain('Unshare');
    });
  });
});
