import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';

import { AssetIdErrorReason } from 'src/dtos/asset-ids.response.dto';
import { AssetVisibility, SharedLinkType } from 'src/enum';
import { AccessRepository } from 'src/repositories/access.repository';
import { CryptoRepository } from 'src/repositories/crypto.repository';
import { DatabaseRepository } from 'src/repositories/database.repository';
import { LoggingRepository } from 'src/repositories/logging.repository';
import { SharedLinkAssetRepository } from 'src/repositories/shared-link-asset.repository';
import { SharedLinkRepository } from 'src/repositories/shared-link.repository';
import { StorageRepository } from 'src/repositories/storage.repository';
import { DB } from 'src/schema';
import { SharedLinkService } from 'src/services/shared-link.service';
import { newMediumService } from 'test/medium.factory';
import { factory } from 'test/small.factory';
import { getKyselyDB } from 'test/utils';

/**
 * Why shared links carry no `Surface`.
 *
 * `_fork/asset-surfaces.json` classifies the six shared-link operations as not-a-surface, and this is
 * the evidence for that claim. It is worth writing down because the read queries look alarming:
 * neither `withSharedAssets` nor the album-asset subquery in `SharedLinkRepository.get` filters on
 * visibility at all, only on `deletedAt`. Nothing there would stop a locked asset being served.
 *
 * What stops it is the write path. Both `create` and `addAssets` go through
 * `Permission.AssetShare`, which resolves to `checkOwnerAccess(userId, ids, forSharing())`, and
 * `forSharing()` is never elevated, so `excludeLockedUnlessElevated` drops locked assets before they
 * can ever be attached. The invariant is enforced on the way in rather than filtered on the way out.
 *
 * That makes these tests the load-bearing ones for the classification: if someone ever relaxes the
 * `AssetShare` check, the read path has no second line of defence and these fail.
 *
 * The `hiddenFrom` case is deliberate rather than an oversight, and is pinned here so it is not
 * "fixed" by accident. `hiddenFrom` hides an asset from the owner's own browsing surfaces, which is
 * what the six-member user-facing `AssetSurface` enum describes. A shared link is not one of them: it
 * is a deliberate act of publishing. Hiding a photo from your timeline should not silently retract a
 * link you handed to somebody.
 */

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(SharedLinkService, {
    database: db || defaultDatabase,
    // CryptoRepository is real because `create` generates the link key with it; the sibling spec does not
    // need it only because it inserts through the repository instead of calling the service.
    real: [AccessRepository, CryptoRepository, DatabaseRepository, SharedLinkRepository, SharedLinkAssetRepository],
    mock: [LoggingRepository, StorageRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('shared link visibility', () => {
  it('should refuse to create an individual link over a locked asset', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });

    // Permission.AssetShare checks as forSharing(), which is never elevated, so the asset is not in
    // the allowed set and requireAccess rejects the whole request.
    await expect(sut.create(auth, { type: SharedLinkType.Individual, assetIds: [locked.id] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('should still create a link over an ordinary asset', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    // Both read queries inner-join exif, so an asset with no exif row is dropped from the response
    // entirely and the assertion below would see an empty list for reasons unrelated to visibility.
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });

    // The negative test above is only meaningful if the positive case works, otherwise it would pass
    // just as well against a create that rejected everything.
    const link = await sut.create(auth, { type: SharedLinkType.Individual, assetIds: [asset.id] });
    const result = await sut.get(auth, link.id);

    expect(result.assets.map(({ id }) => id)).toEqual([asset.id]);
  });

  it('should refuse to add a locked asset to an existing link', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });
    const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    await ctx.newExif({ assetId: locked.id, make: 'Canon' });

    const link = await sut.create(auth, { type: SharedLinkType.Individual, assetIds: [asset.id] });
    const results = await sut.addAssets(auth, link.id, { assetIds: [locked.id] });

    expect(results).toEqual([{ assetId: locked.id, success: false, error: AssetIdErrorReason.NO_PERMISSION }]);
  });

  it('should serve an asset through a shared link even when hiddenFrom names every surface', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    // Every bit set, which is broader than any mask the API can produce. Aimed at the individual-link
    // path on purpose, because `withSharedAssets` is the query with no visibility predicate at all: if
    // a surface were ever wired into it, this asset would vanish and this test would say so.
    const { asset } = await ctx.newAsset({ ownerId: user.id, hiddenFrom: 0xff_ff });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });

    const link = await sut.create(auth, { type: SharedLinkType.Individual, assetIds: [asset.id] });
    const result = await sut.get(auth, link.id);

    expect(result.assets.map(({ id }) => id)).toEqual([asset.id]);
  });
});
