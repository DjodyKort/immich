import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/hide_from_places.action.dart';
import 'package:immich_ui/immich_ui.dart';
import 'package:mocktail/mocktail.dart';

import '../../../infrastructure/repository.mock.dart';
import '../../../service.mocks.dart';
import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

void main() {
  late PresentationContext context;
  late MockAssetService assetService;
  late MockRemoteAssetRepository remoteAssetRepository;

  setUp(() async {
    context = await PresentationContext.create();
    assetService = context.service.asset.service;
    remoteAssetRepository = context.repository.remoteAsset.repo;
  });

  tearDown(() async {
    await context.dispose();
  });

  RemoteAsset owned({AssetVisibility visibility = .timeline, DateTime? deletedAt}) =>
      RemoteAssetFactory.create(ownerId: context.currentUser.id, visibility: visibility, deletedAt: deletedAt);

  /// What the local row holds, which is where the sheet takes its prefill from.
  void stored(RemoteAsset asset, {Set<AssetSurface> hiddenFrom = const {}}) {
    when(() => remoteAssetRepository.get(asset.id)).thenAnswer((_) async => asset.copyWith(hiddenFrom: hiddenFrom));
  }

  /// Advances past the sheet's entry and exit animations.
  ///
  /// Deliberately not `pumpAndSettle`: an open modal bottom sheet leaves one ticker running for as long as it
  /// is on screen, so settling never completes while the sheet is up. This is true of every sheet in the app,
  /// not of this one in particular.
  Future<void> animate(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
  }

  Future<void> openPicker(WidgetTester tester, Set<BaseAsset> selection) async {
    await tester.pumpTestAction(
      context,
      const HideFromPlacesAction(source: .timeline),
      overrides: context.selected(selection),
    );
    await animate(tester);
  }

  List<bool> switchValues(WidgetTester tester) =>
      tester.widgetList<SwitchListTile>(find.byType(SwitchListTile)).map((tile) => tile.value).toList();

  Future<void> tapLabel(WidgetTester tester, String label) async {
    await tester.tap(find.text(label));
    await animate(tester);
  }

  group('HideFromPlacesAction', () {
    testWidgets('offers one switch per place, prefilled from the stored row', (tester) async {
      final asset = owned();
      stored(asset, hiddenFrom: {AssetSurface.timeline, AssetSurface.map});

      await openPicker(tester, {asset});

      expect(find.text(StaticTranslations.instance.hide_from_places), findsOneWidget);
      expect(switchValues(tester), [true, false, true, false, false, false]);
    });

    testWidgets('prefills from the stored row and not from the asset in hand', (tester) async {
      // A timeline asset carries no exclusions whatever the row says, so prefilling from it would show every
      // switch off and then save that back, clearing what was already set.
      final asset = owned();
      stored(asset, hiddenFrom: {AssetSurface.search});

      await openPicker(tester, {asset});

      expect(asset.hiddenFrom, isEmpty);
      expect(switchValues(tester), [false, true, false, false, false, false]);
    });

    testWidgets('saves exactly the places whose switch is on', (tester) async {
      final asset = owned();
      stored(asset, hiddenFrom: {AssetSurface.timeline});

      await openPicker(tester, {asset});
      await tester.tap(find.byType(SwitchListTile).at(1));
      await animate(tester);
      await tapLabel(tester, StaticTranslations.instance.save);

      verify(() => assetService.updateHiddenFrom(asset.id, {AssetSurface.timeline, AssetSurface.search})).called(1);
    });

    testWidgets('asks for confirmation before hiding from every place', (tester) async {
      final asset = owned();
      // Every place but the last already on; ticking it turns the selection into all six.
      stored(
        asset,
        hiddenFrom: {
          AssetSurface.timeline,
          AssetSurface.search,
          AssetSurface.map,
          AssetSurface.people,
          AssetSurface.memories,
        },
      );

      await openPicker(tester, {asset});
      // Six switches do not all fit the test viewport, so the last one has to be scrolled to before
      // it can be tapped; without this the tap misses and Flutter reports it as an off-screen target.
      await tester.ensureVisible(find.byType(SwitchListTile).last);
      await tester.tap(find.byType(SwitchListTile).last);
      await animate(tester);
      await tapLabel(tester, StaticTranslations.instance.save);

      expect(find.text(StaticTranslations.instance.hide_from_places_all_confirm_title), findsOneWidget);
      verifyNever(() => assetService.updateHiddenFrom(any(), any()));

      await tapLabel(tester, StaticTranslations.instance.hide_from_places_all_confirm_action);

      verify(() => assetService.updateHiddenFrom(asset.id, Set.of(AssetSurface.values))).called(1);
    });

    testWidgets('does not hide from anywhere when the all-places confirmation is declined', (tester) async {
      final asset = owned();
      stored(
        asset,
        hiddenFrom: {
          AssetSurface.timeline,
          AssetSurface.search,
          AssetSurface.map,
          AssetSurface.people,
          AssetSurface.memories,
        },
      );

      await openPicker(tester, {asset});
      // Six switches do not all fit the test viewport, so the last one has to be scrolled to before
      // it can be tapped; without this the tap misses and Flutter reports it as an off-screen target.
      await tester.ensureVisible(find.byType(SwitchListTile).last);
      await tester.tap(find.byType(SwitchListTile).last);
      await animate(tester);
      await tapLabel(tester, StaticTranslations.instance.save);
      await tapLabel(tester, StaticTranslations.instance.cancel);

      verifyNever(() => assetService.updateHiddenFrom(any(), any()));
    });

    testWidgets('clearing everything and saving shows the asset everywhere again', (tester) async {
      final asset = owned();
      stored(asset, hiddenFrom: {AssetSurface.timeline, AssetSurface.people});

      await openPicker(tester, {asset});
      await tapLabel(tester, StaticTranslations.instance.hide_from_places_clear);

      expect(switchValues(tester), everyElement(isFalse));

      await tapLabel(tester, StaticTranslations.instance.save);

      verify(() => assetService.updateHiddenFrom(asset.id, const {})).called(1);
    });

    testWidgets('changes nothing when the sheet is dismissed', (tester) async {
      final asset = owned();
      stored(asset, hiddenFrom: {AssetSurface.timeline});

      await openPicker(tester, {asset});
      await tester.tap(find.byType(SwitchListTile).first);
      await animate(tester);
      await tapLabel(tester, StaticTranslations.instance.cancel);

      verifyNever(() => assetService.updateHiddenFrom(any(), any()));
    });

    testWidgets('is offered for a locked asset, which the locked folder needs', (tester) async {
      // Was hidden here, on the reasoning that a locked asset is already off all six surfaces so every
      // switch would be a no-op. The locked folder is the timeline with visibility pinned to locked, so
      // the timeline bit decides whether a locked photo appears there - see the locked folder group in
      // test/medium/repositories/timeline_repository_test.dart.
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({owned(visibility: .locked)}),
      );

      expect(find.byType(ImmichIconButton), findsOneWidget);
    });

    testWidgets('is hidden for a trashed asset', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({owned(deletedAt: DateTime(2026))}),
      );

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    testWidgets('is hidden for an asset owned by someone else', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({RemoteAssetFactory.create()}),
      );

      expect(find.byType(ImmichIconButton), findsNothing);
    });

    // Was hidden here while the sheet could only replace an asset's whole set, which would have
    // flattened a mixed selection. The bulk sheet adjusts place by place instead.
    testWidgets('is offered when more than one asset is selected', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({owned(), owned()}),
      );

      expect(find.byType(ImmichIconButton), findsOneWidget);
    });
  });

  /// A selection is edited as per-place intentions, so nothing the user was not shown gets discarded.
  group('HideFromPlacesAction, on a selection', () {
    /// Two assets that disagree about where they are hidden - the case a replacing set would ruin.
    Future<(RemoteAsset, RemoteAsset)> twoMismatched() async {
      final first = RemoteAssetFactory.create(id: 'first', ownerId: context.currentUser.id);
      final second = RemoteAssetFactory.create(id: 'second', ownerId: context.currentUser.id);
      stored(first, hiddenFrom: {AssetSurface.timeline});
      stored(second, hiddenFrom: {AssetSurface.map});
      return (first, second);
    }

    /// Sets one place's segmented control, found by the tooltip its segment carries.
    Future<void> choose(WidgetTester tester, int row, String tooltip) async {
      final segment = find.descendant(of: find.byType(ListTile).at(row), matching: find.byTooltip(tooltip));
      await tester.ensureVisible(segment);
      await tester.tap(segment);
      await animate(tester);
    }

    testWidgets('sends only the places that were set, as an add and a remove', (tester) async {
      final (first, second) = await twoMismatched();

      await openPicker(tester, {first, second});
      // Row 1 is Search: hide. Row 2 is Map: show.
      await choose(tester, 1, StaticTranslations.instance.hide_from_places_bulk_hide);
      await choose(tester, 2, StaticTranslations.instance.hide_from_places_bulk_show);
      await tapLabel(tester, StaticTranslations.instance.save);

      // Timeline is absent from both sets: it was left unchanged, so `first` keeps it and `second`
      // does not gain it. That is the whole point of the add/remove shape.
      final ids =
          verify(
                () => assetService.updateHiddenFromBulk(
                  captureAny(),
                  add: {AssetSurface.search},
                  remove: {AssetSurface.map},
                ),
              ).captured.single
              as List<String>;

      // Compared unordered: the selection is a set, so the order it reaches the service in is not
      // something this test should pin.
      expect(ids.toSet(), {first.id, second.id});
    });

    testWidgets('never replaces the whole set for a selection', (tester) async {
      final (first, second) = await twoMismatched();

      await openPicker(tester, {first, second});
      await choose(tester, 0, StaticTranslations.instance.hide_from_places_bulk_hide);
      await tapLabel(tester, StaticTranslations.instance.save);

      verifyNever(() => assetService.updateHiddenFrom(any(), any()));
    });

    testWidgets('changes nothing when no place was set', (tester) async {
      final (first, second) = await twoMismatched();

      await openPicker(tester, {first, second});
      await tapLabel(tester, StaticTranslations.instance.save);

      verifyNever(
        () => assetService.updateHiddenFromBulk(
          any(),
          add: any(named: 'add'),
          remove: any(named: 'remove'),
        ),
      );
    });

    testWidgets('asks for confirmation before hiding a selection from every place', (tester) async {
      final (first, second) = await twoMismatched();

      await openPicker(tester, {first, second});
      for (var row = 0; row < AssetSurface.values.length; row++) {
        await choose(tester, row, StaticTranslations.instance.hide_from_places_bulk_hide);
      }
      await tapLabel(tester, StaticTranslations.instance.save);

      expect(find.text(StaticTranslations.instance.hide_from_places_all_confirm_title), findsOneWidget);
      verifyNever(
        () => assetService.updateHiddenFromBulk(
          any(),
          add: any(named: 'add'),
          remove: any(named: 'remove'),
        ),
      );

      await tapLabel(tester, StaticTranslations.instance.hide_from_places_all_confirm_action);

      final ids =
          verify(
                () => assetService.updateHiddenFromBulk(
                  captureAny(),
                  add: Set.of(AssetSurface.values),
                  remove: const <AssetSurface>{},
                ),
              ).captured.single
              as List<String>;

      expect(ids.toSet(), {first.id, second.id});
    });

    testWidgets('does not apply anything when the all-places confirmation is declined', (tester) async {
      final (first, second) = await twoMismatched();

      await openPicker(tester, {first, second});
      for (var row = 0; row < AssetSurface.values.length; row++) {
        await choose(tester, row, StaticTranslations.instance.hide_from_places_bulk_hide);
      }
      await tapLabel(tester, StaticTranslations.instance.save);
      await tapLabel(tester, StaticTranslations.instance.cancel);

      verifyNever(
        () => assetService.updateHiddenFromBulk(
          any(),
          add: any(named: 'add'),
          remove: any(named: 'remove'),
        ),
      );
    });
  });
}
