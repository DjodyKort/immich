import { Kysely } from 'kysely';
import { AssetSurface, AssetVisibility } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { AssetRepository } from 'src/repositories/asset.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { PartnerRepository } from 'src/repositories/partner.repository';
import { DB } from 'src/schema';
import { TimelineService } from 'src/services/timeline.service';
import { toHiddenFromMask } from 'src/utils/visibility-policy';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * The review view for per-asset hiding, and the guarantee it exists to provide.
 *
 * Every user-facing surface can be hidden from. Without one list that cannot, hiding an asset from all
 * six leaves it reachable only by already knowing its id: the file is safe, and the person cannot find
 * it. `Surface.HiddenReview` therefore has no `SURFACE_BIT`, exactly as `Surface.Trash` has none so
 * hiding cannot make an asset unrecoverable.
 *
 * The test that matters most here is the first one. If it ever fails, hiding has become a one-way door.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) =>
  newMediumService(TimelineService, {
    database: db || defaultDatabase,
    real: [AssetRepository, AccessRepository, PartnerRepository],
    mock: [LoggingRepository],
  });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const TAKEN = new Date('2026-08-15');

/** Every surface a user can name, which is the worst case this view has to survive. */
const EVERY_SURFACE = Object.values(AssetSurface);

const countIn = (buckets: Array<{ count: number }>) => buckets.reduce((sum, bucket) => sum + bucket.count, 0);

const seed = async (
  ctx: Awaited<ReturnType<typeof setup>>['ctx'],
  { visibility, surfaces }: { visibility: AssetVisibility; surfaces: AssetSurface[] },
) => {
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    visibility,
    fileCreatedAt: TAKEN,
    localDateTime: TAKEN,
    hiddenFrom: toHiddenFromMask(surfaces),
  });

  return { userId: user.id, assetId: asset.id };
};

describe('the hidden review view', () => {
  it('should still list an asset hidden from every surface a user can name', async () => {
    const { sut, ctx } = setup();
    const { userId } = await seed(ctx, { visibility: AssetVisibility.Timeline, surfaces: EVERY_SURFACE });
    const auth = factory.auth({ user: { id: userId } });

    // The whole point. Hidden everywhere else, still here.
    expect(countIn(await sut.getTimeBuckets(auth, { hidden: true }))).toBe(1);
    // And genuinely gone from the timeline, so the fixture is not lying about being hidden.
    expect(countIn(await sut.getTimeBuckets(auth, {}))).toBe(0);
  });

  it('should not list an asset that is hidden from nothing', async () => {
    const { sut, ctx } = setup();
    const { userId } = await seed(ctx, { visibility: AssetVisibility.Timeline, surfaces: [] });
    const auth = factory.auth({ user: { id: userId } });

    // A null mask means no exclusions, so it does not belong in a list of hidden things.
    expect(countIn(await sut.getTimeBuckets(auth, { hidden: true }))).toBe(0);
    expect(countIn(await sut.getTimeBuckets(auth, {}))).toBe(1);
  });

  it('should keep a hidden locked asset out of the review view until the session is elevated', async () => {
    const { sut, ctx } = setup();
    const { userId } = await seed(ctx, { visibility: AssetVisibility.Locked, surfaces: [AssetSurface.Timeline] });

    const notElevated = factory.auth({ user: { id: userId } });
    const elevated = factory.auth({ user: { id: userId }, session: { hasElevatedPermission: true } });

    // Otherwise this view would be a way to enumerate the locked folder without unlocking it.
    expect(countIn(await sut.getTimeBuckets(notElevated, { hidden: true }))).toBe(0);
    expect(countIn(await sut.getTimeBuckets(elevated, { hidden: true }))).toBe(1);
  });

  it('should list an archived asset that is hidden, since archive is not a hiding place', async () => {
    const { sut, ctx } = setup();
    const { userId } = await seed(ctx, { visibility: AssetVisibility.Archive, surfaces: [AssetSurface.Timeline] });
    const auth = factory.auth({ user: { id: userId } });

    // Hiding from the timeline now also removes an asset from the archive grid, so the review view is
    // the only place left that shows it. If this returned 0, hiding an archived asset would lose it.
    expect(countIn(await sut.getTimeBuckets(auth, { hidden: true }))).toBe(1);
  });
});
