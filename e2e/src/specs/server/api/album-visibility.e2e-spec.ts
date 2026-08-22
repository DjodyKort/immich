import {
  AlbumResponseDto,
  AssetSurface,
  AssetVisibility,
  LoginResponseDto,
  getAllAlbums,
  lockAuthSession,
  setupPinCode,
  unlockAuthSession,
} from '@immich/sdk';
import { createUserDto } from 'src/fixtures';
import { app, asBearerAuth, utils } from 'src/utils';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * `hiddenFrom` comes back in whatever order the server produced it, so both sides are sorted before
 * comparing. Explicit rather than a bare `sort()`: the default sorts by string coercion, which is
 * only accidentally right for these values and is what `unicorn/require-array-sort-compare` objects
 * to. `toSorted` also leaves the response body untouched, so a later assertion sees what arrived.
 */
const byName = (a: AssetSurface, b: AssetSurface) => a.localeCompare(b);

/**
 * The two routes this fork added to the album API, over real HTTP.
 *
 * `PUT /albums/:id/locked` and `PUT /albums/:id/hidden-from` are covered by medium tests at the
 * service layer, which is where the interesting refusals live. What those cannot see is the layer
 * this exercises: routing, the DTOs, the auth guard, session elevation as an actual header-carrying
 * session rather than a constructed `AuthDto`, and -- for the rule -- the database triggers that
 * recompute every member's inherited mask.
 *
 * Both are round trips on purpose. Setting a rule and finding the photo gone proves half of it; the
 * half that matters as much is that unsetting brings it back, because a visibility feature that
 * cannot be undone is a way to lose photos.
 */

const PIN = '123456';

describe('album visibility', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  const authOf = (session: LoginResponseDto) => asBearerAuth(session.accessToken);

  // Elevation is a property of the session and outlives the test that asked for it, so the two are
  // kept separate: the PIN is set once in beforeAll, and each test states which side of the gate it
  // wants. A test that assumed "not elevated by default" would pass or fail on execution order.
  const elevate = (session: LoginResponseDto) =>
    unlockAuthSession({ sessionUnlockDto: { pinCode: PIN } }, { headers: authOf(session) });

  const dropElevation = (session: LoginResponseDto) => lockAuthSession({ headers: authOf(session) });

  const albumWithOneAsset = async (session: LoginResponseDto): Promise<[AlbumResponseDto, string]> => {
    const asset = await utils.createAsset(session.accessToken);
    const album = await utils.createAlbum(session.accessToken, {
      albumName: 'visibility',
      assetIds: [asset.id],
    });

    return [album, asset.id];
  };

  /** A locked asset that is in no album, which is the only kind `POST /albums` may assemble. */
  const looseLockedAsset = async (session: LoginResponseDto) => {
    const asset = await utils.createAsset(session.accessToken);
    await request(app)
      .put(`/assets/${asset.id}`)
      .set('Authorization', `Bearer ${session.accessToken}`)
      .send({ visibility: AssetVisibility.Locked });

    return asset.id;
  };

  const visibilityOf = async (session: LoginResponseDto, assetId: string) => {
    const { body } = await request(app).get(`/assets/${assetId}`).set('Authorization', `Bearer ${session.accessToken}`);
    return body.visibility;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.create('album-visibility'));

    for (const session of [admin, user]) {
      await setupPinCode({ pinCodeSetupDto: { pinCode: PIN } }, { headers: authOf(session) });
    }
  });

  describe('PUT /albums/:id/locked', () => {
    it('should move the album and its photos into the locked folder and back out again', async () => {
      const [album, assetId] = await albumWithOneAsset(user);
      await elevate(user);

      const locked = await request(app)
        .put(`/albums/${album.id}/locked`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ isLocked: true });

      expect(locked.status).toBe(200);
      expect(locked.body).toMatchObject({ id: album.id, isLocked: true });
      await expect(visibilityOf(user, assetId)).resolves.toBe(AssetVisibility.Locked);

      const unlocked = await request(app)
        .put(`/albums/${album.id}/locked`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ isLocked: false });

      expect(unlocked.status).toBe(200);
      expect(unlocked.body).toMatchObject({ id: album.id, isLocked: false });
      // Back to Timeline rather than to whatever it was before: `visibility` is one exclusive column,
      // so locking overwrote any archive state and there is nowhere it was kept. Same behaviour as the
      // single-asset "remove from locked folder" action.
      await expect(visibilityOf(user, assetId)).resolves.toBe(AssetVisibility.Timeline);
    });

    it('should refuse without an elevated session', async () => {
      const [album] = await albumWithOneAsset(user);
      await dropElevation(user);

      const { status } = await request(app)
        .put(`/albums/${album.id}/locked`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ isLocked: true });

      // 401, not 400: setLocked used to hand-roll this check and answer 400 with its own message.
      // 6ee008717 moved it to upstream's requireElevatedPermission, which is what its eight other
      // call sites use, and that answers 401 'Elevated permission is required'.
      expect(status).toBe(401);
    });

    it('should refuse someone who is not the owner', async () => {
      const [album] = await albumWithOneAsset(user);
      await elevate(admin);

      const { status } = await request(app)
        .put(`/albums/${album.id}/locked`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ isLocked: true });

      // Not 403: the album is simply not visible to another user, so it never reaches the owner check.
      expect(status).toBe(400);
    });
  });

  describe('POST /albums with isLocked', () => {
    it('should assemble a locked album out of loose locked assets', async () => {
      await elevate(user);
      const assetId = await looseLockedAsset(user);

      const { status, body } = await request(app)
        .post('/albums')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ albumName: 'assembled', assetIds: [assetId], isLocked: true });

      expect(status).toBe(201);
      expect(body).toMatchObject({ isLocked: true });
      await expect(getAllAlbums({ assetId }, { headers: authOf(user) })).resolves.toHaveLength(1);
    });

    // The regression this exists for. An asset belongs to at most one locked album at a time --
    // `addAssets` has enforced that from the start, and this route did not, while
    // `AlbumRepository.create` inserts its `album_asset` rows unconditionally. So creating a second
    // locked album out of the first one's contents silently put those assets in both, which is
    // exactly the state the rule prevents everywhere else.
    //
    // Reachable from both clients without either doing anything wrong: the locked folder lists every
    // locked asset, members of locked albums included, and both offer "create a locked album from
    // this selection" over that list.
    it('should refuse assets that are already in another locked album', async () => {
      const [album, assetId] = await albumWithOneAsset(user);
      await elevate(user);
      await request(app)
        .put(`/albums/${album.id}/locked`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ isLocked: true });

      const { status } = await request(app)
        .post('/albums')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ albumName: 'second home', assetIds: [assetId], isLocked: true });

      expect(status).toBe(400);
      // The assertion that would have caught the bug. Refusing with a 400 and creating the album
      // anyway would satisfy the line above; membership is what the invariant is actually about.
      const albums = await getAllAlbums({ assetId }, { headers: authOf(user) });
      expect(albums.map(({ id }) => id)).toEqual([album.id]);
    });
  });

  describe('PUT /albums/:id/hidden-from', () => {
    it('should round trip a rule through the album response', async () => {
      const [album] = await albumWithOneAsset(user);

      const set = await request(app)
        .put(`/albums/${album.id}/hidden-from`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ hiddenFrom: [AssetSurface.Timeline, AssetSurface.Search] });

      expect(set.status).toBe(200);
      expect(set.body.hiddenFrom.toSorted(byName)).toEqual(
        [AssetSurface.Search, AssetSurface.Timeline].toSorted(byName),
      );

      // Read back through a different route, so this is the stored rule rather than the echo of the
      // request body.
      const albums = await getAllAlbums({}, { headers: authOf(user) });
      expect(albums.find(({ id }) => id === album.id)?.hiddenFrom.toSorted(byName)).toEqual(
        [AssetSurface.Search, AssetSurface.Timeline].toSorted(byName),
      );
    });

    it('should take the album photos off the timeline, and give them back when the rule is lifted', async () => {
      const [album] = await albumWithOneAsset(user);

      // Counted through the buckets rather than fetched by id: the bucket queries are what the
      // timeline actually asks, and they are the surface the mask is applied on. An asset still
      // readable by `GET /assets/:id` but absent from every bucket is exactly the intended state.
      const timelineCount = async () => {
        const { body } = await request(app)
          .get('/timeline/buckets')
          .query({ visibility: AssetVisibility.Timeline })
          .set('Authorization', `Bearer ${user.accessToken}`);
        return (body as { count: number }[]).reduce((total, bucket) => total + bucket.count, 0);
      };

      const before = await timelineCount();
      expect(before).toBeGreaterThan(0);

      await request(app)
        .put(`/albums/${album.id}/hidden-from`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ hiddenFrom: [AssetSurface.Timeline] });

      await expect(timelineCount()).resolves.toBe(before - 1);

      // The half that matters as much: the database triggers recompute from current membership, so
      // clearing the rule has to restore the photo rather than leave it stranded.
      await request(app)
        .put(`/albums/${album.id}/hidden-from`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ hiddenFrom: [] });

      await expect(timelineCount()).resolves.toBe(before);
    });

    it('should refuse someone who is not the owner', async () => {
      const [album] = await albumWithOneAsset(user);

      const { status } = await request(app)
        .put(`/albums/${album.id}/hidden-from`)
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ hiddenFrom: [AssetSurface.Timeline] });

      expect(status).toBe(400);
    });
  });
});
