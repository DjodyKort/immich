import { Kysely } from 'kysely';
import { AssetSurface, AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { EventRepository } from 'src/repositories/event.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { UserRepository } from 'src/repositories/user.repository';
import { DB } from 'src/schema';
import { AlbumService } from 'src/services/album.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Which albums appear in the album list.
 *
 * Two independent reasons an album can be absent, kept separate on purpose:
 *
 * - `isHidden` is tidiness. Toggleable at any time, no PIN, and the album stays reachable by its own
 *   URL, from an asset's "in albums" list, and through the hidden listing. Hiding is not losing.
 * - `isLocked` is confidentiality. Set only at creation, and the album is invisible - name, cover and
 *   all - until the session has elevated. Previously a locked album sat in the list wearing a padlock,
 *   which told anyone holding the phone that it exists.
 *
 * The combination matters: asking for hidden albums must not become a way to enumerate locked ones.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) =>
  newMediumService(AlbumService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AlbumRepository, AssetRepository, UserRepository],
    mock: [LoggingRepository, EventRepository],
  });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const names = (albums: Array<{ albumName: string }>) => albums.map(({ albumName }) => albumName).sort();

describe('album list visibility', () => {
  it('should leave a hidden album out of the list, and list it when asked for hidden ones', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });

    await ctx.newAlbum({ ownerId: user.id, albumName: 'visible' });
    const { album: hidden } = await ctx.newAlbum({ ownerId: user.id, albumName: 'tidied away' });
    await sut.update(auth, hidden.id, { isHidden: true });

    expect(names(await sut.getAll(auth, {}))).toEqual(['visible']);
    expect(names(await sut.getAll(auth, { hidden: true }))).toEqual(['tidied away']);
  });

  it('should be reversible, since hiding is about tidiness rather than confidentiality', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'back again' });

    await sut.update(auth, album.id, { isHidden: true });
    expect(names(await sut.getAll(auth, {}))).toEqual([]);

    await sut.update(auth, album.id, { isHidden: false });
    expect(names(await sut.getAll(auth, {}))).toEqual(['back again']);
  });

  it('should keep a hidden album reachable directly, so hiding cannot lose it', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'still here' });
    await sut.update(auth, album.id, { isHidden: true });

    // The guarantee. Absent from the list, present when asked for by id.
    const fetched = await sut.get(auth, album.id);
    expect(fetched.albumName).toBe('still here');
    expect(fetched.isHidden).toBe(true);
  });

  it('should hide a locked album entirely until the session is elevated', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const notElevated = factory.auth({ user });
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

    await ctx.newAlbum({ ownerId: user.id, albumName: 'ordinary' });
    await sut.create(elevated, { albumName: 'private', isLocked: true });

    // Not just its contents: its existence.
    expect(names(await sut.getAll(notElevated, {}))).toEqual(['ordinary']);
    expect(names(await sut.getAll(elevated, {}))).toEqual(['ordinary', 'private']);
  });

  it('should not let the hidden listing reveal a locked album', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const notElevated = factory.auth({ user });
    const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

    const created = await sut.create(elevated, { albumName: 'locked and hidden', isLocked: true });
    await sut.update(elevated, created.id, { isHidden: true });

    // Asking for hidden albums is not a back door around elevation.
    expect(names(await sut.getAll(notElevated, { hidden: true }))).toEqual([]);
    expect(names(await sut.getAll(elevated, { hidden: true }))).toEqual(['locked and hidden']);
  });

  describe("an asset's own album list", () => {
    // `?assetId=` takes a different repository method than the listing above, so the two rules have to
    // be stated again here rather than inherited.
    it('should still show a hidden album, which is what makes hiding safe', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'findable' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });
      await sut.update(auth, album.id, { isHidden: true });

      expect(names(await sut.getAll(auth, {}))).toEqual([]);
      expect(names(await sut.getAll(auth, { assetId: asset.id }))).toEqual(['findable']);
    });

    it('should not reveal a locked album to an unelevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const notElevated = factory.auth({ user });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'private', isLocked: true });
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

      // Knowing an asset id must not be a way around elevation. Nothing enumerates a locked asset
      // unelevated, but an id learned before locking, or from a shared link, would otherwise have
      // disclosed the album's name here.
      expect(names(await sut.getAll(notElevated, { assetId: asset.id }))).toEqual([]);
      expect(names(await sut.getAll(elevated, { assetId: asset.id }))).toEqual(['private']);
    });
  });
});

// An album's rule reaches every photo in it, through the database triggers that recompute
// `hiddenFromInherited`. Those asset rows are what the timelines read, so every client holding them
// has to be told to re-read -- `AlbumUpdate` is the existing mechanism for that and this was the one
// album mutation that skipped it. The symptom was a rule change needing an app restart to show up.
describe('telling clients a rule changed', () => {
  it('should emit AlbumUpdate when the rule changes', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { album } = await ctx.newAlbum({ ownerId: user.id });

    await sut.setHiddenFrom(auth, album.id, { hiddenFrom: [AssetSurface.Timeline] });

    expect(ctx.getMock(EventRepository).emit).toHaveBeenCalledWith('AlbumUpdate', {
      id: album.id,
      userIds: [user.id],
      recipientIds: [],
    });
  });

  // Nothing changed, so nothing to re-read. `setHiddenFrom` returns early on an unchanged mask, and
  // that early return has to keep the event quiet or every no-op save would sync every client.
  it('should stay quiet when the rule is already what was asked for', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(EventRepository).emit.mockResolvedValue();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { album } = await ctx.newAlbum({ ownerId: user.id });

    await sut.setHiddenFrom(auth, album.id, { hiddenFrom: [] });

    expect(ctx.getMock(EventRepository).emit).not.toHaveBeenCalled();
  });
});
