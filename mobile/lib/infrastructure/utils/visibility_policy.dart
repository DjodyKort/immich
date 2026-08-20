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
/// rules mobile actually has to get right, and nothing else; the remaining `asset.visibility` filters
/// keep their inline predicates until there is a reason to move them.
///
/// It also owns `hiddenFrom`, the per-asset per-surface exclusion mask. That mask is a *local* encoding:
/// sync carries surface names, and mobile assigns its own bit to each name below. Shipping the server's
/// integers would have pinned mobile's stored data to the server's internal bit numbering forever, which
/// is fixed by a test on that side precisely because it can never move.
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

  /// Which albums a listing may show.
  ///
  /// Mirrors the server's two-state `hidden` filter in `album.repository.ts`'s `getAll`: hidden albums
  /// are either the whole point of the request or excluded from it, never mixed in, so [hidden] always
  /// contributes a clause. Locked albums additionally belong to the locked folder and are reachable
  /// only through the PIN/biometric flow, so an unelevated session must not even learn they exist —
  /// that clause is added only when [isElevated] is false, same as before.
  ///
  /// Unlike the single-clause version this replaced, this can no longer return `null`: with the hidden
  /// filter always present there is no longer a case with nothing to add, elevated or not. Callers that
  /// special-cased `null` to mean "no clause" should now just always apply the returned expression.
  /// [isElevated] is threaded in from the caller — mirroring the server's `PolicyContext` — rather than
  /// read from global state inside a query.
  static Expression<bool> albumListing($RemoteAlbumEntityTable album, {required bool isElevated, bool hidden = false}) {
    final visibility = album.isHidden.equals(hidden);
    return isElevated ? visibility : visibility & album.isLocked.equals(false);
  }

  /// The bit each surface occupies in `remote_asset_entity.hidden_from`.
  ///
  /// **These values are written to the local database. Never renumber them and never reuse a retired
  /// bit** — an app update that shifted them would silently reinterpret every existing row. Adding a
  /// surface means taking the next free bit, not reordering. They are unrelated to, and need not agree
  /// with, the server's own bit numbering: sync carries names, and [maskFor] is the only translation.
  /// `test/infrastructure/visibility_policy_test.dart` pins each value by literal.
  static const surfaceBit = <AssetSurface, int>{
    AssetSurface.timeline: 1,
    AssetSurface.search: 2,
    AssetSurface.map: 4,
    AssetSurface.people: 8,
    AssetSurface.memories: 16,
    AssetSurface.folders: 32,
  };

  /// The stored mask for a set of surfaces, as it arrives from sync.
  ///
  /// Returns `null` for an empty set rather than `0`, so "withheld from nothing" has exactly one
  /// spelling in the column — the same choice the server makes, and the value every row written before
  /// this existed already holds.
  static int? maskFor(Iterable<AssetSurface> surfaces) {
    var mask = 0;
    for (final surface in surfaces) {
      mask |= surfaceBit[surface]!;
    }

    return mask == 0 ? null : mask;
  }

  /// The surfaces a stored mask withholds from. The exact inverse of [maskFor].
  ///
  /// Bits belonging to no known surface — written by a newer build of the app, then downgraded — are
  /// ignored rather than throwing: this can run over the whole library, and a mask it cannot fully
  /// describe is not a reason to fail a read.
  static List<AssetSurface> namesFor(int? mask) {
    if (mask == null || mask == 0) {
      return const [];
    }

    return surfaceBit.entries.where((entry) => mask & entry.value != 0).map((entry) => entry.key).toList();
  }

  /// The asset is not withheld from [surface].
  ///
  /// The predicate every local query standing in for one of the six surfaces adds. `null` — every row
  /// before this column existed, and every asset the user has not touched — passes, so a query gains
  /// this clause without changing what it returns.
  static Expression<bool> notHiddenFrom($RemoteAssetEntityTable asset, AssetSurface surface) =>
      notHiddenFromMask(asset.hiddenFrom, surface);

  /// [notHiddenFrom] against a `hidden_from` expression that is not a plain column reference — a
  /// [Subquery] alias, for instance. Same rule, reached from a shape the table overload cannot express.
  static Expression<bool> notHiddenFromMask(Expression<int> hiddenFrom, AssetSurface surface) {
    final int bit = surfaceBit[surface]!;
    return hiddenFrom.isNull() | hiddenFrom.bitwiseAnd(Constant(bit)).equals(0);
  }
}
