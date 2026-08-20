import 'package:flutter/foundation.dart';
import 'package:freezed_annotation/freezed_annotation.dart';

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
    // Unlike `isLocked` — which is only ever a query filter and never displayed, so it stays off this
    // model — `isHidden` is shown as a switch on the album options screen and needs its current value,
    // the same reason `isActivityEnabled` is here. Follow that precedent, not `isLocked`'s.
    required bool isHidden,
    required AlbumAssetOrder order,
    required int assetCount,
    required String ownerName,
    required bool isShared,
  }) = _RemoteAlbum;
}
