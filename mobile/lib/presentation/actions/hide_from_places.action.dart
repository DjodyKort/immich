import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';
import 'package:immich_mobile/providers/infrastructure/db.provider.dart';
import 'package:immich_mobile/providers/infrastructure/toast.provider.dart';
import 'package:immich_mobile/utils/error_handler.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/hide_from_places_picker.dart';

/// The owned assets in the selection that hiding could actually change something for.
///
/// Locked assets are included: the locked folder is the timeline with visibility pinned to locked, so the
/// timeline switch decides whether a locked photo shows up there while leaving it in its locked albums.
/// Trashed ones are not, because trash is deliberately the one view no mask can reach.
final _stateProvider = Provider.family.autoDispose<List<String>, ActionSource>((ref, source) {
  return ref
      .watch(ownedAssetsActionProvider(source))
      .where((asset) => !asset.isTrashed)
      .map((asset) => asset.id)
      .toList();
}, dependencies: [ownedAssetsActionProvider]);

class HideFromPlacesAction extends AssetActionBuilder {
  const HideFromPlacesAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (!ref.watch(_stateProvider(source).select((ids) => ids.isNotEmpty))) {
      return null;
    }

    return .new(
      icon: Icons.visibility_off_outlined,
      label: context.t.hide_from_places,
      onAction: () => _edit(context, ref),
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref) async {
    final assetIds = ref.read(_stateProvider(source));
    if (assetIds.isEmpty) {
      return;
    }

    try {
      // Read from the stored rows, not from the assets in hand: the timeline queries build their assets from
      // a narrower column set and leave `hiddenFrom` empty, so trusting one of those would show nothing
      // hidden and then save that back, clearing whatever was already set.
      final repository = ref.read(driftProvider).remoteAssetRepository;
      final stored = <RemoteAsset>[];
      for (final assetId in assetIds) {
        final asset = await repository.get(assetId);
        if (asset != null) {
          stored.add(asset);
        }
      }

      if (stored.isEmpty || !context.mounted) {
        return;
      }

      if (stored.length == 1) {
        await _editOne(context, ref, stored.first);
        return;
      }

      await _editMany(context, ref, stored);
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to update where the asset is hidden from");
    }
  }

  /// One asset replaces its whole set: its true state is on screen, so that is exactly what the switches mean.
  Future<void> _editOne(BuildContext context, WidgetRef ref, RemoteAsset asset) async {
    final places = await showHideFromPlacesPicker(
      context: context,
      hiddenFrom: asset.hiddenFrom,
      locked: asset.isLocked,
    );
    if (places == null || !context.mounted) {
      return;
    }

    if (places.length == AssetSurface.values.length && !await _confirmHidingEverywhere(context, count: 1)) {
      return;
    }
    if (!context.mounted) {
      return;
    }

    await saveHiddenFrom(context, ref, asset.id, places);
    ref.read(clearSelectionProvider(source))();
  }

  /// A selection adjusts instead: the assets need not agree about where they are hidden, and replacing would
  /// flatten them to one value, discarding differences nobody was ever shown.
  Future<void> _editMany(BuildContext context, WidgetRef ref, List<RemoteAsset> assets) async {
    final hiddenCounts = <AssetSurface, int>{
      for (final place in AssetSurface.values) place: assets.where((asset) => asset.hiddenFrom.contains(place)).length,
    };

    // Only when *every* one of them is locked, matching web's rule. A mixed selection has no single
    // right name for that row, and the main-timeline name is the safe one to show: it is the surface
    // the switch actually names, and the locked-folder reading is the special case.
    final edit = await showHideFromPlacesBulkPicker(
      context: context,
      hiddenCounts: hiddenCounts,
      total: assets.length,
      locked: assets.every((asset) => asset.isLocked),
    );
    if (edit == null || edit.isEmpty || !context.mounted) {
      return;
    }

    // Only a full set of "hide" reaches every place; a partial edit cannot, whatever the assets started as.
    if (edit.add.length == AssetSurface.values.length &&
        !await _confirmHidingEverywhere(context, count: assets.length)) {
      return;
    }
    if (!context.mounted) {
      return;
    }

    final message = context.t.hide_from_places_updated(count: assets.length);
    final assetService = ref.read(assetServiceProvider);
    final toastService = ref.read(toastServiceProvider);

    await assetService.updateHiddenFromBulk(
      assets.map((asset) => asset.id).toList(),
      add: edit.add,
      remove: edit.remove,
    );
    toastService.success(message);
    ref.read(clearSelectionProvider(source))();
  }

  /// Hiding from every place is allowed - it is not a one-way door, the Hidden view exists precisely so this
  /// stays findable - but it is easy to set every place without meaning to, so it is confirmed rather than
  /// applied silently.
  Future<bool> _confirmHidingEverywhere(BuildContext context, {required int count}) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (_) => ConfirmDialog(
        title: context.t.hide_from_places_all_confirm_title,
        content: context.t.hide_from_places_all_confirm_prompt(count: count),
        ok: context.t.hide_from_places_all_confirm_action,
      ),
    );

    return confirmed == true;
  }
}

@visibleForTesting
Future<void> saveHiddenFrom(BuildContext context, WidgetRef ref, String assetId, Set<AssetSurface> places) async {
  final message = context.t.hide_from_places_updated(count: 1);
  final assetService = ref.read(assetServiceProvider);
  final toastService = ref.read(toastServiceProvider);

  // The service writes the server's answer to the local row, so the watching queries - the open viewer, the
  // timeline underneath it - reflect this before the next sync runs.
  await assetService.updateHiddenFrom(assetId, places);
  toastService.success(message);
}
