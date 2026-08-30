import { Injectable } from '@nestjs/common';
import {
  ExpressionBuilder,
  Insertable,
  Kysely,
  NotNull,
  Selectable,
  ShallowDehydrateObject,
  sql,
  Updateable,
} from 'kysely';
import { jsonArrayFrom, jsonObjectFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { columns } from 'src/database';
import { Chunked, ChunkedArray, ChunkedSet, DummyValue, GenerateSql } from 'src/decorators';
import { AlbumUserCreateDto, MapAlbumDto } from 'src/dtos/album.dto';
import { AlbumUserRole } from 'src/enum';
import { DB } from 'src/schema';
import { AlbumTable } from 'src/schema/tables/album.table';
import { AssetExifTable } from 'src/schema/tables/asset-exif.table';
import { ALBUM_MAX_DEPTH } from 'src/utils/album.util';
import { anyUuid, asUuid, dummy } from 'src/utils/database';
import {
  excludeLockedAlbumsUnlessElevated,
  PolicyContext,
  Surface,
  surfacePredicate,
  withSurface,
} from 'src/utils/visibility-policy';

export interface AlbumAssetCount {
  albumId: string;
  assetCount: number;
  startDate: Date | null;
  endDate: Date | null;
  lastModifiedAssetTimestamp: Date | null;
}

export interface AlbumInfoOptions {
  withAssets: boolean;
}

const withAlbumUsers = (authUserId?: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb
      .selectFrom('album_user')
      .innerJoin('user', 'user.id', 'album_user.userId')
      .whereRef('album_user.albumId', '=', 'album.id')
      .select('album_user.role')
      .select((eb) => jsonObjectFrom(eb.selectFrom(dummy).select(columns.user)).$notNull().as('user'))
      .orderBy('album_user.role')
      .$if(!!authUserId, (qb) => qb.orderBy((eb) => eb('album_user.userId', '=', authUserId!), 'desc'))
      .orderBy('user.name', 'asc'),
  )
    .$notNull()
    .as('albumUsers');

const withSharedLink = (eb: ExpressionBuilder<DB, 'album'>) =>
  jsonArrayFrom(
    eb.selectFrom('shared_link').selectAll('shared_link').whereRef('shared_link.albumId', '=', 'album.id'),
  ).as('sharedLinks');

const withAssets = (eb: ExpressionBuilder<DB, 'album'>, ctx: PolicyContext) => {
  return eb
    .selectFrom((eb) =>
      eb
        .selectFrom('asset')
        .selectAll('asset')
        .leftJoin('asset_exif', 'asset.id', 'asset_exif.assetId')
        .select((eb) =>
          eb.table('asset_exif').$castTo<ShallowDehydrateObject<Selectable<AssetExifTable>>>().as('exifInfo'),
        )
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .whereRef('album_asset.albumId', '=', 'album.id')
        .where('asset.deletedAt', 'is', null)
        .where((eb) => surfacePredicate(eb, Surface.AlbumContents, ctx))
        .orderBy('asset.fileCreatedAt', 'desc')
        .as('asset'),
    )
    .select((eb) => eb.fn.jsonAgg('asset').as('assets'))
    .as('assets');
};

const isAlbumOwned = (ownerId: string) => (eb: ExpressionBuilder<DB, 'album'>) =>
  eb.exists(
    eb
      .selectFrom('album_user')
      .whereRef('album_user.albumId', '=', 'album.id')
      .where('album_user.role', '=', AlbumUserRole.Owner)
      .where('album_user.userId', '=', ownerId),
  );

@Injectable()
export class AlbumRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: [DummyValue.UUID, { withAssets: true }, { elevated: false }, DummyValue.UUID] })
  getById(id: string, options: AlbumInfoOptions, ctx: PolicyContext, authUserId?: string) {
    return this.db
      .with('album_user', (qb) => qb.selectFrom('album_user').selectAll().where('album_user.albumId', '=', id))
      .selectFrom('album')
      .selectAll('album')
      .where('album.id', '=', id)
      .where('album.deletedAt', 'is', null)
      .select(withAlbumUsers(authUserId))
      .select(withSharedLink)
      .$if(options.withAssets, (eb) => eb.select((eb) => withAssets(eb, ctx)))
      .$narrowType<{ assets: NotNull }>()
      .executeTakeFirst();
  }

  // Deliberately not filtered on `album.isHidden`: hiding is about the album list, and an asset's own
  // "in albums" list is how a hidden album stays findable. Locked albums are a different matter -- the
  // rule is that an unelevated session must not learn one exists, and knowing an asset id inside one
  // must not be a way around that -- so this path takes the same elevation gate as the listing.
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID, { elevated: false }] })
  getByAssetId(ownerId: string, assetId: string, ctx: PolicyContext) {
    return this.db
      .selectFrom('album')
      .selectAll('album')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .$call((qb) => excludeLockedAlbumsUnlessElevated(qb, ctx))
      .select(withAlbumUsers(ownerId))
      .orderBy('album.createdAt', 'desc')
      .execute();
  }

  /**
   * The album an asset belongs to, for rendering a storage path. Not a listing, and deliberately not
   * gated on elevation.
   *
   * The storage-template job streams every asset except motion parts, locked ones included, and
   * `{{album}}` renders into the path on disk. Asking the visibility question here would resolve a
   * locked album's name to null and move those files on the next migration run, so this asks only
   * where the asset lives. Nothing user-facing may call it: `getByAssetId` is the listing.
   */
  @GenerateSql({ params: [DummyValue.UUID, DummyValue.UUID] })
  getByAssetIdForStorageTemplate(ownerId: string, assetId: string) {
    return this.db
      .selectFrom('album')
      .select(['album.id', 'album.albumName'])
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', '=', assetId)
      .where('album.deletedAt', 'is', null)
      .orderBy('album.createdAt', 'desc')
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getByAssetIds(ownerId: string, assetIds: string[]): Promise<Map<string, string[]>> {
    if (assetIds.length === 0) {
      return new Map();
    }

    const results = await this.db
      .selectFrom('album')
      .select('album.id')
      .innerJoin('album_asset', 'album_asset.albumId', 'album.id')
      .where((eb) =>
        eb.exists(
          eb
            .selectFrom('album_user')
            .whereRef('album_user.albumId', '=', 'album.id')
            .where('album_user.userId', '=', ownerId),
        ),
      )
      .where('album_asset.assetId', 'in', assetIds)
      .where('album.deletedAt', 'is', null)
      .select('album_asset.assetId')
      .execute();

    // Group by assetId
    const map = new Map<string, string[]>();
    for (const row of results) {
      const existing = map.get(row.assetId) ?? [];
      existing.push(row.id);
      map.set(row.assetId, existing);
    }

    return map;
  }

  /**
   * Locked members are counted only for an elevated session, so the caller no longer decides: pass
   * `forViewer(auth)` and the {@link Surface.AlbumMetadata} rule answers it. The album list view and
   * the single-album detail fetch previously disagreed here, which is how asset counts, start and end
   * dates for a locked album reached a session that had never entered the PIN.
   */
  @GenerateSql({ params: [[DummyValue.UUID], { elevated: false }] })
  @ChunkedArray()
  async getMetadataForIds(ids: string[], ctx: PolicyContext): Promise<AlbumAssetCount[]> {
    // Guard against running invalid query when ids list is empty.
    if (ids.length === 0) {
      return [];
    }

    return (
      this.db
        .selectFrom('asset')
        .$call((qb) => withSurface(qb, Surface.AlbumMetadata, ctx))
        .innerJoin('album_asset', 'album_asset.assetId', 'asset.id')
        .select('album_asset.albumId as albumId')
        .select((eb) => eb.fn.min(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('startDate'))
        .select((eb) => eb.fn.max(sql<Date>`("asset"."localDateTime" AT TIME ZONE 'UTC'::text)::date`).as('endDate'))
        // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
        .select((eb) => eb.fn.max('asset.updatedAt').as('lastModifiedAssetTimestamp'))
        .select((eb) => sql<number>`${eb.fn.count('asset.id')}::int`.as('assetCount'))
        .where('album_asset.albumId', 'in', ids)
        .where('asset.deletedAt', 'is', null)
        .groupBy('album_asset.albumId')
        .execute()
    );
  }

  private buildAlbumBaseQuery(ownerId: string, { isOwned, isShared }: { isOwned?: boolean; isShared?: boolean }) {
    return this.db
      .selectFrom('album')
      .innerJoin('album_user', (join) =>
        join.onRef('album_user.albumId', '=', 'album.id').on('album_user.userId', '=', ownerId),
      )
      .where('album.deletedAt', 'is', null)
      .$if(isOwned === true, (qb) => qb.where('album_user.role', '=', sql.lit(AlbumUserRole.Owner)))
      .$if(isOwned === false, (qb) => qb.where('album_user.role', '!=', sql.lit(AlbumUserRole.Owner)))
      .$if(isShared !== undefined, (qb) =>
        qb.where((eb) => {
          const isSharedAlbum = eb.or([
            eb.exists(
              eb
                .selectFrom('album_user as au')
                .whereRef('au.albumId', '=', 'album.id')
                .where('au.role', '!=', sql.lit(AlbumUserRole.Owner)),
            ),
            eb.exists(eb.selectFrom('shared_link').whereRef('shared_link.albumId', '=', 'album.id')),
          ]);
          return isShared ? isSharedAlbum : eb.not(isSharedAlbum);
        }),
      );
  }

  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  getAll(
    ownerId: string,
    options: {
      id?: string;
      isOwned?: boolean;
      isShared?: boolean;
      name?: string;
      /** `true` lists only hidden albums, the review view. Otherwise they are left out. */
      hidden?: boolean;
      /** Whether the session has unlocked. Locked albums are invisible until it has. */
      elevated?: boolean;
    } = {},
  ): Promise<MapAlbumDto[]> {
    return (
      this.buildAlbumBaseQuery(ownerId, options)
        .selectAll('album')
        .select(withAlbumUsers(ownerId))
        .select(withSharedLink)
        .$if(!!options.id, (qb) => qb.where('album.id', '=', options.id!))
        .$if(!!options.name, (qb) => qb.where('album.albumName', '=', options.name!))
        // Hidden albums are either the whole point of the request or excluded from it, never mixed in.
        .$if(options.hidden === true, (qb) => qb.where('album.isHidden', '=', true))
        .$if(options.hidden !== true, (qb) => qb.where('album.isHidden', '=', false))
        // A locked album is invisible, by name and all, until the session unlocks. Applied to the hidden
        // listing too: "show me my hidden albums" must not become a way to enumerate the locked ones.
        .$if(!options.elevated, (qb) => qb.where('album.isLocked', '=', false))
        .orderBy('album.createdAt', 'desc')
        .execute()
    );
  }

  @GenerateSql({ params: [DummyValue.UUID, { isOwned: true, isShared: true }] })
  async getAllIds(ownerId: string, options: { isOwned?: boolean; isShared?: boolean } = {}): Promise<string[]> {
    const rows = await this.buildAlbumBaseQuery(ownerId, options)
      .select('album.id')
      .orderBy('album.createdAt', 'desc')
      .execute();
    return rows.map((r) => r.id);
  }

  async restoreAll(userId: string): Promise<void> {
    await this.db.updateTable('album').set({ deletedAt: null }).where(isAlbumOwned(userId)).execute();
  }

  async softDeleteAll(userId: string): Promise<void> {
    await this.db.updateTable('album').set({ deletedAt: new Date() }).where(isAlbumOwned(userId)).execute();
  }

  async deleteAll(userId: string): Promise<void> {
    await this.db.deleteFrom('album').where(isAlbumOwned(userId)).execute();
  }

  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async removeAssetsFromAll(assetIds: string[]): Promise<void> {
    await this.db.deleteFrom('album_asset').where('album_asset.assetId', 'in', assetIds).execute();
  }

  /**
   * Remove the given assets from every album *except* the one keeping them.
   *
   * Locking an existing album makes its assets Locked, and a locked asset may belong to at most one
   * album -- the locked one. Any other membership those assets had has to go, or the same photo would
   * sit behind the PIN here and in plain sight in an ordinary album, which is the exact leak
   * `checkAlbumAccess` exists to prevent. Deliberately not `removeAssetsFromAll` followed by a
   * re-add: that would drop and recreate rows the caller means to keep, losing their `createdAt`.
   */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  @Chunked()
  async removeAssetsFromOtherAlbums(assetIds: string[], keepAlbumId: string): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('album_asset')
      .where('album_asset.assetId', 'in', assetIds)
      .where('album_asset.albumId', '!=', keepAlbumId)
      .execute();
  }

  /**
   * Which of the given album IDs are currently locked -- used to enforce the "an asset can only be
   * added to one locked album at a time" rule server-side, mirroring the client-side check in the
   * album picker, so any caller (not just the web UI) is held to the same rule.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @ChunkedSet()
  async getLockedAlbumIds(albumIds: string[]): Promise<Set<string>> {
    if (albumIds.length === 0) {
      return new Set();
    }

    return this.db
      .selectFrom('album')
      .select('album.id')
      .where('album.id', 'in', albumIds)
      .where('album.isLocked', '=', true)
      .execute()
      .then((rows) => new Set(rows.map((row) => row.id)));
  }

  /**
   * Remove the given assets from any album they're in, but only if that album is locked. Used
   * when an asset's visibility is changing away from Locked (e.g. "remove from locked folder"):
   * a visible asset can never remain counted as a locked album's member, but this deliberately
   * leaves ties to ordinary unlocked albums alone -- unlocking a single asset shouldn't touch
   * album memberships that have nothing to do with the lock itself.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  @Chunked()
  async removeAssetsFromLockedAlbums(assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('album_asset')
      .where('album_asset.assetId', 'in', assetIds)
      .where('album_asset.albumId', 'in', (eb) =>
        eb.selectFrom('album').select('album.id').where('isLocked', '=', true),
      )
      .execute();
  }

  /**
   * Of the given asset IDs, return the ones that already belong to some locked album other than
   * `excludeAlbumId`. An asset can only ever be in one locked album at a time, so this is used to
   * reject adding an already-locked-album asset into a different locked album, rather than
   * silently moving it.
   *
   * `excludeAlbumId` is omitted when there is no album to exclude yet -- `AlbumService.create` runs
   * this before the album it would exclude exists -- and the question is then simply "is any of
   * these already in a locked album". A sentinel UUID would have worked and would have read as one.
   */
  @GenerateSql({ params: [[DummyValue.UUID], DummyValue.UUID] })
  async getAssetIdsInOtherLockedAlbums(assetIds: string[], excludeAlbumId?: string): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    let query = this.db
      .selectFrom('album_asset')
      .innerJoin('album', 'album.id', 'album_asset.albumId')
      .select('album_asset.assetId')
      .where('album_asset.assetId', 'in', assetIds)
      .where('album.isLocked', '=', true);

    if (excludeAlbumId !== undefined) {
      query = query.where('album.id', '!=', excludeAlbumId);
    }

    return query.execute().then((rows) => new Set(rows.map((row) => row.assetId)));
  }

  /**
   * Get every asset ID currently in the given album (no filter).
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAllAssetIds(albumId: string): Promise<string[]> {
    const rows = await this.db
      .selectFrom('album_asset')
      .select('album_asset.assetId')
      .where('album_asset.albumId', '=', albumId)
      .execute();
    return rows.map((r) => r.assetId);
  }

  @Chunked({ paramIndex: 1 })
  async removeAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .deleteFrom('album_asset')
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', 'in', assetIds)
      .execute();
  }

  /**
   * Get asset IDs for the given album ID.
   *
   * @param albumId Album ID to get asset IDs for.
   * @param assetIds Optional list of asset IDs to filter on.
   * @returns Set of Asset IDs for the given album ID.
   */
  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  @ChunkedSet({ paramIndex: 1 })
  async getAssetIds(albumId: string, assetIds: string[]): Promise<Set<string>> {
    if (assetIds.length === 0) {
      return new Set();
    }

    return this.db
      .selectFrom('album_asset')
      .selectAll()
      .where('album_asset.albumId', '=', albumId)
      .where('album_asset.assetId', 'in', assetIds)
      .execute()
      .then((results) => new Set(results.map(({ assetId }) => assetId)));
  }

  /**
   * Every asset in the album with its owner, regardless of visibility.
   *
   * Deliberately unfiltered, and the only album read that is. `withAssets` applies
   * `Surface.AlbumContents`, whose `elevatedAdds` is empty, so it never returns locked assets even to an
   * elevated session -- correct for describing an album to a viewer, and useless for `setLocked`, which
   * has to act on the members it cannot see. Reading the album through that path made *unlocking* a
   * silent no-op on the photos: the album flipped to unlocked while its contents stayed in the locked
   * folder, reachable from nowhere.
   *
   * Safe because it returns ids and owner ids only -- no paths, no EXIF, nothing that could leak a locked
   * photo's content -- and its one caller is owner-only and elevation-gated. Do not reach for it to
   * render an album.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getMemberAssetsForLockChange(albumId: string): Promise<Array<{ id: string; ownerId: string }>> {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'album_asset.assetId')
      .select(['asset.id', 'asset.ownerId'])
      .where('album_asset.albumId', '=', albumId)
      .where('asset.deletedAt', 'is', null)
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID, [DummyValue.UUID]] })
  async addAssetIds(albumId: string, assetIds: string[]): Promise<void> {
    if (assetIds.length === 0) {
      return;
    }

    await this.db
      .insertInto('album_asset')
      .expression((eb) =>
        eb.selectFrom(dummy).select([asUuid(albumId).as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  @GenerateSql({
    params: [
      { albumName: DummyValue.STRING },
      [],
      [{ userId: DummyValue.UUID, role: AlbumUserRole.Owner }],
      DummyValue.UUID,
      { elevated: false },
    ],
  })
  async create(
    album: Insertable<AlbumTable>,
    assetIds: string[],
    albumUsers: AlbumUserCreateDto[],
    authUserId: string,
    ctx: PolicyContext,
  ) {
    if (albumUsers.every((u) => u.role !== AlbumUserRole.Owner)) {
      throw new Error('Album must have an owner');
    }

    const userIds = albumUsers.map((u) => u.userId);
    const roles = albumUsers.map((u) => u.role);

    const result = await this.db
      .with('album', (db) => db.insertInto('album').values(album).returningAll())
      .with('album_user', (db) =>
        db
          .insertInto('album_user')
          .expression((eb) =>
            eb
              .selectFrom('album')
              .select(({ ref }) => [
                ref('album.id').as('albumId'),
                sql`unnest(${userIds}::uuid[])`.as('userId'),
                sql`unnest(${roles}::album_user_role_enum[])`.as('role'),
              ]),
          )
          .returning(['album_user.albumId', 'album_user.userId', 'album_user.role']),
      )
      .with('album_asset', (db) =>
        db
          .insertInto('album_asset')
          .expression((eb) =>
            eb
              .selectFrom('album')
              .select(({ ref }) => [ref('album.id').as('albumId'), sql`unnest(${assetIds}::uuid[])`.as('assetId')]),
          )
          .onConflict((oc) => oc.doNothing())
          .returning(['album_asset.albumId', 'album_asset.assetId']),
      )
      .selectFrom('album')
      .selectAll('album')
      .select(withAlbumUsers(authUserId))
      .select((eb) => withAssets(eb, ctx))
      .$narrowType<{ assets: NotNull }>()
      .executeTakeFirstOrThrow();

    return result;
  }

  update(id: string, album: Updateable<AlbumTable>, authUserId: string) {
    return this.db
      .updateTable('album')
      .set(album)
      .where('album.id', '=', id)
      .returningAll('album')
      .returning(withSharedLink)
      .returning(withAlbumUsers(authUserId))
      .executeTakeFirstOrThrow();
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom('album').where('id', '=', id).execute();
  }

  /**
   * The chain from [albumId] up to its root, nearest ancestor first, [albumId] itself excluded.
   *
   * This is the whole of the cycle and depth machinery. Moving album A under album B is a cycle
   * exactly when A appears in B's ancestors, and it is too deep exactly when B's chain is already at
   * the cap -- both answerable from this one walk, so `setParent` reads it once and asks twice.
   *
   * Soft-deleted albums are *not* filtered here, on purpose. A trashed parent still owns its children
   * structurally, and letting a move slip past a cycle check because a link happened to be in the
   * trash would corrupt the tree the moment it was restored.
   *
   * `LIMIT` is the safety net rather than the mechanism: if a cycle ever did exist, a recursive CTE
   * over it would not terminate, and no query should be able to hang the server because a row is
   * wrong. It is set above the depth cap so a legitimate chain is never truncated.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getAncestorIds(albumId: string): Promise<string[]> {
    const rows = await this.db
      .withRecursive('ancestor', (qb) =>
        qb
          .selectFrom('album')
          .select(['album.id', 'album.parentId'])
          .where('album.id', '=', albumId)
          .unionAll((union) =>
            union
              .selectFrom('album')
              .select(['album.id', 'album.parentId'])
              .innerJoin('ancestor', 'ancestor.parentId', 'album.id'),
          ),
      )
      .selectFrom('ancestor')
      .select('ancestor.id')
      .where('ancestor.id', '!=', albumId)
      .limit(ALBUM_MAX_DEPTH * 2)
      .execute();

    return rows.map(({ id }) => id);
  }

  /**
   * Every album below [albumId], at any depth. Excludes [albumId] itself.
   *
   * Used by the operations that act on a branch rather than an album -- locking a subtree, and
   * refusing to unlock an album that still has locked descendants. Soft-deleted albums are excluded
   * because those operations act on what the user can currently see.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  async getDescendantIds(albumId: string): Promise<string[]> {
    const rows = await this.db
      .withRecursive('descendant', (qb) =>
        qb
          .selectFrom('album')
          .select('album.id')
          .where('album.parentId', '=', albumId)
          .where('album.deletedAt', 'is', null)
          .unionAll((union) =>
            union
              .selectFrom('album')
              .select('album.id')
              .innerJoin('descendant', 'descendant.id', 'album.parentId')
              .where('album.deletedAt', 'is', null),
          ),
      )
      .selectFrom('descendant')
      .select('descendant.id')
      .limit(10_000)
      .execute();

    return rows.map(({ id }) => id);
  }

  /**
   * Which *other* albums would lose photos if [albumIds] were locked, and how many each would lose.
   *
   * Locking evicts its assets from every album except the one keeping them, so this is the number a
   * confirm dialog has to be able to show: not just "852 photos move" but "41 of them leave 7 albums
   * you did not name". Read-only, and deliberately not derived from the eviction itself -- the caller
   * asks before deciding, so it cannot be a side effect of doing it.
   */
  @GenerateSql({ params: [[DummyValue.UUID], [DummyValue.UUID]] })
  async getEvictionImpact(
    albumIds: string[],
    excludeAlbumIds: string[],
  ): Promise<{ id: string; albumName: string; assetCount: number }[]> {
    if (albumIds.length === 0) {
      return [];
    }

    const rows = await this.db
      .selectFrom('album_asset as other')
      .innerJoin('album', 'album.id', 'other.albumId')
      .select((eb) => ['album.id', 'album.albumName', eb.fn.countAll<number>().as('assetCount')])
      .where('album.deletedAt', 'is', null)
      .where('other.albumId', '!=', anyUuid(excludeAlbumIds))
      .where('other.assetId', 'in', (eb) =>
        eb.selectFrom('album_asset as member').select('member.assetId').where('member.albumId', '=', anyUuid(albumIds)),
      )
      .groupBy(['album.id', 'album.albumName'])
      .orderBy('album.albumName')
      .execute();

    return rows.map(({ id, albumName, assetCount }) => ({ id, albumName, assetCount: Number(assetCount) }));
  }

  /**
   * The `parentId` of each of [albumIds], as a lookup.
   *
   * One statement instead of a query per node, so the caller can walk a subtree it already has the ids
   * for entirely in memory.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getParentIds(albumIds: string[]): Promise<Map<string, string | null>> {
    if (albumIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('album')
      .select(['album.id', 'album.parentId'])
      .where('album.id', '=', anyUuid(albumIds))
      .execute();

    return new Map(rows.map(({ id, parentId }) => [id, parentId]));
  }

  /**
   * How many live children each of [albumIds] has.
   *
   * Counted server-side rather than derived by the clients from the flat album list, because that list
   * is already filtered by what the viewer may see -- a locked child is absent from it for an
   * unelevated session, and counting the rows present would quietly report the wrong number rather
   * than the same number every other surface shows.
   */
  @GenerateSql({ params: [[DummyValue.UUID]] })
  async getChildCounts(albumIds: string[]): Promise<Map<string, number>> {
    if (albumIds.length === 0) {
      return new Map();
    }

    const rows = await this.db
      .selectFrom('album')
      .select((eb) => ['album.parentId', eb.fn.countAll<number>().as('count')])
      .where('album.parentId', '=', anyUuid(albumIds))
      .where('album.deletedAt', 'is', null)
      .groupBy('album.parentId')
      .execute();

    return new Map(rows.map(({ parentId, count }) => [parentId as string, Number(count)]));
  }

  @Chunked({ chunkSize: 30_000 })
  async addAssetIdsToAlbums(values: { albumId: string; assetId: string }[]): Promise<void> {
    if (values.length === 0) {
      return;
    }
    await this.db
      .insertInto('album_asset')
      .values(values)
      // Allow idempotent album sync without failing on existing album memberships.
      .onConflict((oc) => oc.columns(['albumId', 'assetId']).doNothing())
      .execute();
  }

  /**
   * Makes sure all thumbnails for albums are updated by:
   * - Removing thumbnails from albums without assets
   * - Removing references of thumbnails to assets outside the album
   * - Setting a thumbnail when none is set and the album contains assets
   *
   * @returns Amount of updated album thumbnails or undefined when unknown
   */
  async updateThumbnails(): Promise<number | undefined> {
    // Subquery for getting a new thumbnail.

    const result = await this.db
      .updateTable('album')
      .set((eb) => ({
        albumThumbnailAssetId: this.updateThumbnailBuilder(eb)
          .select('album_asset.assetId')
          .orderBy('asset.fileCreatedAt', 'desc')
          .limit(sql.lit(1)),
      }))
      .where((eb) =>
        eb.or([
          eb.and([
            eb('albumThumbnailAssetId', 'is', null),
            eb.exists(this.updateThumbnailBuilder(eb).select(sql`1`.as('1'))), // Has assets
          ]),
          eb.and([
            eb('albumThumbnailAssetId', 'is not', null),
            eb.not(
              eb.exists(
                this.updateThumbnailBuilder(eb)
                  .select(sql`1`.as('1'))
                  .whereRef('album.albumThumbnailAssetId', '=', 'album_asset.assetId'), // Has invalid assets
              ),
            ),
          ]),
        ]),
      )
      .execute();

    return Number(result[0].numUpdatedRows);
  }

  private updateThumbnailBuilder(eb: ExpressionBuilder<DB, 'album'>) {
    return eb
      .selectFrom('album_asset')
      .innerJoin('asset', (join) =>
        join.onRef('album_asset.assetId', '=', 'asset.id').on('asset.deletedAt', 'is', null),
      )
      .whereRef('album_asset.albumId', '=', 'album.id');
  }

  /**
   * Get per-user asset contribution counts for a single album.
   * Excludes deleted assets, orders by count desc.
   */
  @GenerateSql({ params: [DummyValue.UUID] })
  getContributorCounts(id: string) {
    return this.db
      .selectFrom('album_asset')
      .innerJoin('asset', 'asset.id', 'assetId')
      .where('asset.deletedAt', 'is', sql.lit(null))
      .where('album_asset.albumId', '=', id)
      .select('asset.ownerId as userId')
      .select((eb) => eb.fn.countAll<number>().as('assetCount'))
      .groupBy('asset.ownerId')
      .orderBy('assetCount', 'desc')
      .execute();
  }

  @GenerateSql({ params: [{ sourceAssetId: DummyValue.UUID, targetAssetId: DummyValue.UUID }] })
  async copyAlbums({ sourceAssetId, targetAssetId }: { sourceAssetId: string; targetAssetId: string }) {
    return this.db
      .insertInto('album_asset')
      .expression((eb) =>
        eb
          .selectFrom('album_asset')
          .select((eb) => ['album_asset.albumId', eb.val(targetAssetId).as('assetId')])
          .where('album_asset.assetId', '=', sourceAssetId),
      )
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}
