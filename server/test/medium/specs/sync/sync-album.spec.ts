import { Kysely } from 'kysely';
import { AlbumUserRole, SyncEntityType, SyncRequestType } from 'src/enum';
import { AlbumUserRepository } from 'src/repositories/album-user.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { DB } from 'src/schema';
import { SyncTestContext } from 'test/medium.factory';
import { getKyselyDB } from 'test/utils';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncRequestType.AlbumsV1, () => {
  it('should sync an album with the correct properties', async () => {
    const { auth, ctx } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
          name: album.albumName,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  it('should detect and sync a new album', async () => {
    const { auth, ctx } = await setup();
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  it('should detect and sync an album delete', async () => {
    const { auth, ctx } = await setup();
    const albumRepo = ctx.get(AlbumRepository);
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: album.id,
        }),
        type: SyncEntityType.AlbumV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await albumRepo.delete(album.id);

    const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
    expect(newResponse).toEqual([
      {
        ack: expect.any(String),
        data: {
          albumId: album.id,
        },
        type: SyncEntityType.AlbumDeleteV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, newResponse);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
  });

  describe('shared albums', () => {
    it('should detect and sync an album create', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album share (share before sync)', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album share (share after sync)', async () => {
      const { auth, ctx } = await setup();
      const { user: user2 } = await ctx.newUser();
      const { album: userAlbum } = await ctx.newAlbum({ ownerId: auth.user.id });
      const { album: user2Album } = await ctx.newAlbum({ ownerId: user2.id });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: userAlbum.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.newAlbumUser({ userId: auth.user.id, albumId: user2Album.id, role: AlbumUserRole.Editor });

      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: expect.objectContaining({ id: user2Album.id }),
          type: SyncEntityType.AlbumV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album delete`', async () => {
      const { auth, ctx } = await setup();
      const albumRepo = ctx.get(AlbumRepository);
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumV1 }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);

      await albumRepo.delete(album.id);
      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: { albumId: album.id },
          type: SyncEntityType.AlbumDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });

    it('should detect and sync an album unshare as an album delete', async () => {
      const { auth, ctx } = await setup();
      const albumUserRepo = ctx.get(AlbumUserRepository);
      const { user: user2 } = await ctx.newUser();
      const { album } = await ctx.newAlbum({ ownerId: user2.id });
      await ctx.newAlbumUser({ albumId: album.id, userId: auth.user.id, role: AlbumUserRole.Editor });

      const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(response).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumV1 }),
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, response);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);

      await albumUserRepo.delete({ albumId: album.id, userId: auth.user.id });
      const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV1]);
      expect(newResponse).toEqual([
        {
          ack: expect.any(String),
          data: { albumId: album.id },
          type: SyncEntityType.AlbumDeleteV1,
        },
        expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
      ]);

      await ctx.syncAckAll(auth, newResponse);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AlbumsV1]);
    });
  });
});

describe(SyncRequestType.AlbumsV2, () => {
  // The V1 assertions above all use `objectContaining`, so a field silently missing from the V2
  // payload breaks nothing here and shows up only as a client that thinks every album is unlocked and
  // unhidden. `isLocked` and `isHidden` are selected in the repository and declared in the DTO
  // separately, so the two can drift apart; these pin the whole path from column to stream.
  it('should carry isLocked and isHidden through to the stream', async () => {
    const { auth, ctx } = await setup();
    const { album: plain } = await ctx.newAlbum({ ownerId: auth.user.id });
    const { album: locked } = await ctx.newAlbum({ ownerId: auth.user.id, isLocked: true });
    const { album: hidden } = await ctx.newAlbum({ ownerId: auth.user.id, isHidden: true });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    const flags = Object.fromEntries(
      response
        .filter((item) => item.type === SyncEntityType.AlbumV2)
        .map((item) => {
          const data = item.data as { id: string; isLocked: boolean; isHidden: boolean };
          return [data.id, { isLocked: data.isLocked, isHidden: data.isHidden }];
        }),
    );

    expect(flags).toEqual({
      [plain.id]: { isLocked: false, isHidden: false },
      [locked.id]: { isLocked: true, isHidden: false },
      [hidden.id]: { isLocked: false, isHidden: true },
    });
  });

  it('should carry a change to isHidden through on a later sync', async () => {
    const { auth, ctx } = await setup();
    const albumRepo = ctx.get(AlbumRepository);
    const { album } = await ctx.newAlbum({ ownerId: auth.user.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    expect(response).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: album.id, isHidden: false }) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, response);

    await albumRepo.update(album.id, { isHidden: true }, auth.user.id);
    const newResponse = await ctx.syncStream(auth, [SyncRequestType.AlbumsV2]);
    expect(newResponse).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ id: album.id, isHidden: true }) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});
