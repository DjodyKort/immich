part of 'base_asset.model.dart';

enum AssetVisibility { timeline, hidden, archive, locked }

/// A place the server can withhold a single asset from, independently of its [AssetVisibility].
///
/// Mirrors the server's user-facing `AssetSurface` enum, which is what sync carries. The server's own
/// internal surface numbering is deliberately not shipped, so this enum's declaration order is mobile's
/// business alone; the local bit each member occupies is assigned in `VisibilityPolicy` and pinned by a
/// test, because it is persisted.
enum AssetSurface { timeline, search, map, people, memories, folders }

/// [RemoteAsset.hiddenFrom] compares and hashes as a set, not as a list.
///
/// Dart's `Set ==` is identity, so without this two assets withheld from the same places would never be
/// equal - and the viewer, which rebuilds on every asset change, would rebuild forever.
const _surfaces = SetEquality<AssetSurface>();

// Model for an asset stored in the server
class RemoteAsset extends BaseAsset {
  @override
  final String id;
  final String? localAssetId;
  final String? thumbHash;
  final AssetVisibility visibility;

  /// The surfaces this asset is withheld from, independently of [visibility].
  ///
  /// Empty for every asset nobody has touched, which is the stored `null` mask, so a screen that reads
  /// this behaves exactly as it did before the field existed. Carried as a [Set] because that is what it
  /// is - order is not information, and no surface can appear twice - even though the wire format and the
  /// stored bitmask are both ordered.
  ///
  /// Only the paths that read the asset's own row populate this: the local `remote_asset_entity` row and
  /// an `AssetResponseDto`. The timeline bucket queries select a narrower column set and leave it empty,
  /// exactly as they leave [visibility] at its default, so anything that must act on the real value reads
  /// the row rather than trusting a timeline asset.
  final Set<AssetSurface> hiddenFrom;
  final String ownerId;
  final String? stackId;
  final String? livePhotoVideoId;
  final DateTime? uploadedAt;
  final DateTime? deletedAt;

  const RemoteAsset({
    required this.id,
    String? localId,
    required super.name,
    required this.ownerId,
    required super.checksum,
    required super.type,
    required super.createdAt,
    required super.updatedAt,
    this.uploadedAt,
    super.width,
    super.height,
    super.durationMs,
    super.isFavorite = false,
    this.thumbHash,
    this.visibility = AssetVisibility.timeline,
    this.hiddenFrom = const {},
    this.livePhotoVideoId,
    this.stackId,
    required super.isEdited,
    this.deletedAt,
  }) : localAssetId = localId;

  @override
  String? get localId => localAssetId;

  @override
  AssetPlaybackStyle get playbackStyle {
    if (isVideo) {
      return AssetPlaybackStyle.video;
    }
    if (livePhotoVideoId != null) {
      return AssetPlaybackStyle.livePhoto;
    }
    if (isImage && durationMs != null && durationMs! > 0) {
      return AssetPlaybackStyle.imageAnimated;
    }
    if (isImage) {
      return AssetPlaybackStyle.image;
    }
    return AssetPlaybackStyle.unknown;
  }

  @override
  String? get remoteId => id;

  @override
  AssetState get storage => localId == null ? AssetState.remote : AssetState.merged;

  @override
  String get heroTag => '${localId ?? checksum}_$id';

  @override
  bool get isEditable => isImage && !isMotionPhoto && !isAnimatedImage;

  bool get isTrashed => deletedAt != null;

  bool get isStacked => stackId != null;

  bool get isArchived => visibility == .archive;

  bool get isLocked => visibility == .locked;

  @override
  String toString() {
    return '''Asset {
    id: $id,
    name: $name,
    ownerId: $ownerId,
    type: $type,
    createdAt: $createdAt,
    updatedAt: $updatedAt,
    uploadedAt: ${uploadedAt ?? "<NA>"},
    width: ${width ?? "<NA>"},
    height: ${height ?? "<NA>"},
    durationMs: ${durationMs ?? "<NA>"},
    localId: ${localId ?? "<NA>"},
    isFavorite: $isFavorite,
    thumbHash: ${thumbHash ?? "<NA>"},
    visibility: $visibility,
    hiddenFrom: $hiddenFrom,
    stackId: ${stackId ?? "<NA>"},
    checksum: $checksum,
    livePhotoVideoId: ${livePhotoVideoId ?? "<NA>"},
 }''';
  }

  // Not checking for localId here
  @override
  bool operator ==(Object other) {
    if (other is! RemoteAsset) {
      return false;
    }
    if (identical(this, other)) {
      return true;
    }
    return super == other &&
        id == other.id &&
        ownerId == other.ownerId &&
        thumbHash == other.thumbHash &&
        visibility == other.visibility &&
        _surfaces.equals(hiddenFrom, other.hiddenFrom) &&
        stackId == other.stackId &&
        livePhotoVideoId == other.livePhotoVideoId &&
        uploadedAt == other.uploadedAt &&
        deletedAt == other.deletedAt;
  }

  @override
  int get hashCode =>
      super.hashCode ^
      id.hashCode ^
      ownerId.hashCode ^
      localId.hashCode ^
      thumbHash.hashCode ^
      visibility.hashCode ^
      _surfaces.hash(hiddenFrom) ^
      stackId.hashCode ^
      livePhotoVideoId.hashCode ^
      uploadedAt.hashCode ^
      deletedAt.hashCode;

  RemoteAsset copyWith({
    String? id,
    String? localId,
    String? name,
    String? ownerId,
    String? checksum,
    AssetType? type,
    DateTime? createdAt,
    DateTime? updatedAt,
    DateTime? uploadedAt,
    int? width,
    int? height,
    int? durationMs,
    bool? isFavorite,
    String? thumbHash,
    AssetVisibility? visibility,
    Set<AssetSurface>? hiddenFrom,
    String? livePhotoVideoId,
    String? stackId,
    bool? isEdited,
    DateTime? deletedAt,
  }) {
    return RemoteAsset(
      id: id ?? this.id,
      localId: localId ?? this.localId,
      name: name ?? this.name,
      ownerId: ownerId ?? this.ownerId,
      checksum: checksum ?? this.checksum,
      type: type ?? this.type,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      uploadedAt: uploadedAt ?? this.uploadedAt,
      width: width ?? this.width,
      height: height ?? this.height,
      durationMs: durationMs ?? this.durationMs,
      isFavorite: isFavorite ?? this.isFavorite,
      thumbHash: thumbHash ?? this.thumbHash,
      visibility: visibility ?? this.visibility,
      hiddenFrom: hiddenFrom ?? this.hiddenFrom,
      livePhotoVideoId: livePhotoVideoId ?? this.livePhotoVideoId,
      stackId: stackId ?? this.stackId,
      isEdited: isEdited ?? this.isEdited,
      deletedAt: deletedAt ?? this.deletedAt,
    );
  }
}

class RemoteAssetExif extends RemoteAsset {
  final ExifInfo exifInfo;

  const RemoteAssetExif({
    required super.id,
    super.localId,
    required super.name,
    required super.ownerId,
    required super.checksum,
    required super.type,
    required super.createdAt,
    required super.updatedAt,
    super.uploadedAt,
    super.deletedAt,
    super.width,
    super.height,
    super.durationMs,
    super.isFavorite = false,
    super.thumbHash,
    super.visibility = AssetVisibility.timeline,
    super.hiddenFrom = const {},
    super.livePhotoVideoId,
    super.stackId,
    super.isEdited = false,
    this.exifInfo = const ExifInfo(),
  });

  @override
  bool operator ==(Object other) {
    if (other is! RemoteAssetExif) {
      return false;
    }
    if (identical(this, other)) {
      return true;
    }
    return super == other && exifInfo == other.exifInfo;
  }

  @override
  int get hashCode => super.hashCode ^ exifInfo.hashCode;

  @override
  RemoteAssetExif copyWith({
    String? id,
    String? localId,
    String? name,
    String? ownerId,
    String? checksum,
    AssetType? type,
    DateTime? createdAt,
    DateTime? updatedAt,
    DateTime? uploadedAt,
    DateTime? deletedAt,
    int? width,
    int? height,
    int? durationMs,
    bool? isFavorite,
    String? thumbHash,
    AssetVisibility? visibility,
    Set<AssetSurface>? hiddenFrom,
    String? livePhotoVideoId,
    String? stackId,
    bool? isEdited,
    ExifInfo? exifInfo,
  }) {
    return RemoteAssetExif(
      id: id ?? this.id,
      localId: localId ?? this.localId,
      name: name ?? this.name,
      ownerId: ownerId ?? this.ownerId,
      checksum: checksum ?? this.checksum,
      type: type ?? this.type,
      createdAt: createdAt ?? this.createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
      uploadedAt: uploadedAt ?? this.uploadedAt,
      deletedAt: deletedAt ?? this.deletedAt,
      width: width ?? this.width,
      height: height ?? this.height,
      durationMs: durationMs ?? this.durationMs,
      isFavorite: isFavorite ?? this.isFavorite,
      thumbHash: thumbHash ?? this.thumbHash,
      visibility: visibility ?? this.visibility,
      hiddenFrom: hiddenFrom ?? this.hiddenFrom,
      livePhotoVideoId: livePhotoVideoId ?? this.livePhotoVideoId,
      stackId: stackId ?? this.stackId,
      isEdited: isEdited ?? this.isEdited,
      exifInfo: exifInfo ?? this.exifInfo, // Use the new parameter
    );
  }
}
