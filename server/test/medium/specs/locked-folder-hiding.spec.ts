import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { DB } from 'src/schema';
import { TimelineService } from 'src/services/timeline.service';
import { getSurfaceBit, Surface } from 'src/utils/visibility-policy';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Hiding a locked asset from the locked-folder grid, while keeping it visible in a locked album.
 *
 * This is the behaviour the per-asset mask promised and did not deliver. The locked folder and the
 * archive view are the two grids that pin a visibility in the request, and the bucket queries only
 * applied the surface rule when no visibility was pinned:
 *
 *     .$if(!!options.visibility, qb => qb.where('asset.visibility', '=', options.visibility))
 *     .$if(options.visibility === undefined, qb => withSurface(qb, ...))
 *
 * Since `withSurface` is what carries the per-asset mask, those two views ignored it entirely. An
 * asset hidden from the timeline disappeared from the timeline and then turned up in the locked
 * folder, which is the opposite of what someone hiding a photo expects.
 *
 * The rule these tests pin: hiding from `timeline` removes an asset from every timeline-shaped grid,
 * and from no album. Album surfaces have no user-facing name, so `hiddenFrom` cannot name them; that
 * is what makes "hidden from the locked folder, still in my locked album" expressible at all.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) =>
  newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    // The service takes a logger in its constructor, so an unmocked one fails on setContext.
    mock: [LoggingRepository],
  });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

// A Date rather than a string, mirroring visibility-matrix.spec.ts.
const BUCKET_DATE = new Date('2026-08-15');

const seed = async (ctx: Awaited<ReturnType<typeof setup>>['ctx'], hiddenFrom: number | null) => {
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    visibility: AssetVisibility.Locked,
    fileCreatedAt: BUCKET_DATE,
    localDateTime: BUCKET_DATE,
    hiddenFrom,
  });
  await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

  // Elevated: without it the locked folder is not reachable at all, so a non-elevated run would pass
  // for the wrong reason.
  const auth = factory.auth({ user: { id: user.id }, session: { hasElevatedPermission: true } });
  return { auth, albumId: album.id, assetId: asset.id };
};

const countIn = (buckets: Array<{ count: number }>) => buckets.reduce((sum, bucket) => sum + bucket.count, 0);

// Asserted on the bucket *counts* rather than the bucket contents. Both are part of the same grid, and
// the counts query is the one that decides whether a month appears at all, so it is the honest signal
// for "is this photo in this view". The contents query additionally joins fixture data this minimal
// seed does not create, which would make a failure here ambiguous rather than informative.
describe('hiding a locked asset from the locked folder', () => {
  it('should keep a locked asset out of the locked folder when it is hidden from the timeline', async () => {
    const { sut, ctx } = setup();
    const { auth } = await seed(ctx, getSurfaceBit(Surface.Timeline)!);

    // The locked folder is the timeline with visibility pinned to locked.
    const buckets = await sut.getTimeBuckets(auth, { visibility: AssetVisibility.Locked });
    expect(countIn(buckets)).toBe(0);
  });

  it('should still show it inside a locked album', async () => {
    const { sut, ctx } = setup();
    const { auth, albumId } = await seed(ctx, getSurfaceBit(Surface.Timeline)!);

    // Album buckets ask for Surface.AlbumTimeline, whose bit no user-facing surface maps to, so the mask
    // cannot reach it. That is what makes "hidden from the locked folder, still in my locked album"
    // expressible rather than contradictory.
    const buckets = await sut.getTimeBuckets(auth, { albumId });
    expect(countIn(buckets)).toBe(1);
  });

  it('should show an unhidden locked asset in both, so the tests above cannot pass vacuously', async () => {
    const { sut, ctx } = setup();
    const { auth, albumId } = await seed(ctx, null);

    expect(countIn(await sut.getTimeBuckets(auth, { visibility: AssetVisibility.Locked }))).toBe(1);
    expect(countIn(await sut.getTimeBuckets(auth, { albumId }))).toBe(1);
  });
});
