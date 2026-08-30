import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/extensions/asset_surface_extensions.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
// ignore: import_rule_openapi
import 'package:openapi/api.dart' hide AlbumUserRole, AssetSurface;

final albumApiRepositoryProvider = Provider((ref) => AlbumApiRepository(ref.watch(apiServiceProvider).albumsApi));

class AlbumApiRepository extends ApiRepository {
  final AlbumsApi _api;

  AlbumApiRepository(this._api);

  /// [isLocked] creates the album already locked, which the server only permits when every id in
  /// [assetIds] is already a locked asset. Locking an album that already exists is a different call -
  /// see [setLocked].
  Future<RemoteAlbum> createDriftAlbum(
    String name,
    UserDto owner, {
    required Iterable<String> assetIds,
    String? description,
    bool isLocked = false,
    String? parentId,
  }) async {
    final responseDto = await checkNull(
      _api.createAlbum(
        CreateAlbumDto(
          albumName: name,
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          assetIds: Optional.present(assetIds.toList()),
          isLocked: Optional.present(isLocked),
          parentId: parentId == null ? const Optional.absent() : Optional.present(parentId),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<({List<String> removed, List<String> failed})> removeAssets(String albumId, Iterable<String> assetIds) async {
    final response = await checkNull(_api.removeAssetFromAlbum(albumId, BulkIdsDto(ids: assetIds.toList())));
    final List<String> removed = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        removed.add(dto.id);
      } else {
        failed.add(dto.id);
      }
    }
    return (removed: removed, failed: failed);
  }

  /// Splits an add-assets response into what landed and what did not.
  ///
  /// A duplicate is neither: the asset is in the album, which is what the caller asked for, so counting
  /// it as a failure would report an error for a request that achieved its goal. Shared by [addAssets]
  /// and [addLockedAssets], which get the same `BulkIdResponseDto[]` from two different routes -- the
  /// loop was written out twice and the two must agree about what "failed" means.
  ({List<String> added, List<String> failed}) _partitionAdded(List<BulkIdResponseDto> response) {
    final List<String> added = [];
    final List<String> failed = [];
    for (final dto in response) {
      if (dto.success) {
        added.add(dto.id);
      } else if (dto.error.orElse(null) != BulkIdErrorReason.duplicate) {
        failed.add(dto.id);
      }
    }

    return (added: added, failed: failed);
  }

  Future<({List<String> added, List<String> failed})> addAssets(
    String albumId,
    Iterable<String> assetIds, {
    Future<void>? abortTrigger,
  }) async {
    final response = await checkNull(
      _api.addAssetsToAlbum(albumId, BulkIdsDto(ids: assetIds.toList()), abortTrigger: abortTrigger),
    );
    return _partitionAdded(response);
  }

  /// Locks [assetIds] and adds them to a locked album, as one server-side operation.
  ///
  /// Not [addAssets] with a lock beforehand: a locked album may only contain locked assets, and locking
  /// an asset evicts it from every album, so the two-call version has a window where the photos are
  /// locked and in no album at all. Requires an elevated session; the server refuses otherwise.
  Future<({List<String> added, List<String> failed})> addLockedAssets(
    String albumId,
    Iterable<String> assetIds, {
    Future<void>? abortTrigger,
  }) async {
    final response = await checkNull(
      _api.addLockedAssetsToAlbum(albumId, BulkIdsDto(ids: assetIds.toList()), abortTrigger: abortTrigger),
    );
    return _partitionAdded(response);
  }

  Future<RemoteAlbum> updateAlbum(
    String albumId,
    UserDto owner, {
    String? name,
    String? description,
    String? thumbnailAssetId,
    bool? isActivityEnabled,
    AlbumAssetOrder? order,
  }) async {
    AssetOrder? apiOrder;
    if (order != null) {
      apiOrder = order == AlbumAssetOrder.asc ? AssetOrder.asc : AssetOrder.desc;
    }

    final responseDto = await checkNull(
      _api.updateAlbumInfo(
        albumId,
        UpdateAlbumDto(
          albumName: name == null ? const Optional.absent() : Optional.present(name),
          description: description == null
              ? const Optional.absent()
              : Optional.present(description.isEmpty ? null : description),
          albumThumbnailAssetId: thumbnailAssetId == null
              ? const Optional.absent()
              : Optional.present(thumbnailAssetId),
          isActivityEnabled: isActivityEnabled == null ? const Optional.absent() : Optional.present(isActivityEnabled),
          order: apiOrder == null ? const Optional.absent() : Optional.present(apiOrder),
        ),
      ),
    );

    return responseDto.toRemoteAlbum(owner);
  }

  Future<void> deleteAlbum(String albumId) {
    return _api.deleteAlbum(albumId);
  }

  Future<void> addUsers(String albumId, Iterable<String> userIds) async {
    final albumUsers = userIds.map((userId) => AlbumUserAddDto(userId: userId)).toList();
    await checkNull(_api.addUsersToAlbum(albumId, AddUsersDto(albumUsers: albumUsers)));
  }

  Future<void> removeUser(String albumId, {required String userId}) async {
    await _api.removeUserFromAlbum(albumId, userId);
  }

  Future<bool> setActivityStatus(String albumId, bool isEnabled) async {
    final response = await checkNull(
      _api.updateAlbumInfo(albumId, UpdateAlbumDto(isActivityEnabled: Optional.present(isEnabled))),
    );
    return response.isActivityEnabled;
  }

  Future<bool> setHidden(String albumId, bool isHidden) async {
    final response = await checkNull(
      _api.updateAlbumInfo(albumId, UpdateAlbumDto(isHidden: Optional.present(isHidden))),
    );
    return response.isHidden;
  }

  /// Its own route, like [setLocked], because the server rewrites derived state on every member asset and
  /// must not be able to half-apply alongside a rename. Replaces the whole set; empty clears the rule.
  Future<Set<AssetSurface>> setHiddenFrom(String albumId, Set<AssetSurface> hiddenFrom) async {
    final response = await checkNull(
      _api.setAlbumHiddenFrom(albumId, AlbumSetHiddenFromDto(hiddenFrom: hiddenFrom.map((s) => s.toDto()).toList())),
    );
    return response.hiddenFrom.map((s) => s.toAssetSurface()).toSet();
  }

  /// Move the album into another album, or to the top level with null.
  ///
  /// Its own route rather than a field on `updateAlbumInfo`, because the server validates it against the
  /// rest of the tree -- ownership, cycles, depth, and the locked-flows-down rule -- and a rename that
  /// half-applied a move would leave the hierarchy in a state no check had approved. A refusal comes back
  /// as a 400 with the reason in it; the caller shows it rather than translating it, since the server is
  /// the only thing that knows the whole tree.
  Future<String?> setParent(String albumId, String? parentId) async {
    final response = await checkNull(_api.setAlbumParent(albumId, AlbumSetParentDto(parentId: parentId)));
    return response.parentId;
  }

  /// Its own route rather than a field on `updateAlbumInfo`, because the server rewrites the visibility of
  /// every asset in the album and their memberships elsewhere. See `AlbumService.setLocked`.
  Future<bool> setLocked(String albumId, bool isLocked, {bool includeSubAlbums = false}) async {
    final response = await checkNull(
      _api.setAlbumLocked(
        albumId,
        AlbumSetLockedDto(isLocked: isLocked, includeSubAlbums: Optional.present(includeSubAlbums)),
      ),
    );
    return response.isLocked;
  }

  /// What locking this album, or this branch, would do -- without doing it.
  ///
  /// Read-only. A refusal comes back as `blockedReason` rather than an error, because the caller asked
  /// what *would* happen; saying so before the confirm is better than a confirm followed by a failure,
  /// which asks someone to agree to something that cannot happen.
  Future<AlbumLockImpactResponseDto> getLockImpact(String albumId, {bool includeSubAlbums = false}) async {
    return checkNull(_api.getAlbumLockImpact(albumId, includeSubAlbums: includeSubAlbums.toString()));
  }
}

extension on AlbumResponseDto {
  RemoteAlbum toRemoteAlbum(final UserDto user) {
    return RemoteAlbum(
      id: id,
      name: albumName,
      ownerId: user.id,
      ownerName: user.name,
      description: description,
      createdAt: createdAt,
      updatedAt: updatedAt,
      thumbnailAssetId: albumThumbnailAssetId,
      isActivityEnabled: isActivityEnabled,
      isHidden: isHidden,
      isLocked: isLocked,
      hiddenFrom: hiddenFrom.map((s) => s.toAssetSurface()).toSet(),
      order: order.orElse(null) == AssetOrder.asc ? AlbumAssetOrder.asc : AlbumAssetOrder.desc,
      assetCount: assetCount,
      isShared: albumUsers.length > 2,
    );
  }
}
