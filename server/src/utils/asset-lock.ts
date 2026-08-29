import { AssetVisibility } from 'src/enum';
import { AlbumRepository } from 'src/repositories/album.repository';
import { AssetLockRestoreRepository } from 'src/repositories/asset-lock-restore.repository';
import { AssetRepository } from 'src/repositories/asset.repository';

export type LockRestoreDeps = {
  albumRepository: AlbumRepository;
  assetLockRestoreRepository: AssetLockRestoreRepository;
  assetRepository: AssetRepository;
};

export type LockRestoreSummary = {
  /** Assets that had a restore point and were put back. */
  restored: number;
  /** Album memberships re-created. */
  albumsRejoined: number;
  /** Memberships that could not come back -- album deleted, trashed, or locked since. */
  albumsLost: number;
};

/**
 * Put [assetIds] back the way they were before they were locked.
 *
 * Locking overwrites two things and, until `asset_lock_restore` existed, remembered neither: the
 * asset's previous `visibility` (one exclusive column, so an *archived* asset lost that fact) and its
 * album memberships (evicted, because a locked asset reachable through an ordinary album's membership
 * is the locked folder leaking). Unlock therefore returned everything to the timeline and to no album,
 * which is why it was never the inverse of lock.
 *
 * `visibility: false` restores only the album memberships, for a caller who named a destination of its
 * own. Deliberately only touches assets that *have* a restore point. Both callers already set a fallback
 * visibility across the whole set before calling this, so assets locked before this table existed keep
 * exactly the old behaviour rather than being special-cased here. That keeps this function's contract
 * narrow: it restores what was recorded, and stays silent about everything else.
 *
 * Shared rather than inlined for the reason `moveIntoLockedFolder` is shared -- the capture side and
 * this side have to stay a matched pair, and a second copy is one edit away from drifting from it.
 */
export const restoreFromLock = async (
  { albumRepository, assetLockRestoreRepository, assetRepository }: LockRestoreDeps,
  assetIds: string[],
  { visibility = true }: { visibility?: boolean } = {},
): Promise<LockRestoreSummary> => {
  const empty: LockRestoreSummary = { restored: 0, albumsRejoined: 0, albumsLost: 0 };

  if (assetIds.length === 0) {
    return empty;
  }

  const points = await assetLockRestoreRepository.getMany(assetIds);
  if (points.length === 0) {
    return empty;
  }

  // The two halves are independent, and `visibility: false` is what makes that explicit: a caller who
  // named a destination has already decided where the asset goes, but nobody decides to lose the
  // albums it used to be in. Those come back either way.
  if (visibility) {
    // One update per distinct previous visibility rather than one per asset: there are only ever a
    // handful of values, so this is at most three statements no matter how large the album was.
    const byVisibility = new Map<AssetVisibility, string[]>();
    for (const point of points) {
      const group = byVisibility.get(point.priorVisibility) ?? [];
      group.push(point.assetId);
      byVisibility.set(point.priorVisibility, group);
    }

    for (const [priorVisibility, ids] of byVisibility) {
      await assetRepository.updateAll(ids, { visibility: priorVisibility });
    }
  }

  const memberships = points.flatMap(({ assetId, priorAlbumIds }) =>
    priorAlbumIds.map((albumId) => ({ albumId, assetId })),
  );
  await albumRepository.addAssetIdsToAlbums(memberships);

  // Only once both halves have been applied. A restore point dropped before the rows it describes are
  // written back is one that cannot be retried.
  await assetLockRestoreRepository.deleteMany(points.map(({ assetId }) => assetId));

  return {
    restored: points.length,
    albumsRejoined: memberships.length,
    albumsLost: points.reduce((total, { priorAlbumCount, priorAlbumIds }) => {
      return total + Math.max(0, priorAlbumCount - priorAlbumIds.length);
    }, 0),
  };
};
