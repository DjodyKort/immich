import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';

/// The six places a single asset can be withheld from, in the order a person meets them in the app rather
/// than the order the enum happens to declare.
const _places = [
  AssetSurface.timeline,
  AssetSurface.search,
  AssetSurface.map,
  AssetSurface.people,
  AssetSurface.memories,
  AssetSurface.folders,
];

/// Asks which places an asset should be withheld from, prefilled with [hiddenFrom].
///
/// Resolves to the chosen set, which **replaces** whatever the asset is withheld from now - an empty set is
/// how "show it everywhere again" is expressed, and is a legitimate answer rather than a cancel. Resolves to
/// `null` when the sheet is dismissed without saving, which is the only "leave it alone" outcome.
Future<Set<AssetSurface>?> showHideFromPlacesPicker({
  required BuildContext context,
  required Set<AssetSurface> hiddenFrom,
}) {
  return showModalBottomSheet<Set<AssetSurface>>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.colorScheme.surfaceContainer,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => _HideFromPlacesPicker(hiddenFrom: hiddenFrom),
  );
}

class _HideFromPlacesPicker extends HookWidget {
  const _HideFromPlacesPicker({required this.hiddenFrom});

  final Set<AssetSurface> hiddenFrom;

  static String _label(BuildContext context, AssetSurface place) => switch (place) {
    AssetSurface.timeline => context.t.hide_from_place_timeline,
    AssetSurface.search => context.t.hide_from_place_search,
    AssetSurface.map => context.t.hide_from_place_map,
    AssetSurface.people => context.t.hide_from_place_people,
    AssetSurface.memories => context.t.hide_from_place_memories,
    AssetSurface.folders => context.t.hide_from_place_folders,
  };

  static String _description(BuildContext context, AssetSurface place) => switch (place) {
    AssetSurface.timeline => context.t.hide_from_place_timeline_description,
    AssetSurface.search => context.t.hide_from_place_search_description,
    AssetSurface.map => context.t.hide_from_place_map_description,
    AssetSurface.people => context.t.hide_from_place_people_description,
    AssetSurface.memories => context.t.hide_from_place_memories_description,
    AssetSurface.folders => context.t.hide_from_place_folders_description,
  };

  @override
  Widget build(BuildContext context) {
    final selected = useState(hiddenFrom);

    void toggle(AssetSurface place, {required bool isHidden}) {
      selected.value = {
        for (final candidate in _places)
          if (candidate == place ? isHidden : selected.value.contains(candidate)) candidate,
      };
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 24, 8, 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: Row(
              children: [
                Icon(Icons.visibility_off_outlined, color: context.primaryColor),
                const SizedBox(width: 12),
                Expanded(
                  child: Text(
                    context.t.hide_from_places,
                    style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
            child: Text(
              context.t.hide_from_places_help,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          // The switches scroll and the buttons below do not, so Save stays reachable on a short screen.
          Flexible(
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final place in _places)
                    SwitchListTile.adaptive(
                      value: selected.value.contains(place),
                      onChanged: (isHidden) => toggle(place, isHidden: isHidden),
                      title: Text(_label(context, place), style: context.textTheme.bodyLarge),
                      subtitle: Text(
                        _description(context, place),
                        style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
                      ),
                      visualDensity: VisualDensity.compact,
                    ),
                ],
              ),
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                TextButton(
                  onPressed: selected.value.isEmpty ? null : () => selected.value = const {},
                  child: Text(context.t.hide_from_places_clear),
                ),
                const Spacer(),
                TextButton(onPressed: context.pop, child: Text(context.t.cancel)),
                TextButton(
                  onPressed: () => context.pop(selected.value),
                  child: Text(
                    context.t.save,
                    style: context.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: context.primaryColor,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
