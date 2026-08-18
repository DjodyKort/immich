import { Expression, ExpressionBuilder, SelectQueryBuilder, sql, SqlBool } from 'kysely';
import { AuthDto } from 'src/dtos/auth.dto';
import { AssetVisibility } from 'src/enum';
import { DB } from 'src/schema';

/**
 * Which `asset.visibility` values a read surface admits.
 *
 * Before this existed the answer was spread across five separate mechanisms, each understood at one
 * call site: `withDefaultVisibility`, a `getSearchVisibility` helper, an `includeLockedAlbumAssets`
 * option, a bespoke `!= 'hidden'` on the download query, and several surfaces with no filter at all.
 * Four of the six defects that turned up while shipping locked albums were only possible because the
 * policy could be re-decided per query.
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
 * Fourteen endpoints collapse into three distinct rules. Elevation deliberately buys nothing on the
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
  [Surface.AlbumTimeline]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.Search]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.Statistics]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.CalendarHeatmap]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.AlbumMetadata]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.AlbumMap]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
  [Surface.GlobalMap]: { base: [Timeline], elevatedAdds: [] },
  [Surface.TimelineDownload]: { base: [Archive, Timeline], elevatedAdds: [Locked] },
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

const admitted = (surface: Surface, ctx: PolicyContext): AssetVisibility[] => {
  const rule = POLICY[surface];
  return ctx.elevated ? [...rule.base, ...rule.elevatedAdds] : [...rule.base];
};

/**
 * Restrict a query to the visibility values `surface` admits for `ctx`.
 *
 * Values are inlined with `sql.lit` rather than bound, matching the helper this replaces, so the
 * generated SQL fixtures under `src/queries` stay stable and the planner keeps matching the partial
 * index `asset_id_timeline_notDeleted_idx`.
 */
export function withSurface<O>(qb: SelectQueryBuilder<DB, 'asset', O>, surface: Surface, ctx: PolicyContext) {
  return qb.where(
    'asset.visibility',
    'in',
    admitted(surface, ctx).map((visibility) => sql.lit(visibility)),
  );
}

/**
 * The same rule as an expression, for `or` groups and the v3 search filter, which cannot take a query
 * builder. Reads the same table, so the two cannot drift apart.
 */
export function surfacePredicate(
  eb: ExpressionBuilder<DB, 'asset'>,
  surface: Surface,
  ctx: PolicyContext,
): Expression<SqlBool> {
  return eb(
    'asset.visibility',
    'in',
    admitted(surface, ctx).map((visibility) => sql.lit(visibility)),
  );
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
export function excludeMotionParts<O>(qb: SelectQueryBuilder<DB, 'asset', O>) {
  return qb.where('asset.visibility', '!=', sql.lit(AssetVisibility.Hidden));
}

/** Exposed for the policy unit test, so the table itself can be asserted without a database. */
export const getAdmittedVisibility = admitted;
