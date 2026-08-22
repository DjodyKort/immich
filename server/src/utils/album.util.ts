/**
 * Refusal messages for the locked-album invariant that more than one endpoint enforces.
 *
 * Only the **duplicated** ones live here. A locked-album refusal made at exactly one call site keeps
 * its message inline, next to the condition and the comment explaining it, which is how the rest of
 * this codebase reads. These two are here because the same refusal is reached by more than one route,
 * and a user who hits it two ways should not be told two different things:
 *
 * - `NeedsLockedAssets` is checked when creating a locked album, when adding to one, and when adding
 *   to several at once.
 * - `CannotBeShared` is checked by `AlbumService.addUsers` and by `SharedLinkService.create`, the two
 *   ways to let someone else into an album.
 *
 * The invariant itself is described in CLAUDE.md under "Locked albums": a locked album may only ever
 * contain assets that are already locked, and it may not be shared with anyone.
 */
export const LockedAlbumError = {
  NeedsLockedAssets: 'A locked album can only contain assets that are already locked',
  CannotBeShared: 'A locked album cannot be shared. Unlock it first',
} as const;
