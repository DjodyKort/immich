import 'package:drift/drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/album.drift.dart';
import 'package:immich_mobile/data/db/main/table/remote/asset.drift.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';

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

  /// The `asset.visibility` values an album view admits without a PIN.
  ///
  /// The same default set the server applies to album buckets. `locked` is absent, which is the only
  /// thing keeping a locked album's contents off screen without a PIN. `hidden` is absent too, which
  /// keeps motion-photo video parts out of album views as a side effect.
  static const albumAssetVisibility = [AssetVisibility.timeline, AssetVisibility.archive];

  /// What an album view admits once the session has cleared the PIN/biometric flow.
  ///
  /// `locked` is added and nothing else: a locked album contains only locked assets, so without this an
  /// elevated user opening one saw an empty album — which is what mobile did until this existed, and the
  /// reason locked albums were web-only. `hidden` stays out in both branches; it is the motion-part
  /// marker here, not a confidentiality state, and elevating a session is no reason to start showing
  /// video halves of live photos.
  static const albumAssetVisibilityElevated = [...albumAssetVisibility, AssetVisibility.locked];

  /// The admitted-visibility predicate for an album's assets.
  ///
  /// [isElevated] is threaded in from the caller, mirroring the server's `PolicyContext`, rather than read
  /// from global state inside a query — the same choice [albumListing] makes, and for the same reason: a
  /// query that reaches for ambient auth state is a query whose result depends on when it ran.
  static Expression<bool> albumAssets($RemoteAssetEntityTable asset, {required bool isElevated}) =>
      (isElevated ? albumAssetVisibilityElevated : albumAssetVisibility)
          .map(asset.visibility.equalsValue)
          .reduce((a, b) => a | b);

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
  /// [lockedOnly] inverts the locked clause for the locked folder's own album section: instead of hiding
  /// locked albums it shows nothing else. Without elevation it matches **nothing** rather than everything,
  /// so a caller that forgets to elevate renders an empty section instead of leaking the whole list.
  static Expression<bool> albumListing(
    $RemoteAlbumEntityTable album, {
    required bool isElevated,
    bool hidden = false,
    bool lockedOnly = false,
  }) {
    final visibility = album.isHidden.equals(hidden);

    if (lockedOnly) {
      return isElevated ? visibility & album.isLocked.equals(true) : const Constant(false);
    }

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

  /// [mask] with [add] switched on and [remove] switched off, leaving every other bit alone.
  ///
  /// What makes a multi-asset edit safe. The assets in a selection need not be withheld from the same
  /// places, so computing one replacement set for all of them would discard the difference; adjusting
  /// each asset's own mask by the surfaces the user actually named does not. Mirrors the arithmetic
  /// `AssetRepository.updateAllHiddenFrom` performs server-side, so the local row and the stored row
  /// agree without reading the answer back — which matters because `PUT /assets` returns nothing.
  ///
  /// A surface in both sets would be ambiguous; the server rejects that outright, so it cannot arrive
  /// here from a successful call. Add is applied first regardless, matching the server's `| add` then
  /// `& ~remove`. Normalises back to `null` rather than `0`, keeping "withheld from nothing" to the one
  /// spelling [maskFor] produces.
  static int? adjustMask(int? mask, {required Set<AssetSurface> add, required Set<AssetSurface> remove}) {
    var next = mask ?? 0;
    for (final surface in add) {
      next |= surfaceBit[surface]!;
    }
    for (final surface in remove) {
      next &= ~surfaceBit[surface]!;
    }

    return next == 0 ? null : next;
  }

  /// The asset is not withheld from [surface], by its own setting or by any album it is in.
  ///
  /// The predicate every local query standing in for one of the six surfaces adds. `null` — every row
  /// before these columns existed, and every asset the user has not touched — passes, so a query gains
  /// this clause without changing what it returns.
  ///
  /// The effective rule, matching the server's `EFFECTIVE_HIDDEN_FROM` exactly:
  ///
  /// ```
  /// hiddenFrom | (hiddenFromInherited & ~hiddenFromShown)
  /// ```
  ///
  /// The override is bracketed around the inherited term alone, deliberately. It exists because album
  /// rules combine by union and so can never *reveal* a photo another album hid, and it has no business
  /// cancelling the asset's own `hiddenFrom` — bracketing it this way makes "explicitly hidden and
  /// explicitly shown" unrepresentable rather than something to resolve. Diverging from the server here
  /// would mean the same photo appearing on one client and not the other.
  static Expression<bool> notHiddenFrom($RemoteAssetEntityTable asset, AssetSurface surface) =>
      notHiddenFromMask(asset.hiddenFrom, asset.hiddenFromInherited, asset.hiddenFromShown, surface);

  /// The asset is withheld from something, by its own setting or by an album — the Hidden view's
  /// membership test.
  ///
  /// Asks about the effective mask, so a photo whose every inherited exclusion is overridden back on is
  /// not hidden by anything and correctly drops out of that view.
  static Expression<bool> hasExclusions($RemoteAssetEntityTable asset) =>
      _effectiveMask(asset.hiddenFrom, asset.hiddenFromInherited, asset.hiddenFromShown).equals(0).not();

  /// [notHiddenFrom] against expressions that are not plain column references — [Subquery] aliases, for
  /// instance. Same rule, reached from a shape the table overload cannot express.
  ///
  /// Takes all three masks rather than just the first: a caller that passed only `hiddenFrom` would
  /// silently ignore album rules, which is the kind of divergence this module exists to prevent.
  static Expression<bool> notHiddenFromMask(
    Expression<int> hiddenFrom,
    Expression<int> hiddenFromInherited,
    Expression<int> hiddenFromShown,
    AssetSurface surface,
  ) {
    final int bit = surfaceBit[surface]!;
    return _effectiveMask(hiddenFrom, hiddenFromInherited, hiddenFromShown).bitwiseAnd(Constant(bit)).equals(0);
  }

  /// The effective mask, shared by the predicates below.
  ///
  /// `coalesce` rather than null checks: each column is nullable and null means "nothing", so one
  /// arithmetic expression covers every combination — the same shape the server's
  /// `EFFECTIVE_HIDDEN_FROM` uses.
  static Expression<int> _effectiveMask(
    Expression<int> hiddenFrom,
    Expression<int> hiddenFromInherited,
    Expression<int> hiddenFromShown,
  ) {
    final own = coalesce([hiddenFrom, const Constant(0)]);
    final inherited = coalesce([hiddenFromInherited, const Constant(0)]);
    final shown = coalesce([hiddenFromShown, const Constant(0)]);

    return own.bitwiseOr(inherited.bitwiseAnd(~shown));
  }
}
