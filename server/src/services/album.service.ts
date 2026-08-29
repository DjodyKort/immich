import { BadRequestException, Injectable } from '@nestjs/common';
import {
  AddUsersDto,
  AlbumResponseDto,
  AlbumsAddAssetsDto,
  AlbumsAddAssetsResponseDto,
  AlbumSetHiddenFromDto,
  AlbumSetLockedDto,
  AlbumStatisticsResponseDto,
  CreateAlbumDto,
  GetAlbumsDto,
  mapAlbum,
  UpdateAlbumDto,
  UpdateAlbumUserDto,
} from 'src/dtos/album.dto';
import { BulkIdErrorReason, BulkIdResponseDto, BulkIdsDto } from 'src/dtos/asset-ids.response.dto';
import { AuthDto } from 'src/dtos/auth.dto';
import { MapMarkerResponseDto } from 'src/dtos/map.dto';
import { AlbumUserRole, AssetVisibility, JobName, Permission } from 'src/enum';
import { AlbumAssetCount, AlbumInfoOptions } from 'src/repositories/album.repository';
import { BaseService } from 'src/services/base.service';
import { requireElevatedPermission } from 'src/utils/access';
import { LockedAlbumError } from 'src/utils/album.util';
import { addAssets, removeAssets } from 'src/utils/asset.util';
import { asDateTimeString } from 'src/utils/date';
import { findOrFail } from 'src/utils/misc';
import { getPreferences } from 'src/utils/preferences';
import { forViewer, PolicyContext, toHiddenFromMask } from 'src/utils/visibility-policy';

@Injectable()
export class AlbumService extends BaseService {
  async getStatistics(auth: AuthDto): Promise<AlbumStatisticsResponseDto> {
    const [owned, shared, notShared] = await Promise.all([
      this.albumRepository.getAll(auth.user.id, { isOwned: true }),
      this.albumRepository.getAll(auth.user.id, { isShared: true }),
      this.albumRepository.getAll(auth.user.id, { isOwned: true, isShared: false }),
    ]);

    return {
      owned: owned.length,
      shared: shared.length,
      notShared: notShared.length,
    };
  }

  async getAll(auth: AuthDto, { assetId, ...rest }: GetAlbumsDto): Promise<AlbumResponseDto[]> {
    const ownerId = auth.user.id;
    await this.albumRepository.updateThumbnails();

    const albums = assetId
      ? await this.albumRepository.getByAssetId(ownerId, assetId, forViewer(auth))
      : // Elevation decides whether locked albums are visible at all, so it travels with the query
        // rather than being applied afterwards: filtering post-hoc would leak their existence via counts.
        await this.albumRepository.getAll(ownerId, { ...rest, elevated: forViewer(auth).elevated });

    if (albums.length === 0) {
      return [];
    }

    // PIN elevation is session-wide, not per-album: once elevated, the requester already has
    // standing access to open any of their locked albums with no extra friction. So it's safe
    // to also reveal locked albums' real counts here rather than showing a stale 0.
    //
    // Get asset count for each album. Then map the result to an object:
    // { [albumId]: assetCount }
    const results = await this.albumRepository.getMetadataForIds(
      albums.map((album) => album.id),
      forViewer(auth),
    );
    const albumMetadata: Record<string, AlbumAssetCount> = {};
    for (const metadata of results) {
      albumMetadata[metadata.albumId] = metadata;
    }

    return albums.map((album) => ({
      ...mapAlbum(album),
      sharedLinks: undefined,
      startDate: asDateTimeString(albumMetadata[album.id]?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadata[album.id]?.endDate ?? undefined),
      assetCount: albumMetadata[album.id]?.assetCount ?? 0,
      // lastModifiedAssetTimestamp is only used in mobile app, please remove if not need
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadata[album.id]?.lastModifiedAssetTimestamp ?? undefined),
    }));
  }

  async get(auth: AuthDto, id: string): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });
    await this.albumRepository.updateThumbnails();
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false }, forViewer(auth));
    // Pass the session's real elevation rather than a hardcoded true. requireAccess(AlbumRead) above
    // does deny a locked album to a non-elevated session, but relying on that alone means trusting
    // that a locked asset can never sit in an ordinary album, and getMapMarkers a few lines below
    // deliberately refuses to trust exactly that. Without this, assetCount, startDate, endDate and
    // lastModifiedAssetTimestamp described an album's locked members to a session with no PIN.
    const [albumMetadataForIds] = await this.albumRepository.getMetadataForIds([album.id], forViewer(auth));

    const hasSharedUsers = album.albumUsers && album.albumUsers.length > 1;
    const hasSharedLink = album.sharedLinks && album.sharedLinks.length > 0;
    const isShared = hasSharedUsers || hasSharedLink;

    return {
      ...mapAlbum(album),
      startDate: asDateTimeString(albumMetadataForIds?.startDate ?? undefined),
      endDate: asDateTimeString(albumMetadataForIds?.endDate ?? undefined),
      assetCount: albumMetadataForIds?.assetCount ?? 0,
      lastModifiedAssetTimestamp: asDateTimeString(albumMetadataForIds?.lastModifiedAssetTimestamp ?? undefined),
      contributorCounts: isShared ? await this.albumRepository.getContributorCounts(album.id) : undefined,
    };
  }

  async getMapMarkers(auth: AuthDto, id: string): Promise<MapMarkerResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumRead, ids: [id] });

    if (auth.sharedLink && !auth.sharedLink.showExif) {
      return [];
    }

    return this.mapRepository.getAlbumMapMarkers(id, forViewer(auth));
  }

  async create(auth: AuthDto, dto: CreateAlbumDto): Promise<AlbumResponseDto> {
    const albumUsers = (dto.albumUsers || []).filter(({ userId }) => userId !== auth.user.id);

    for (const { userId } of albumUsers) {
      const exists = await this.userRepository.get(userId, {});
      if (!exists) {
        this.logger.debug('Album creation failed: user not found');
        throw new BadRequestException('Invalid user');
      }
    }

    const requestedAssetIds = dto.assetIds || [];

    // Permission.AssetShare cannot gate the initial assets of a locked album: it hardcodes
    // non-elevated access, so every already-locked asset would be filtered out here and the album
    // would be created silently empty. Permission.AssetUpdate does respect session elevation, and
    // organising assets the requester already owns, and has already locked, into a locked album
    // they also own exposes them to nobody else. Same reasoning as addAssets() below.
    const allowedAssetIdsSet = await this.checkAccess({
      auth,
      permission: dto.isLocked ? Permission.AssetUpdate : Permission.AssetShare,
      ids: requestedAssetIds,
    });
    const assetIds = [...allowedAssetIdsSet].map((id) => id);

    // Creating a locked album still requires its initial assets to be locked already: this path
    // assembles an album out of the locked folder, so anything else is a mistake worth reporting.
    // Converting an ordinary album is a separate operation -- see setLocked() -- which locks the
    // assets itself rather than demanding they arrive that way.
    // Validate against what was REQUESTED rather than what survived the access filter: checking the
    // filtered list means a rejected asset is silently dropped instead of failing the request, and
    // an empty filtered list would skip this check altogether.
    if (dto.isLocked && requestedAssetIds.length > 0) {
      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(requestedAssetIds);
      if (lockedAssetIds.size !== requestedAssetIds.length || assetIds.length !== requestedAssetIds.length) {
        throw new BadRequestException(LockedAlbumError.NeedsLockedAssets);
      }

      // An asset belongs to at most one locked album at a time. `addAssets` and the bulk
      // add-to-albums path both enforce that; this one did not, and `AlbumRepository.create` inserts
      // its `album_asset` rows unconditionally -- so assembling a new locked album out of assets
      // that already sat in one put them in *two*, which is the state the rule exists to prevent.
      // Reachable from both clients: mobile's locked folder sheet and web's `handleCreateLockedAlbum`
      // both offer "create a locked album from this selection", and the locked folder lists every
      // locked asset, members of locked albums included.
      //
      // Refused rather than evicted, matching the check above it: `create` reports a bad request, it
      // does not quietly rearrange albums the caller never named. Moving between locked albums has
      // its own route -- `POST /albums/:id/locked-assets` -- which evicts on purpose.
      //
      // No album to exclude: the one that would be excluded does not exist yet.
      const conflictingAssetIds = await this.albumRepository.getAssetIdsInOtherLockedAlbums(requestedAssetIds);
      if (conflictingAssetIds.size > 0) {
        throw new BadRequestException(
          'Some of these assets are already in a locked album. Remove them from it first, or use the locked-assets route on the album you want them in',
        );
      }
    }

    const userMetadata = await this.userRepository.getMetadata(auth.user.id);

    const album = await this.albumRepository.create(
      {
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: assetIds[0] || null,
        order: getPreferences(userMetadata).albums.defaultAssetOrder,
        isLocked: dto.isLocked ?? false,
      },
      assetIds,
      [{ userId: auth.user.id, role: AlbumUserRole.Owner }, ...albumUsers],
      auth.user.id,
      forViewer(auth),
    );

    for (const { userId } of albumUsers) {
      await this.eventRepository.emit('AlbumInvite', { id: album.id, userId, senderName: auth.user.name });
    }

    return mapAlbum(album);
  }

  async update(auth: AuthDto, id: string, dto: UpdateAlbumDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: true }, forViewer(auth));

    if (dto.albumThumbnailAssetId) {
      const results = await this.albumRepository.getAssetIds(id, [dto.albumThumbnailAssetId]);
      if (results.size === 0) {
        throw new BadRequestException('Invalid album thumbnail');
      }
    }
    const updatedAlbum = await this.albumRepository.update(
      album.id,
      {
        id: album.id,
        albumName: dto.albumName,
        description: dto.description,
        albumThumbnailAssetId: dto.albumThumbnailAssetId,
        isActivityEnabled: dto.isActivityEnabled,
        order: dto.order,
        isHidden: dto.isHidden,
      },
      auth.user.id,
    );

    return mapAlbum({ ...updatedAlbum, assets: album.assets });
  }

  /**
   * Move an existing album, contents and all, into or out of the locked folder.
   *
   * Upstream only allowed locking at creation time, which in practice meant locked albums could only
   * ever be assembled photo-by-photo from the locked folder: setting an asset to Locked evicts it from
   * every album, so an ordinary album whose assets were all already locked could not exist. This is the
   * operation that was missing, and it is deliberately not a field on `UpdateAlbumDto` -- it rewrites
   * the visibility of every member asset and their memberships elsewhere, so it must not be able to
   * half-apply alongside a rename.
   *
   * Every precondition below is a refusal rather than a fix-up. Locking is the one direction where
   * guessing wrong is unrecoverable for the user (their photos vanish from the timeline and they may not
   * know why), so anything ambiguous is reported instead of resolved.
   */
  async setLocked(auth: AuthDto, id: string, dto: AlbumSetLockedDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    // Required in both directions. Locking without it would let a session that cannot itself open the
    // locked folder put photos beyond its own reach; unlocking without it would be a way to empty
    // someone's locked folder from an unelevated session.
    requireElevatedPermission(auth);

    // Owner only: handing an editor the ability to move the owner's photos into a locked folder they
    // cannot open is not a power sharing should confer.
    const album = await this.findOwnedOrFail(auth, id, 'Only the album owner can lock or unlock an album');

    if (album.isLocked === dto.isLocked) {
      return mapAlbum(album);
    }

    // Read separately rather than from `album.assets`: that list comes through `Surface.AlbumContents`,
    // whose `elevatedAdds` is empty, so it never contains locked assets even for an elevated session.
    // Using it made unlocking a no-op on the photos - the album became ordinary while its contents stayed
    // in the locked folder. This operation has to see the members it is about to change.
    const members = await this.albumRepository.getMemberAssetsForLockChange(album.id);
    const assetIds = members.map((asset) => asset.id);

    if (dto.isLocked) {
      // A locked album must not be readable by anyone else, and `checkAlbumAccess` grants asset reads
      // through album membership. Refusing is better than silently revoking other people's access.
      //
      // Shared links count as sharing here even though they already fail closed - a link carries no
      // session, so it is never elevated and the album access check turns it away. Refusing anyway means
      // the user is never left holding a link that has quietly stopped working, and it matches what the
      // web modal already tells them by disabling the switch.
      const sharedWithUser = album.albumUsers.some(({ user }) => user.id !== auth.user.id);
      const sharedByLink = (album.sharedLinks ?? []).length > 0;
      if (sharedWithUser || sharedByLink) {
        throw new BadRequestException('Unshare the album before locking it');
      }

      // Contributed assets belong to their owner; locking them would hide another user's photo from
      // that user. Checked against the assets in hand rather than by a permission call, because
      // `Permission.AssetUpdate` would pass for assets shared *to* this user as well.
      if (members.some((asset) => asset.ownerId !== auth.user.id)) {
        throw new BadRequestException('An album can only be locked if you own every asset in it');
      }

      await this.moveIntoLockedFolder(assetIds, id);
    } else {
      // Timeline, not archive: it is the default visibility and the same value the single-asset "remove
      // from locked folder" action restores. Memberships are left alone -- the assets stay in this album,
      // which is now an ordinary one.
      //
      // Known consequence, shared with that single-asset action: an asset that was *archived* before the
      // album was locked comes back to the timeline rather than to the archive. `visibility` is one
      // exclusive column, so locking overwrote the archive state and there is nowhere it was kept.
      // Restoring it would mean recording the previous value somewhere, which is a bigger change than
      // this operation warrants; matching the existing unlock behaviour is the consistent choice.
      await this.assetRepository.updateAll(assetIds, { visibility: AssetVisibility.Timeline });
    }

    const updated = await this.albumRepository.update(album.id, { id: album.id, isLocked: dto.isLocked }, auth.user.id);

    await this.queueSidecarWrites(assetIds);
    await this.notifyAlbumChanged(album);

    return mapAlbum({ ...updated, assets: album.assets });
  }

  /**
   * Sets the album's per-surface rule for its photos.
   *
   * Its own route rather than a field on `UpdateAlbumDto`, like `setLocked`, because it rewrites derived
   * state on every member and must not half-apply alongside a rename. Unlike locking it needs **no
   * elevation** and carries no invariant: it changes where photos appear, not whether they are
   * confidential, and it is freely reversible.
   *
   * Owner-only for the same reason locking is. `Permission.AlbumUpdate` extends to editors, and an
   * editor taking the owner's photos off their own timeline is not a power sharing should confer -
   * the rule reaches assets the editor does not own.
   *
   * The inheritance itself is not written here. `album.hiddenFrom` is the only thing this touches; the
   * database triggers installed by `AlbumVisibilityInheritance` recompute every member's
   * `hiddenFromInherited`. That is deliberate - see `asset_sync_hidden_from_inherited` for why a derived
   * column maintained by call sites is a column that eventually goes wrong.
   */
  async setHiddenFrom(auth: AuthDto, id: string, dto: AlbumSetHiddenFromDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumUpdate, ids: [id] });

    const album = await this.findOwnedOrFail(
      auth,
      id,
      "Only the album owner can change where an album's photos appear",
    );

    const hiddenFrom = toHiddenFromMask(dto.hiddenFrom);
    if (album.hiddenFrom === hiddenFrom) {
      return mapAlbum(album);
    }

    const updated = await this.albumRepository.update(album.id, { id: album.id, hiddenFrom }, auth.user.id);

    await this.notifyAlbumChanged(album);

    return mapAlbum({ ...updated, assets: album.assets });
  }

  /**
   * Lock the named assets and put them in this locked album, in one operation.
   *
   * The gap this closes: a locked album may only contain assets that are already locked, and locking an
   * asset evicts it from every album it is in. So "put this timeline photo in my locked album" was two
   * operations that could not be expressed together -- lock it (it leaves every album, including the one
   * you wanted), then find it in the locked folder and add it. On the phone that meant leaving the
   * timeline, entering the PIN, and hunting for the photo again.
   *
   * Its own route rather than a flag on `addAssets` for the reason `setLocked` is its own route: it
   * rewrites asset visibility and other albums' membership, and half-applying that is unrecoverable
   * without knowing what the previous state was. Doing it client-side as two calls is the version to
   * avoid outright -- an interruption between them leaves photos locked and in no album at all, which
   * is indistinguishable from having lost them.
   *
   * Two consequences the caller has to have agreed to, both inherent rather than fixable here. An
   * asset that was **archived** returns to the *timeline* if the album is later unlocked, because
   * `visibility` is one exclusive column and locking overwrote the archive state. And the asset leaves
   * every other album, which is the invariant that keeps a locked photo unreachable through an
   * ordinary album's membership.
   */
  async addLockedAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    // Required for the same reason `setLocked` requires it: this puts photos somewhere the session
    // would not otherwise be able to reach them.
    requireElevatedPermission(auth);

    const album = await this.findOwnedOrFail(auth, id, 'Only the album owner can add to a locked album');

    // An ordinary album has `addAssets`, which does not lock anything. Refusing rather than falling
    // back to it keeps this route from being a way to lock photos by accident.
    if (!album.isLocked) {
      throw new BadRequestException('This album is not locked. Use the ordinary add-assets endpoint');
    }

    // `Permission.AssetUpdate` rather than `AssetShare`: share hardcodes non-elevated access, so every
    // already-locked asset in the request would be filtered out and silently dropped. Update respects
    // elevation and is the right question anyway -- this changes the asset, it does not share it. Same
    // reasoning as `create` and `addAssets` above.
    const allowedIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: dto.ids });

    // Validate against what was asked for, not what survived the filter: otherwise an asset belonging
    // to someone else is dropped from the result instead of failing the request, and the user is left
    // believing photos moved that did not.
    if (allowedIds.size !== dto.ids.length) {
      throw new BadRequestException('A locked album can only contain assets you own');
    }

    const existing = await this.albumRepository.getAssetIds(id, dto.ids);
    const toAdd = dto.ids.filter((assetId) => !existing.has(assetId));

    if (toAdd.length > 0) {
      await this.moveIntoLockedFolder(toAdd, id);
      await this.albumRepository.addAssetIds(id, toAdd);
      await this.queueSidecarWrites(toAdd);
      await this.notifyAlbumChanged(album);
    }

    return dto.ids.map((assetId) => ({
      id: assetId,
      success: !existing.has(assetId),
      ...(existing.has(assetId) && { error: BulkIdErrorReason.DUPLICATE }),
    }));
  }

  async delete(auth: AuthDto, id: string): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumDelete, ids: [id] });
    await this.albumRepository.delete(id);
  }

  async addAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: false }, forViewer(auth));
    await this.requireAccess({ auth, permission: Permission.AlbumAssetCreate, ids: [id] });

    let results: BulkIdResponseDto[];

    if (album.isLocked) {
      // A locked album can only ever contain assets that are already locked (already sitting in
      // the locked folder) -- reject outright rather than silently dropping the offending assets.
      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(dto.ids);
      if (lockedAssetIds.size !== dto.ids.length) {
        throw new BadRequestException(LockedAlbumError.NeedsLockedAssets);
      }

      // Can't use the shared addAssets() util below here. Upstream now takes the permission as a
      // parameter rather than hardcoding Permission.AssetShare, so that half of the original reason
      // is gone -- but the rest stands: this branch also has to report ALREADY_IN_LOCKED_ALBUM and
      // to refuse assets that are not already locked, neither of which addAssets knows about.
      //
      // Permission.AssetUpdate rather than AssetShare, because AssetShare hardcodes non-elevated
      // access -- deliberately, since it also covers shared-link and album-sharing paths that must
      // never expose locked content. AssetUpdate respects elevation, and organizing an asset the
      // requester already owns (and has already locked) into a locked album they also own doesn't
      // expose it to anyone else.
      const existingAssetIds = await this.albumRepository.getAssetIds(id, dto.ids);
      const notPresentAssetIds = dto.ids.filter((assetId) => !existingAssetIds.has(assetId));

      // An asset can only ever belong to one locked album at a time -- if it's already in a
      // different locked album, reject it outright rather than silently moving it out of that
      // album.
      const conflictingAssetIds = await this.albumRepository.getAssetIdsInOtherLockedAlbums(notPresentAssetIds, id);
      const checkableAssetIds = notPresentAssetIds.filter((assetId) => !conflictingAssetIds.has(assetId));

      const allowedAssetIds = await this.checkAccess({
        auth,
        permission: Permission.AssetUpdate,
        ids: checkableAssetIds,
      });

      results = dto.ids.map((assetId) => {
        if (existingAssetIds.has(assetId)) {
          return { id: assetId, success: false, error: BulkIdErrorReason.DUPLICATE };
        }
        if (conflictingAssetIds.has(assetId)) {
          return { id: assetId, success: false, error: BulkIdErrorReason.ALREADY_IN_LOCKED_ALBUM };
        }
        if (!allowedAssetIds.has(assetId)) {
          return { id: assetId, success: false, error: BulkIdErrorReason.NO_PERMISSION };
        }
        return { id: assetId, success: true };
      });

      const newAssetIds = results.filter(({ success }) => success).map(({ id: assetId }) => assetId);
      if (newAssetIds.length > 0) {
        await this.albumRepository.addAssetIds(id, newAssetIds);
      }
    } else {
      results = await addAssets(
        auth,
        { access: this.accessRepository, bulk: this.albumRepository },
        { parentId: id, assetIds: dto.ids, permission: Permission.AssetShare },
      );
    }

    const { id: firstNewAssetId } = results.find(({ success }) => success) || {};
    if (firstNewAssetId) {
      await this.albumRepository.update(
        id,
        {
          id,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? firstNewAssetId,
        },
        auth.user.id,
      );

      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      await this.eventRepository.emit('AlbumUpdate', { id, userIds, recipientIds });
      await this.eventRepository.emit('AlbumAssetsAdded');
    }

    return results;
  }

  async addAssetsToAlbums(auth: AuthDto, dto: AlbumsAddAssetsDto): Promise<AlbumsAddAssetsResponseDto> {
    const results: AlbumsAddAssetsResponseDto = {
      success: false,
      error: BulkIdErrorReason.DUPLICATE,
    };

    const allowedAlbumIds = await this.checkAccess({
      auth,
      permission: Permission.AlbumAssetCreate,
      ids: dto.albumIds,
    });
    if (allowedAlbumIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    // An asset can only ever belong to one locked album at a time -- so a single add-to-albums
    // call can target any number of unlocked albums together, or exactly one locked album alone,
    // but never 2+ locked albums or a locked+unlocked mix. Mirrors the client-side check in the
    // album picker, enforced here too for any caller.
    const lockedTargetAlbumIds = await this.albumRepository.getLockedAlbumIds([...allowedAlbumIds]);
    if (lockedTargetAlbumIds.size > 1 || (lockedTargetAlbumIds.size === 1 && allowedAlbumIds.size > 1)) {
      throw new BadRequestException('Assets can only be added to one locked album at a time');
    }

    const isLockedTarget = lockedTargetAlbumIds.size === 1;
    let allowedAssetIds: Set<string>;

    if (isLockedTarget) {
      // A locked album can only ever contain assets that are already locked (already sitting in
      // the locked folder) -- reject outright rather than converting/evicting them.
      const lockedAssetIds = await this.assetRepository.getLockedAssetIds(dto.assetIds);
      if (lockedAssetIds.size !== dto.assetIds.length) {
        throw new BadRequestException(LockedAlbumError.NeedsLockedAssets);
      }

      // An asset can only ever belong to one locked album at a time -- if it's already in a
      // different locked album, reject it outright rather than moving it out of that album.
      const [targetAlbumId] = lockedTargetAlbumIds;
      const conflictingAssetIds = await this.albumRepository.getAssetIdsInOtherLockedAlbums(
        dto.assetIds,
        targetAlbumId,
      );
      if (conflictingAssetIds.size === dto.assetIds.length) {
        results.error = BulkIdErrorReason.ALREADY_IN_LOCKED_ALBUM;
        return results;
      }
      const checkableAssetIds = dto.assetIds.filter((assetId) => !conflictingAssetIds.has(assetId));

      // Permission.AssetShare (used below for the unlocked-album path) hardcodes non-elevated
      // access, since it also covers shared-link/album-sharing paths that must never expose locked
      // content -- so it would reject every one of these assets outright. AssetUpdate respects
      // elevation, and organizing an asset the requester already owns into a locked album they
      // also own doesn't expose it to anyone else.
      allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetUpdate, ids: checkableAssetIds });
    } else {
      allowedAssetIds = await this.checkAccess({ auth, permission: Permission.AssetShare, ids: dto.assetIds });
    }

    if (allowedAssetIds.size === 0) {
      results.error = BulkIdErrorReason.NO_PERMISSION;
      return results;
    }

    const albumAssetValues: { albumId: string; assetId: string }[] = [];
    const updateEvents: { id: string; userIds: string[]; recipientIds: string[] }[] = [];
    for (const albumId of allowedAlbumIds) {
      const existingAssetIds = await this.albumRepository.getAssetIds(albumId, [...allowedAssetIds]);
      const notPresentAssetIds = [...allowedAssetIds.difference(existingAssetIds)];
      if (notPresentAssetIds.length === 0) {
        continue;
      }
      const album = await this.findOrFail(albumId, auth.user.id, { withAssets: false }, forViewer(auth));
      results.error = undefined;
      results.success = true;

      for (const assetId of notPresentAssetIds) {
        albumAssetValues.push({ albumId, assetId });
      }
      await this.albumRepository.update(
        albumId,
        {
          id: albumId,
          updatedAt: new Date(),
          albumThumbnailAssetId: album.albumThumbnailAssetId ?? notPresentAssetIds[0],
        },
        auth.user.id,
      );
      const userIds = album.albumUsers.map(({ user }) => user.id);
      const recipientIds = userIds.filter((userId) => userId !== auth.user.id);
      updateEvents.push({ id: albumId, userIds, recipientIds });
    }

    await this.albumRepository.addAssetIdsToAlbums(albumAssetValues);
    for (const event of updateEvents) {
      await this.eventRepository.emit('AlbumUpdate', event);
    }
    await this.eventRepository.emit('AlbumAssetsAdded');

    return results;
  }

  async removeAssets(auth: AuthDto, id: string, dto: BulkIdsDto): Promise<BulkIdResponseDto[]> {
    await this.requireAccess({ auth, permission: Permission.AlbumAssetDelete, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false }, forViewer(auth));
    const results = await removeAssets(
      auth,
      { access: this.accessRepository, bulk: this.albumRepository },
      { parentId: id, assetIds: dto.ids, canAlwaysRemove: Permission.AlbumDelete },
    );

    const removedIds = results.filter(({ success }) => success).map(({ id }) => id);
    if (removedIds.length > 0) {
      if (album.albumThumbnailAssetId && removedIds.includes(album.albumThumbnailAssetId)) {
        await this.albumRepository.updateThumbnails();
      }

      await this.eventRepository.emit('AlbumUpdate', {
        id,
        userIds: album.albumUsers.map(({ user }) => user.id),
        recipientIds: [],
      });
    }

    return results;
  }

  async addUsers(auth: AuthDto, id: string, { albumUsers }: AddUsersDto): Promise<AlbumResponseDto> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false }, forViewer(auth));

    // The mirror of `setLocked`'s "unshare the album before locking it". Without it the invariant that
    // check enforces is only true at the moment of locking: an elevated owner could lock an album and
    // then invite someone, producing a shared locked album -- which fails closed for the recipient, but
    // is exactly the state the lock switch used to refuse to unlock. Refuse the sharing instead, since
    // that is the half the user can still change their mind about.
    if (album.isLocked) {
      throw new BadRequestException(LockedAlbumError.CannotBeShared);
    }

    for (const { userId, role } of albumUsers) {
      if (role === AlbumUserRole.Owner) {
        throw new BadRequestException('Cannot add another owner');
      }

      const exists = album.albumUsers.some(({ user: { id } }) => id === userId);
      if (exists) {
        continue;
      }

      const user = await this.userRepository.get(userId, {});
      if (!user) {
        this.logger.debug('Adding user to album failed: user not found');
        throw new BadRequestException('Invalid user');
      }

      await this.albumUserRepository.create({ userId, albumId: id, role });
      await this.eventRepository.emit('AlbumInvite', { id, userId, senderName: auth.user.name });
    }

    return mapAlbum(await this.findOrFail(id, auth.user.id, { withAssets: true }, forViewer(auth)));
  }

  async removeUser(auth: AuthDto, id: string, userId: string | 'me'): Promise<void> {
    if (userId === 'me') {
      userId = auth.user.id;
    }

    const album = await this.findOrFail(id, auth.user.id, { withAssets: false }, forViewer(auth));

    const exists = album.albumUsers.find(({ user: { id } }) => id === userId);
    if (!exists) {
      throw new BadRequestException('Album not shared with user');
    }

    if (
      exists.role === AlbumUserRole.Owner &&
      album.albumUsers.filter(({ role }) => role === AlbumUserRole.Owner).length === 1
    ) {
      throw new BadRequestException('Cannot remove the last album owner');
    }

    // non-admin can remove themselves
    if (auth.user.id !== userId) {
      await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });
    }

    await this.albumUserRepository.delete({ albumId: id, userId });
  }

  async updateUser(auth: AuthDto, id: string, userId: string, dto: UpdateAlbumUserDto): Promise<void> {
    await this.requireAccess({ auth, permission: Permission.AlbumShare, ids: [id] });

    const album = await this.findOrFail(id, userId, { withAssets: false }, forViewer(auth));
    const owner = album.albumUsers[0];

    if (owner.user.id === userId) {
      throw new BadRequestException('User is owner');
    }

    await this.albumUserRepository.update({ albumId: id, userId }, { role: dto.role });
  }

  private findOrFail(id: string, authUserId: string, options: AlbumInfoOptions, ctx: PolicyContext) {
    return findOrFail(() => this.albumRepository.getById(id, options, ctx, authUserId), 'Album');
  }

  /**
   * Set [assetIds] to Locked and evict them from every album except [keepInAlbumId].
   *
   * The two statements are one operation and have to stay one: a locked asset that is still reachable
   * through an ordinary album's membership is the locked folder leaking, since `checkAlbumAccess`
   * grants asset reads through album membership. Both callers here -- locking an existing album, and
   * moving timeline photos into a locked one -- had this pair written out inline, which is one call
   * site away from someone adding a third that locks without evicting.
   */
  private async moveIntoLockedFolder(assetIds: string[], keepInAlbumId: string) {
    await this.assetRepository.updateAll(assetIds, { visibility: AssetVisibility.Locked });
    await this.albumRepository.removeAssetsFromOtherAlbums(assetIds, keepInAlbumId);
  }

  /**
   * Queue the sidecar rewrite that every visibility change owes, so the files on disk say what the
   * database says. The same follow-up the single-asset visibility action queues.
   */
  private async queueSidecarWrites(assetIds: string[]) {
    await this.jobRepository.queueAll(assetIds.map((id) => ({ name: JobName.SidecarWrite, data: { id } })));
  }

  /**
   * Tell every member's clients that the album changed, so they re-read instead of going stale.
   *
   * `AlbumUpdate` reaches the browser and the phone by two different routes, and both matter here.
   * `NotificationService.onAlbumUpdate` turns it into the `on_album_update` websocket message; mobile
   * maps that straight onto `backgroundSync.syncRemote`, and web's timeline listens for it. Without
   * this, `setLocked` and `setHiddenFrom` -- the two operations with the largest fan-out onto member
   * assets, since both rewrite state on every photo in the album -- were the only album mutations that
   * told nobody. The visible symptom was having to restart the app before a rule change showed up.
   *
   * `recipientIds` stays empty on purpose: it drives the "album updated" *email*, which is for someone
   * else adding photos to an album you share. Both callers here are owner-only operations on the
   * owner's own album, so an email would be the owner mailing themselves.
   */
  private async notifyAlbumChanged(album: { id: string; albumUsers: { user: { id: string } }[] }) {
    await this.eventRepository.emit('AlbumUpdate', {
      id: album.id,
      userIds: album.albumUsers.map(({ user }) => user.id),
      recipientIds: [],
    });
  }

  /**
   * The album, refusing anyone but its owner, with [message] naming the operation.
   *
   * `Permission.AlbumUpdate` is granted to editors too, so every operation that rewrites the album's
   * *contents* rather than its label has to narrow to the owner on its own. Ownership lives in
   * `albumUsers` as the Owner role rather than as a column on `album`, which is why this is a find
   * rather than a predicate.
   */
  private async findOwnedOrFail(auth: AuthDto, id: string, message: string) {
    const album = await this.findOrFail(id, auth.user.id, { withAssets: true }, forViewer(auth));

    const owner = album.albumUsers.find(({ role }) => role === AlbumUserRole.Owner);
    if (owner?.user.id !== auth.user.id) {
      throw new BadRequestException(message);
    }

    return album;
  }
}
