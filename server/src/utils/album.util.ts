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

/**
 * How deep album nesting may go, counting the root as depth 1.
 *
 * A cap rather than unlimited depth for two reasons, neither of them storage. The ancestor walk that
 * prevents cycles is O(depth) on every re-parent, and a breadcrumb has to stay readable on a phone.
 * Ten is far past what anyone organising photos reaches and still cheap to walk.
 */
export const ALBUM_MAX_DEPTH = 10;

/**
 * Refusal messages for the nesting rules, all of them reached from more than one place.
 *
 * The shape they enforce is *"a public folder may hold a private item; a private folder holds only
 * private items"* -- locked flows **down** a tree and never up. So a normal album may contain locked
 * children, which is the case someone deliberately wants, while a locked album's descendants must all
 * be locked, which is what makes "lock this whole branch" mean something.
 *
 * Every one of these is a refusal rather than a fix-up, matching `AlbumService.setLocked`: re-parenting
 * silently locking or unlocking something the user did not name would be the same class of surprise
 * that comment warns about, and here it would move photos between the locked folder and the timeline.
 */
export const AlbumNestingError = {
  SelfParent: 'An album cannot be inside itself',
  Cycle: 'An album cannot be moved inside one of its own sub-albums',
  TooDeep: `Albums cannot be nested more than ${ALBUM_MAX_DEPTH} levels deep`,
  DifferentOwner: 'An album can only be moved into another album you own',
  UnlockedIntoLocked: 'Only a locked album can be moved into a locked album',
  UnlockChildOfLocked: 'Move this album out of its locked parent before unlocking it',
} as const;
