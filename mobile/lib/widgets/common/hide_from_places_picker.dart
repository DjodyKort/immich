import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';

/// The six places an asset can be withheld from, in the order a person meets them in the app rather
/// than the order the enum happens to declare.
const _places = [
  AssetSurface.timeline,
  AssetSurface.search,
  AssetSurface.map,
  AssetSurface.people,
  AssetSurface.memories,
  AssetSurface.folders,
];

String _placeLabel(BuildContext context, AssetSurface place) => switch (place) {
  AssetSurface.timeline => context.t.hide_from_place_timeline,
  AssetSurface.search => context.t.hide_from_place_search,
  AssetSurface.map => context.t.hide_from_place_map,
  AssetSurface.people => context.t.hide_from_place_people,
  AssetSurface.memories => context.t.hide_from_place_memories,
  AssetSurface.folders => context.t.hide_from_place_folders,
};

String _placeDescription(BuildContext context, AssetSurface place) => switch (place) {
  AssetSurface.timeline => context.t.hide_from_place_timeline_description,
  AssetSurface.search => context.t.hide_from_place_search_description,
  AssetSurface.map => context.t.hide_from_place_map_description,
  AssetSurface.people => context.t.hide_from_place_people_description,
  AssetSurface.memories => context.t.hide_from_place_memories_description,
  AssetSurface.folders => context.t.hide_from_place_folders_description,
};

/// Asks which places an asset should be withheld from, prefilled with [hiddenFrom].
///
/// Resolves to the chosen set, which **replaces** whatever the asset is withheld from now - an empty set is
/// how "show it everywhere again" is expressed, and is a legitimate answer rather than a cancel. Resolves to
/// `null` when the sheet is dismissed without saving, which is the only "leave it alone" outcome.
///
/// Replacing is only safe because there is exactly one asset and its true state is on screen. See
/// [showHideFromPlacesBulkPicker] for why a selection cannot work this way.
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

/// What a person asked to change about a selection, place by place.
///
/// Deliberately not a set of places: the assets in a selection need not be withheld from the same ones,
/// so a set would have to mean "make them all exactly this", discarding differences nobody was shown.
/// Each place is instead left alone unless it was explicitly set, and these are the ones that were.
class HideFromPlacesEdit {
  const HideFromPlacesEdit({required this.add, required this.remove});

  final Set<AssetSurface> add;
  final Set<AssetSurface> remove;

  bool get isEmpty => add.isEmpty && remove.isEmpty;
}

/// Asks which places to hide a *selection* from, and which to show it in again.
///
/// [hiddenCounts] says how many of [total] are currently withheld from each place, shown per row: the
/// phone holds every asset's mask locally, so unlike the web this can tell the truth about a mixed
/// selection instead of starting blank. Resolves to `null` when dismissed without saving.
Future<HideFromPlacesEdit?> showHideFromPlacesBulkPicker({
  required BuildContext context,
  required Map<AssetSurface, int> hiddenCounts,
  required int total,
}) {
  return showModalBottomSheet<HideFromPlacesEdit>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    backgroundColor: context.colorScheme.surfaceContainer,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => _HideFromPlacesBulkPicker(hiddenCounts: hiddenCounts, total: total),
  );
}

/// One place's pending change. `keep` is every row's default, and the reason nothing is lost.
enum _Intent { keep, hide, show }

class _HideFromPlacesPicker extends HookWidget {
  const _HideFromPlacesPicker({required this.hiddenFrom});

  final Set<AssetSurface> hiddenFrom;

  @override
  Widget build(BuildContext context) {
    final selected = useState(hiddenFrom);

    void toggle(AssetSurface place, {required bool isHidden}) {
      selected.value = {
        for (final candidate in _places)
          if (candidate == place ? isHidden : selected.value.contains(candidate)) candidate,
      };
    }

    return _PickerScaffold(
      help: context.t.hide_from_places_help,
      rows: [
        for (final place in _places)
          SwitchListTile.adaptive(
            value: selected.value.contains(place),
            onChanged: (isHidden) => toggle(place, isHidden: isHidden),
            title: Text(_placeLabel(context, place), style: context.textTheme.bodyLarge),
            subtitle: Text(
              _placeDescription(context, place),
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
            visualDensity: VisualDensity.compact,
          ),
      ],
      resetLabel: context.t.hide_from_places_clear,
      onReset: selected.value.isEmpty ? null : () => selected.value = const {},
      onSave: () => context.pop(selected.value),
    );
  }
}

class _HideFromPlacesBulkPicker extends HookWidget {
  const _HideFromPlacesBulkPicker({required this.hiddenCounts, required this.total});

  final Map<AssetSurface, int> hiddenCounts;
  final int total;

  @override
  Widget build(BuildContext context) {
    final intents = useState<Map<AssetSurface, _Intent>>({for (final place in _places) place: _Intent.keep});

    void set(AssetSurface place, _Intent intent) {
      intents.value = {...intents.value, place: intent};
    }

    final anyChange = intents.value.values.any((intent) => intent != _Intent.keep);

    return _PickerScaffold(
      help: context.t.hide_from_places_bulk_help(count: total),
      rows: [
        for (final place in _places)
          ListTile(
            title: Text(_placeLabel(context, place), style: context.textTheme.bodyLarge),
            subtitle: Text(
              // The current state rather than the place's description: on a selection, "how many of
              // these are already hidden here" is the thing a person cannot otherwise know.
              context.t.hide_from_places_bulk_state(hidden: hiddenCounts[place] ?? 0, total: total),
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
            trailing: SegmentedButton<_Intent>(
              showSelectedIcon: false,
              selected: {intents.value[place] ?? _Intent.keep},
              onSelectionChanged: (selection) => set(place, selection.first),
              style: const ButtonStyle(visualDensity: VisualDensity.compact, tapTargetSize: .shrinkWrap),
              segments: [
                ButtonSegment(
                  value: _Intent.keep,
                  icon: const Icon(Icons.remove, size: 18),
                  tooltip: context.t.hide_from_places_bulk_unchanged,
                ),
                ButtonSegment(
                  value: _Intent.hide,
                  icon: const Icon(Icons.visibility_off_outlined, size: 18),
                  tooltip: context.t.hide_from_places_bulk_hide,
                ),
                ButtonSegment(
                  value: _Intent.show,
                  icon: const Icon(Icons.visibility_outlined, size: 18),
                  tooltip: context.t.hide_from_places_bulk_show,
                ),
              ],
            ),
            visualDensity: VisualDensity.compact,
          ),
      ],
      resetLabel: context.t.hide_from_places_bulk_reset,
      onReset: anyChange ? () => intents.value = {for (final place in _places) place: _Intent.keep} : null,
      // Saving with nothing set would be a request that changes nothing, so Save is inert until there is
      // something to apply - the same rule the web modal follows.
      onSave: anyChange
          ? () => context.pop(
              HideFromPlacesEdit(
                add: {
                  for (final place in _places)
                    if (intents.value[place] == _Intent.hide) place,
                },
                remove: {
                  for (final place in _places)
                    if (intents.value[place] == _Intent.show) place,
                },
              ),
            )
          : null,
    );
  }
}

/// The chrome both pickers share: title, help text, a scrolling body, and a fixed action row.
class _PickerScaffold extends StatelessWidget {
  const _PickerScaffold({
    required this.help,
    required this.rows,
    required this.resetLabel,
    required this.onReset,
    required this.onSave,
  });

  final String help;
  final List<Widget> rows;
  final String resetLabel;
  final VoidCallback? onReset;
  final VoidCallback? onSave;

  @override
  Widget build(BuildContext context) {
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
              help,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceVariant),
            ),
          ),
          // The rows scroll and the buttons below do not, so Save stays reachable on a short screen.
          Flexible(
            child: SingleChildScrollView(
              child: Column(mainAxisSize: MainAxisSize.min, children: rows),
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            child: Row(
              children: [
                TextButton(onPressed: onReset, child: Text(resetLabel)),
                const Spacer(),
                TextButton(onPressed: context.pop, child: Text(context.t.cancel)),
                TextButton(
                  onPressed: onSave,
                  child: Text(
                    context.t.save,
                    style: context.textTheme.bodyMedium?.copyWith(
                      fontWeight: FontWeight.w600,
                      color: onSave == null ? null : context.primaryColor,
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
