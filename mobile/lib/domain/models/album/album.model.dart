import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';

part 'album.model.freezed.dart';

enum AlbumAssetOrder {
  // do not change this order!
  asc,
  desc,
}

enum AlbumUserRole {
  // do not change this order!
  editor,
  viewer,
  owner,
}

// Model for an album stored in the server
@freezed
abstract class RemoteAlbum with _$RemoteAlbum {
  const factory RemoteAlbum({
    required String id,
    required String name,
    required String ownerId,
    required String description,
    required DateTime createdAt,
    required DateTime updatedAt,
    String? thumbnailAssetId,
    required bool isActivityEnabled,
    // Both of these are shown as switches on the album options screen and so need their current value,
    // the same reason `isActivityEnabled` is here. `isLocked` was deliberately absent while it was only
    // ever a query filter; it stopped being one when locking an existing album became possible.
    required bool isHidden,
    required bool isLocked,

    /// The surfaces this album's photos are withheld from. Six switches on the options screen, so it
    /// needs its current value here for the same reason the two flags above do.
    required Set<AssetSurface> hiddenFrom,

    /// The album this one sits inside, or null at the top level.
    ///
    /// Nullable rather than required, because it is genuinely absent for most albums and because a
    /// child whose parent has not synced yet is a normal state rather than an error.
    String? parentId,
    required AlbumAssetOrder order,
    required int assetCount,
    required String ownerName,
    required bool isShared,
  }) = _RemoteAlbum;
}
