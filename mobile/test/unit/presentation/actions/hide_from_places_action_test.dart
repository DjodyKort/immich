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
      stored(asset, hiddenFrom: {
        AssetSurface.timeline,
        AssetSurface.search,
        AssetSurface.map,
        AssetSurface.people,
        AssetSurface.memories,
      });

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
      stored(asset, hiddenFrom: {
        AssetSurface.timeline,
        AssetSurface.search,
        AssetSurface.map,
        AssetSurface.people,
        AssetSurface.memories,
      });

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

    testWidgets('is hidden for a locked asset', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({owned(visibility: .locked)}),
      );

      expect(find.byType(ImmichIconButton), findsNothing);
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

    testWidgets('is hidden when more than one asset is selected', (tester) async {
      await tester.pumpTestWidget(
        context,
        const ActionIconButton(action: HideFromPlacesAction(source: .timeline)),
        overrides: context.selected({owned(), owned()}),
      );

      expect(find.byType(ImmichIconButton), findsNothing);
    });
  });
}
