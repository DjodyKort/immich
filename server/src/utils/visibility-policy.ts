import { Expression, ExpressionBuilder, SelectQueryBuilder, sql, SqlBool } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetSurface, AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';

/**
 * Which `asset.visibility` values a read surface admits.
 *
 * Before this existed the answer was spread across five separate mechanisms, each understood at one
 * call site: `withDefaultVisibility`, a `getSearchVisibility` helper, an `includeLockedAlbumAssets`
 * option, a bespoke `!= 'hidden'` on the download query, and several surfaces with no filter at all.
 * Four of the six defects that turned up while shipping locked albums were only possible because the
 * policy could be re-decided per query. All five of those mechanisms are now deleted: every
 * user-facing read surface asks the table below, and the job and processing paths use the named
 * non-surface helpers at the bottom of this file.
 *
 * What is deliberately still hand-written elsewhere answers a different question, not this one: a
 * caller-supplied `visibility` filter (a request parameter, not a policy), predicates on a self-joined
 * `asset` alias such as `stacked` or `stack_asset`, the `!= hidden` in library and user storage
 * statistics, and the access checks that must keep motion parts reachable through their parent.
 *
 * `hidden` appears in no rule. Motion-photo video parts are therefore excluded from every user-facing
 * surface by construction rather than by each author remembering. Job and processing paths that
 * legitimately need to skip them use {@link excludeMotionParts} instead, which says so by name.
 */
export enum Surface {
  /** The main photo timeline. */
  Timeline = 'timeline',
  /** An album's own timeline. Widens on elevation because a locked album holds only locked assets. */
  AlbumTimeline = 'albumTimeline',
  /** Metadata search, smart search, random, and large assets. */
  Search = 'search',
  /** Asset and search statistics. */
  Statistics = 'statistics',
  /** Per-day activity counts. */
  CalendarHeatmap = 'calendarHeatmap',
  /** An album's asset count and date range. */
  AlbumMetadata = 'albumMetadata',
  /** Map pins for a single album. */
  AlbumMap = 'albumMap',
  /** Map pins across the library. */
  GlobalMap = 'globalMap',
  /** "Download everything I own". */
  TimelineDownload = 'timelineDownload',
  /**
   * The trash view.
   *
   * Same visibility rule as the main timeline, but deliberately **absent from `SURFACE_BIT`**, so a
   * per-asset exclusion can never reach it. Trash is the recovery route: hiding a photo from the timeline
   * must not make it unrecoverable. The web trash view asks the bucket queries with `isTrashed` and no
   * explicit visibility, so without its own surface it would inherit the timeline's mask.
   */
  Trash = 'trash',
  /** The people list, a person's asset count, and the "how many people do I have" badge. */
  People = 'people',
  /** A memory's assets, and the memory list's inline asset previews. */
  Memories = 'memories',
  /** The folder view: the directory tree and one directory's assets. */
  FolderView = 'folderView',
  /**
   * The search filter suggestion lists (country, state, city, camera make/model/lens) and the
   * city-grouped "explore places" row, which read the same rule from the same table.
   */
  SearchSuggestions = 'searchSuggestions',
  /** An album's own asset list, as returned by album creation, album update, and adding album users. */
  AlbumContents = 'albumContents',
  /** A duplicate group's assets, on the duplicates review page. */
  Duplicates = 'duplicates',
  /** A stack's member assets, as returned by stack read, create, and update. */
  StackContents = 'stackContents',
  /**
   * The review view for per-asset hiding: everything with a `hiddenFrom` mask set, in one place.
   *
   * Deliberately **absent from `SURFACE_BIT`**, for the same reason as `Trash`. Every other surface can
   * be hidden from, so hiding an asset from all six user-facing surfaces would otherwise leave it
   * reachable only by knowing its id - the file is safe, but the person cannot find it. This surface is
   * the one route that always applies, so hiding can never be a one-way door. If it ever gains a bit,
   * that guarantee is gone.
   *
   * It admits locked assets only on elevation, like search and album surfaces do: a hidden locked photo
   * must not surface here to a session that has not unlocked.
   */
  HiddenReview = 'hiddenReview',
}

type SurfaceRule = {
  /** Admitted for any session. */
  readonly base: readonly AssetVisibility[];
  /** Additionally admitted once the session is elevated. */
  readonly elevatedAdds: readonly AssetVisibility[];
};

const { Archive, Timeline, Locked } = AssetVisibility;

/**
 * The whole visibility policy, on one screen, reviewable as a table.
 *
 * Sixteen surfaces collapse into three distinct rules. Elevation deliberately buys nothing on the
 * main timeline or the global map: widening those would drop locked photos into the main Photos tab
 * and onto the map for the rest of the elevated window, which is a regression, not a fix. The locked
 * folder is reached by asking for `visibility: locked` explicitly, which requires elevation of its own.
 *
 * `server/test/medium/specs/visibility-matrix.spec.ts` asserts this table against the real services,
 * every value against every surface, at both elevation levels. Change a row here and that suite tells
 * you which surfaces moved.
 */
const POLICY: Record<Surface, SurfaceRule> = {
  [Surface.Timeline]: { base: [Archive, Timeline], elevatedAdds: [] },
  [Surface.Trash]: { base: [Archive, Timeline], elevatedAdds: [] },
  [Surface.AlbumTimeline]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.Search]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.Statistics]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.CalendarHeatmap]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.AlbumMetadata]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.AlbumMap]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.GlobalMap]: { base: [Timeline], elevatedAdds: [] },
  [Surface.TimelineDownload]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.People]: { base: [Timeline], elevatedAdds: [] },
  [Surface.Memories]: { base: [Timeline], elevatedAdds: [] },
  [Surface.FolderView]: { base: [Timeline], elevatedAdds: [] },
  [Surface.SearchSuggestions]: { base: [Timeline], elevatedAdds: [] },
  // The three surfaces below inherited their rule from `withDefaultVisibility`, which excluded hidden
  // and locked unconditionally and had no way to ask about elevation. `elevatedAdds` is therefore empty
  // on purpose: it records what these paths do today rather than what they arguably should do. Album
  // contents in particular does NOT widen the way Surface.AlbumTimeline does, so a locked album's
  // detail response lists no assets even for an elevated session. Widening it is a behaviour change and
  // belongs in its own commit, where this table and the visibility matrix change together.
  [Surface.AlbumContents]: { base: [Archive, Timeline], elevatedAdds: [] },
  [Surface.Duplicates]: { base: [Archive, Timeline], elevatedAdds: [] },
  [Surface.StackContents]: { base: [Archive, Timeline], elevatedAdds: [] },
  // Widens on elevation like search does: a hidden locked photo belongs in this list, but only once the
  // session has unlocked, or the review view would become a way to enumerate the locked folder.
  [Surface.HiddenReview]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
};

/**
 * Who is asking. `elevated` is required and has no default: every fail-open defect found so far came
 * from an optional boolean that could be omitted, defaulted, or passed positionally by mistake.
 *
 * Build one through the named constructors below rather than by hand, so the reason is recorded at the
 * call site instead of in a comment.
 */
export type PolicyContext = {
  readonly elevated: boolean;
};

/** A normal viewer. `undefined` session means not elevated, never the reverse. */
export const forViewer = (auth: AuthDto): PolicyContext => ({
  elevated: !!auth.session?.hasElevatedPermission,
});

/**
 * A path that must never expose locked content regardless of the caller's session: shared links,
 * album sharing, and anything that hands assets to someone else. Replaces the bare `false` that
 * `Permission.AssetShare` passes today, which needed a comment to explain itself.
 */
export const forSharing = (): PolicyContext => ({ elevated: false });

/**
 * Someone else's data. Elevating your own session must not reveal another user's locked folder, which
 * is why the admin calendar-heatmap route does not forward the admin's elevation.
 */
export const forOtherUser = (): PolicyContext => ({ elevated: false });

/**
 * A background job, or a repository method reached from one. There is no session to elevate, and an
 * unattended path must never be the thing that reaches into someone's locked folder.
 *
 * Only sound on a surface whose `elevatedAdds` is empty, since anywhere else it would silently pick
 * the narrow branch of a rule that has a wide one. Every current caller is such a surface.
 */
export const forSystem = (): PolicyContext => ({ elevated: false });

const admitted = (surface: Surface, ctx: PolicyContext): AssetVisibility[] => {
  const rule = POLICY[surface];
  return ctx.elevated ? [...rule.base, ...rule.elevatedAdds] : [...rule.base];
};

/**
 * The bit each surface occupies in `asset.hiddenFrom`, the per-asset exclusion mask.
 *
 * **These values are persisted in the database. Never renumber them and never reuse a retired bit.**
 * Adding a surface means taking the next free bit, not reordering. A `Surface` absent from this map simply
 * cannot be excluded per asset, which is a legitimate choice where that would make no sense.
 */
const SURFACE_BIT: Partial<Record<Surface, number>> = {
  [Surface.Timeline]: 1,
  [Surface.AlbumTimeline]: 1 << 1,
  [Surface.Search]: 1 << 2,
  [Surface.Statistics]: 1 << 3,
  [Surface.CalendarHeatmap]: 1 << 4,
  [Surface.AlbumMetadata]: 1 << 5,
  [Surface.AlbumMap]: 1 << 6,
  [Surface.GlobalMap]: 1 << 7,
  [Surface.TimelineDownload]: 1 << 8,
  [Surface.People]: 1 << 9,
  [Surface.Memories]: 1 << 10,
  [Surface.FolderView]: 1 << 11,
  [Surface.SearchSuggestions]: 1 << 12,
  [Surface.AlbumContents]: 1 << 13,
  [Surface.Duplicates]: 1 << 14,
  [Surface.StackContents]: 1 << 15,
};

/** The bit for a surface, for callers that set or clear an exclusion. */
export const getSurfaceBit = (surface: Surface): number | undefined => SURFACE_BIT[surface];

/**
 * What a client means by each place it can hide an asset from.
 *
 * The wire format is `AssetSurface[]`, never the mask, so this table is the only translation between the
 * two vocabularies. Two consequences are deliberate:
 *
 * - Hiding from `Timeline` does not touch {@link Surface.AlbumTimeline}, and hiding from `Map` does not
 *   touch {@link Surface.AlbumMap}. An album is a context the user navigated into and asked for; an
 *   asset they put there should still be in there. Hiding from the library-wide views is the request.
 * - Hiding from `Search` also sets {@link Surface.SearchSuggestions}, because the suggestion lists are
 *   built from the assets search can return. Leaving them alone would let a hidden photo's city, camera
 *   make, or lens keep appearing in the filter pickers -- the asset itself unreachable, its metadata
 *   still on screen.
 *
 * Surfaces absent from every row are not per-asset excludable by choice: statistics and the calendar
 * heatmap are aggregates the owner uses to reason about their own library, `timelineDownload` is
 * "give me everything I own", and `albumContents`, `duplicates` and `stackContents` are lists of a
 * container the user opened deliberately.
 */
const ASSET_SURFACE_POLICY: Record<AssetSurface, readonly Surface[]> = {
  [AssetSurface.Timeline]: [Surface.Timeline],
  [AssetSurface.Search]: [Surface.Search, Surface.SearchSuggestions],
  [AssetSurface.Map]: [Surface.GlobalMap],
  [AssetSurface.People]: [Surface.People],
  [AssetSurface.Memories]: [Surface.Memories],
  [AssetSurface.Folders]: [Surface.FolderView],
};

/** Which internal surfaces one user-facing surface covers. Exposed so a test can assert the table. */
export const getPolicySurfaces = (surface: AssetSurface): readonly Surface[] => ASSET_SURFACE_POLICY[surface];

/**
 * The `asset.hiddenFrom` value for a set of user-facing surfaces.
 *
 * Returns `null` rather than `0` for an empty set, so "no exclusions" has exactly one representation in
 * the database: every row upstream writes is `null`, and a `0` would be a second spelling of the same
 * thing that no query distinguishes but every comparison would.
 */
export const toHiddenFromMask = (surfaces: readonly AssetSurface[]): number | null => {
  let mask = 0;
  for (const surface of surfaces) {
    for (const policySurface of ASSET_SURFACE_POLICY[surface]) {
      mask |= SURFACE_BIT[policySurface] ?? 0;
    }
  }

  return mask === 0 ? null : mask;
};

/**
 * The user-facing surfaces a stored mask excludes.
 *
 * A user-facing surface is reported only when every internal surface it covers is set, so this is the
 * exact inverse of {@link toHiddenFromMask} for any mask that helper produced. Bits belonging to no
 * user-facing surface -- set by a future release, by a workflow, or by hand -- are ignored rather than
 * throwing: this runs on every asset response, and a mask it cannot fully describe is not a reason to
 * fail the read.
 */
export const fromHiddenFromMask = (mask: number | null): AssetSurface[] => {
  if (!mask) {
    return [];
  }

  return Object.values(AssetSurface).filter((surface) =>
    ASSET_SURFACE_POLICY[surface].every((policySurface) => {
      const bit = SURFACE_BIT[policySurface];
      return bit !== undefined && (mask & bit) !== 0;
    }),
  );
};

/**
 * The effective exclusion mask: the asset's own hiding, plus what its albums impose, minus what the
 * asset explicitly opts back out of.
 *
 * ```
 * hiddenFrom | (hiddenFromInherited & ~hiddenFromShown)
 * ```
 *
 * Three columns rather than one because they answer three different questions, and collapsing them would
 * lose the ability to undo. `hiddenFrom` is what the user chose for this photo; `hiddenFromInherited` is
 * derived from album membership and is recomputed, never adjusted; `hiddenFromShown` is the per-photo
 * override, which exists because album rules compose by **union** and so can never reveal a photo that
 * another album hid.
 *
 * **The override cancels only the inherited term**, which is why it is bracketed that way rather than
 * applied to the whole expression. The looser `(hiddenFrom | inherited) & ~shown` says the same thing
 * for every state a UI can produce, but it also lets `hiddenFrom` and `hiddenFromShown` disagree about
 * the same surface, and then silently resolves it as shown. Making that unrepresentable is worth more
 * than the symmetry: there is no invariant to enforce on write, no ordering to document, and "I hid this
 * photo" can never be overridden by a stale opposite bit.
 *
 * Precedence, i.e. the tiering: a photo's own hiding wins outright; its own showing beats its albums'
 * rules. There is deliberately no album-vs-album priority - that would be a fourth concept, and the
 * per-photo override already covers the case it would serve.
 *
 * `coalesce` rather than an `is null` disjunction: every column is nullable and null means "nothing", so
 * one arithmetic expression covers all eight combinations. It stays a function of columns on `asset`
 * alone, which is what keeps it index-compatible - notably the partial index
 * `asset_id_timeline_notDeleted_idx`, which the helpers here use `sql.lit` to preserve.
 */
const EFFECTIVE_HIDDEN_FROM = sql`(coalesce("asset"."hiddenFrom", 0) | (coalesce("asset"."hiddenFromInherited", 0) & ~coalesce("asset"."hiddenFromShown", 0)))`;

/**
 * Whether an asset is withheld from anything at all, for the Hidden view's membership.
 *
 * Extracted because `asset.repository.ts` hand-wrote `hiddenFrom is not null` at two call sites, which
 * was correct while there was one mask and silently wrong the moment inheritance existed. A photo hidden
 * *only* by its album's rule belongs in that view: the Hidden view is the guarantee that hiding is never
 * a one-way door, and an album rule is no less able to lose a photo than a manual exclusion is.
 *
 * Asks about the **effective** mask, deliberately - so a photo whose every inherited bit is overridden
 * back on is not hidden by anything, and correctly drops out of the view.
 */
export const hasExclusions = <DBT, TB extends keyof DBT & string>(
  eb: ExpressionBuilder<DBT, TB>,
): Expression<SqlBool> => asAssetBuilder(eb)(sql`${EFFECTIVE_HIDDEN_FROM}`, '!=', sql.lit(0));

/**
 * The per-asset half of a surface's rule, read from the effective mask above. This is the only code that
 * reads any of the three columns.
 *
 * They are deliberately separate columns rather than a change to `asset.visibility`. `null` means "no
 * exclusions", which is what every row written by upstream code contains, so the enum keeps its exact
 * meaning and the roughly 38 sites that exclude values implicitly keep working untouched. Each migration
 * is `ALTER TABLE asset ADD "<col>" integer` with no default: instant, no rewrite, no backfill.
 *
 * This is what makes per-*asset* per-surface control possible. The policy table above already gave
 * per-*surface* rules; a single exclusive enum could never carry "hide this one photo from People but
 * leave it in Search".
 */
const notExcludedPerAsset = <DBT, TB extends keyof DBT & string>(
  eb: ExpressionBuilder<DBT, TB>,
  surface: Surface,
): Expression<SqlBool> => {
  const bit = SURFACE_BIT[surface];
  if (bit === undefined) {
    return eb.lit(true);
  }

  const asset = asAssetBuilder(eb);
  return asset(sql`${EFFECTIVE_HIDDEN_FROM} & ${sql.lit(bit)}`, '=', sql.lit(0));
};

/**
 * Restrict a query to the visibility values `surface` admits for `ctx`.
 *
 * Values are inlined with `sql.lit` rather than bound, matching the helper this replaces, so the
 * generated SQL fixtures under `src/queries` stay stable and the planner keeps matching the partial
 * index `asset_id_timeline_notDeleted_idx`.
 */
export function withSurface<O>(qb: SelectQueryBuilder<DB, 'asset', O>, surface: Surface, ctx: PolicyContext) {
  return qb
    .where(
      'asset.visibility',
      'in',
      admitted(surface, ctx).map((visibility) => sql.lit(visibility)),
    )
    .where((eb) => notExcludedPerAsset(eb, surface));
}

/**
 * The per-asset exclusion on its own, without the surface's visibility set.
 *
 * For a caller that names a visibility explicitly - the locked folder asks for `visibility: locked`,
 * the archive view for `archive` - the surface's own visibility set must not override that choice.
 * The per-asset mask still should apply, though, and previously did not: "hide this from my timeline"
 * is about the timeline-shaped grids, and those views are the timeline with one visibility pinned.
 *
 * The resulting rule, stated whole: hiding an asset from `timeline` removes it from every
 * timeline-shaped grid - the main timeline, archive, and the locked folder - and from no album, ever,
 * because album surfaces have no user-facing name to hide from. Trash is untouchable by construction,
 * having no bit at all.
 */
export function excludeHiddenFromSurface<O>(qb: SelectQueryBuilder<DB, 'asset', O>, surface: Surface) {
  return qb.where((eb) => notExcludedPerAsset(eb, surface));
}

/**
 * The same rule as an expression, for `or` groups, join `ON` clauses, and the v3 search filter, none of
 * which can take a query builder. Reads the same table as {@link withSurface}, so the two cannot drift
 * apart.
 *
 * Generic over the caller's schema for the reason given below {@link asAssetBuilder}: a join `ON`
 * clause and a left-joined builder both widen `DB`, so neither can satisfy
 * `ExpressionBuilder<DB, 'asset'>`. Prefer {@link withSurface} where the builder is a plain
 * `selectFrom('asset')`; it keeps the stronger type.
 */
export function surfacePredicate<DBT, TB extends keyof DBT & string>(
  eb: ExpressionBuilder<DBT, TB>,
  surface: Surface,
  ctx: PolicyContext,
): Expression<SqlBool> {
  return asAssetBuilder(eb).and([
    asAssetBuilder(eb)(
      'asset.visibility',
      'in',
      admitted(surface, ctx).map((visibility) => sql.lit(visibility)),
    ),
    notExcludedPerAsset(eb, surface),
  ]);
}

/**
 * Access checks join up to five tables behind a CTE, which widens the builder's own `DB` generic and
 * makes it structurally incompatible with a parameter typed `SelectQueryBuilder<DB, 'asset', O>`. The
 * two access-check helpers below are therefore generic over the caller's schema -- unconstrained,
 * because a left join rewrites its table to `Nullable<...>` and so no longer extends `DB` -- and
 * re-narrow the expression builder here so the column reference itself is still resolved against the
 * real table and a mistyped column name is still a compile error.
 *
 * The alternative was to let each joined access check spell the predicate out inline, which is exactly
 * how the locked folder leaked in the first place.
 */
const asAssetBuilder = <DBT, TB extends keyof DBT & string>(eb: ExpressionBuilder<DBT, TB>) =>
  eb as ExpressionBuilder<DB, 'asset'>;

const asAlbumBuilder = <DBT, TB extends keyof DBT & string>(eb: ExpressionBuilder<DBT, TB>) =>
  eb as ExpressionBuilder<DB, 'album'>;

/**
 * Withhold locked assets from a session that has not been elevated.
 *
 * This is deliberately NOT a surface rule. An access check answers "may this session touch this
 * asset at all", which is a different question from "does this asset belong on this screen": a
 * motion part is legitimately readable and downloadable as part of its parent live photo, so
 * applying a surface rule here would wrongly deny `hidden` and break that. The only thing an access
 * check owes the locked folder is that a non-elevated session cannot reach through it.
 */
export function excludeLockedUnlessElevated<DBT, TB extends keyof DBT & string, O>(
  qb: SelectQueryBuilder<DBT, TB, O>,
  ctx: PolicyContext,
): SelectQueryBuilder<DBT, TB, O> {
  return ctx.elevated
    ? qb
    : qb.where((eb) => asAssetBuilder(eb)('asset.visibility', '!=', sql.lit(AssetVisibility.Locked)));
}

/**
 * Withhold locked *albums* from a session that has not been elevated.
 *
 * The album-granularity sibling of {@link excludeLockedUnlessElevated}. Album locking is recorded on
 * `album.isLocked`, not on `asset.visibility`, so the two predicates read different columns and
 * cannot share an implementation -- but they answer the same question at two granularities and have
 * to move together, so both live here rather than being re-spelled at each access-check call site.
 *
 * Like its asset-level sibling this is deliberately NOT a surface rule: an access check asks whether
 * a session may touch a row at all, not whether the row belongs on a screen.
 */
export function excludeLockedAlbumsUnlessElevated<DBT, TB extends keyof DBT & string, O>(
  qb: SelectQueryBuilder<DBT, TB, O>,
  ctx: PolicyContext,
): SelectQueryBuilder<DBT, TB, O> {
  return ctx.elevated ? qb : qb.where((eb) => asAlbumBuilder(eb)('album.isLocked', '=', false));
}

/**
 * Skip the video half of a live or motion photo.
 *
 * This is a different question from surface visibility: it is about an asset not being a first-class
 * asset at all, and it gates thumbnail generation, OCR, duplicate detection, storage-template moves,
 * and library and user statistics. Kept separate so those paths do not have to borrow a surface rule
 * that does not describe them.
 */
export function excludeMotionParts<DBT, TB extends keyof DBT & string, O>(
  qb: SelectQueryBuilder<DBT, TB, O>,
): SelectQueryBuilder<DBT, TB, O> {
  return qb.where((eb) => asAssetBuilder(eb)('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden)));
}

/**
 * The inverse of the {@link Surface.Memories} rule: the asset has left the timeline.
 *
 * Maintenance logic, not a read surface. `MemoryRepository.cleanup` deletes the `memory_asset` rows of
 * assets that are no longer on the timeline, so archiving, hiding, or locking an asset drops it out of
 * every memory. Because it is a deletion predicate it has to be the complement of the read rule, and
 * because it is a complement it cannot be expressed by asking the policy table for an admitted set --
 * `withSurface` would keep exactly the rows this needs to remove.
 *
 * It lives here anyway so that the pair moves together: widen `Surface.Memories` without widening this
 * and cleanup starts deleting rows the surface would have shown.
 */
export const whereNoLongerOnTimeline = <DBT, TB extends keyof DBT & string>(
  eb: ExpressionBuilder<DBT, TB>,
): Expression<SqlBool> => asAssetBuilder(eb)('asset.visibility', '!=', sql.lit(AssetVisibility.Timeline));

/** Exposed for the policy unit test, so the table itself can be asserted without a database. */
export const getAdmittedVisibility = admitted;
