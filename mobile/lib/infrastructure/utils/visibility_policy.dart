import 'package:drift/drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/entities/remote_album.entity.drift.dart';
import 'package:immich_mobile/infrastructure/entities/remote_asset.entity.drift.dart';

/// The locked-folder rules mobile enforces, named once instead of re-derived per query.
///
/// `asset.visibility` is a single exclusive enum doing three unrelated jobs — surface exposure,
/// confidentiality, and the motion-photo video-part marker — so every query that reads assets has to
/// decide which values it admits. Spelling that out per call site is how the locked folder leaked into
/// album views in the first place: the three album queries filtered only on `albumId` and `deletedAt`,
/// which was safe only while a locked asset could never be an album member. Locked albums broke that.
///
/// This is deliberately not a port of the server's `visibility-policy.ts` surface table. It names the
/// two rules mobile actually has to get right, and nothing else; the timeline, search, and map
/// predicates keep their inline filters until there is a reason to move them.
abstract final class VisibilityPolicy {
  const VisibilityPolicy._();

  /// The `asset.visibility` values an album view admits.
  ///
  /// The same default set the server applies to album buckets. `locked` is absent, which is the only
  /// thing keeping a locked album's contents off screen without a PIN. `hidden` is absent too, which
  /// keeps motion-photo video parts out of album views as a side effect.
  static const albumAssetVisibility = [AssetVisibility.timeline, AssetVisibility.archive];

  /// [albumAssetVisibility] as a predicate on an album's assets.
  static Expression<bool> albumAssets($RemoteAssetEntityTable asset) =>
      albumAssetVisibility.map(asset.visibility.equalsValue).reduce((a, b) => a | b);

  /// Which albums a listing may show. Locked albums belong to the locked folder and are reachable only
  /// through the PIN/biometric flow, so an unelevated session must not even learn they exist.
  ///
  /// Returns `null` when the session is elevated and every album is admissible, so the caller adds no
  /// clause at all and the elevated query stays exactly the query mobile ran before this existed.
  /// [isElevated] is threaded in from the caller — mirroring the server's `PolicyContext` — rather than
  /// read from global state inside a query.
  static Expression<bool>? albumListing($RemoteAlbumEntityTable album, {required bool isElevated}) =>
      isElevated ? null : album.isLocked.equals(false);
}
