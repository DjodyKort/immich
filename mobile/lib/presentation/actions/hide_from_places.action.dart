import 'package:collection/collection.dart';
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

/// Exactly one owned asset, and only when hiding it from somewhere could actually change anything.
///
/// A locked or trashed asset is already withheld from all six places by its own state, so every switch would
/// be a no-op; the web client withholds the action for the same reason. Restricted to a single asset because
/// the set replaces rather than merges: applied to a mixed selection it would silently discard whatever the
/// other assets are already withheld from.
final _stateProvider = Provider.family.autoDispose<String?, ActionSource>((ref, source) {
  final asset = ref.watch(ownedAssetsActionProvider(source)).singleOrNull;
  if (asset == null || asset.isLocked || asset.isTrashed) {
    return null;
  }

  return asset.id;
}, dependencies: [ownedAssetsActionProvider]);

class HideFromPlacesAction extends AssetActionBuilder {
  const HideFromPlacesAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (!ref.watch(_stateProvider(source).select((assetId) => assetId != null))) {
      return null;
    }

    return .new(
      icon: Icons.visibility_off_outlined,
      label: context.t.hide_from_places,
      onAction: () => _edit(context, ref),
    );
  }

  Future<void> _edit(BuildContext context, WidgetRef ref) async {
    final assetId = ref.read(_stateProvider(source));
    if (assetId == null) {
      return;
    }

    try {
      // Prefilled from the stored row, not from the asset in hand: the timeline queries build their assets
      // from a narrower column set and leave `hiddenFrom` empty, so trusting one of those would show every
      // switch off and then save that back, clearing whatever was already set.
      final stored = await ref.read(driftProvider).remoteAssetRepository.get(assetId);
      if (stored == null || !context.mounted) {
        return;
      }

      final places = await showHideFromPlacesPicker(context: context, hiddenFrom: stored.hiddenFrom);
      if (places == null || !context.mounted) {
        return;
      }

      // Hiding from every surface is allowed - it is not a one-way door, the Hidden view exists
      // precisely so this stays findable - but it is easy to flip every switch without meaning to, so it
      // gets a confirmation naming where the asset stays findable rather than applying silently.
      if (places.length == AssetSurface.values.length) {
        final confirmed = await showDialog<bool>(
          context: context,
          builder: (_) => ConfirmDialog(
            title: context.t.hide_from_places_all_confirm_title,
            content: context.t.hide_from_places_all_confirm_prompt(count: 1),
            ok: context.t.hide_from_places_all_confirm_action,
          ),
        );
        if (confirmed != true || !context.mounted) {
          return;
        }
      }

      await saveHiddenFrom(context, ref, assetId, places);
      ref.read(clearSelectionProvider(source))();
    } catch (error, stack) {
      handleError(error, stack: stack, description: "Failed to update where the asset is hidden from");
    }
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
