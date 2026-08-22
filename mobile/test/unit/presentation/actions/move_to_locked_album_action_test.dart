import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/move_to_locked_album.action.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/services/session_elevation.service.dart';
import 'package:mocktail/mocktail.dart';

import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

class _MockElevation extends Mock implements SessionElevationService {}

/// Pins the *gate* on this action, which is the safety-relevant half.
///
/// The action now elevates on tap rather than hiding until the session happens to be elevated, so the
/// gate moved: it used to be visibility, and it is now the tap. Both halves are asserted here, because
/// the failure mode of moving a gate is leaving the old one behind and believing it still guards.
///
/// CLAUDE.md records a day this fork spent on exactly that class of mistake -- a gate loosened in one
/// place and left tight in another -- which is why the tap case asserts the picker stays shut rather
/// than only that `elevate()` was called.
///
/// The picker itself is not driven here. It needs `AlbumSelector` over `remoteAlbumProvider`, and what
/// is worth pinning is which sessions and selections reach it at all.
void main() {
  late PresentationContext context;
  late _MockElevation elevation;

  setUp(() async {
    context = await PresentationContext.create();
    elevation = _MockElevation();
  });

  tearDown(() async {
    await context.dispose();
  });

  void answerElevation(SessionElevation result, {bool needsPinCreation = false}) {
    when(elevation.elevate).thenAnswer((_) async => (result: result, needsPinCreation: needsPinCreation));
  }

  RemoteAsset owned({AssetVisibility visibility = .timeline}) =>
      RemoteAssetFactory.create(ownerId: context.currentUser.id, visibility: visibility);

  Future<void> pumpAction(WidgetTester tester, Set<BaseAsset> selection, {bool elevated = false}) =>
      tester.pumpTestWidget(
        context,
        const ActionColumnButton(action: MoveToLockedAlbumAction(source: .timeline)),
        overrides: [
          ...context.selected(selection),
          sessionElevatedProvider.overrideWith((ref) async => elevated),
          sessionElevationServiceProvider.overrideWithValue(elevation),
        ],
      );

  Finder theButton() => find.text(StaticTranslations.instance.move_to_locked_album);
  Finder thePicker() => find.text(StaticTranslations.instance.move_to_locked_album_prompt);

  group('MoveToLockedAlbumAction', () {
    testWidgets('is offered when the selection has an unlocked owned asset', (tester) async {
      await pumpAction(tester, {owned()}, elevated: true);

      expect(theButton(), findsOneWidget);
    });

    // The behaviour change. It used to be withheld here, which meant the button appeared only after a
    // visit to the locked folder -- the very detour the action exists to remove. Elevation is now asked
    // for on tap, so an unelevated session is offered the action and meets the PIN when it uses it.
    testWidgets('is offered to a session that has not been elevated', (tester) async {
      await pumpAction(tester, {owned()});

      expect(theButton(), findsOneWidget);
    });

    // Assets already in the locked folder have the locked folder's own sheet, which carries a locked
    // album selector. Offering this for them too would be two routes to one outcome.
    testWidgets('is withheld when every selected asset is already locked', (tester) async {
      await pumpAction(tester, {owned(visibility: .locked)}, elevated: true);

      expect(theButton(), findsNothing);
    });

    testWidgets('is offered for a mixed selection, for the assets that are not locked yet', (tester) async {
      await pumpAction(tester, {owned(), owned(visibility: .locked)}, elevated: true);

      expect(theButton(), findsOneWidget);
    });

    // The server refuses another user's asset into a locked album, so an action that only ever selects
    // assets the caller does not own has nothing it could do.
    testWidgets('is withheld when the selection is only someone else\'s assets', (tester) async {
      await pumpAction(tester, {RemoteAssetFactory.create()}, elevated: true);

      expect(theButton(), findsNothing);
    });

    group('the gate on tap', () {
      // The gate that replaced the visibility one. `denied` covers a refused or unavailable sensor and an
      // unreadable auth status alike -- every one of them is "no", and none of them may reach the picker.
      //
      // Worth knowing how this discriminates: with the gate removed it fails inside `AlbumSelector`'s
      // own providers, which this harness does not stub, rather than on the assertion below. It still
      // separates gated from ungated in both directions -- stub those providers later and the picker
      // appears, failing the assertion instead -- but it is not a clean read of the sheet.
      testWidgets('a denied elevation does not open the picker', (tester) async {
        answerElevation(SessionElevation.denied);
        await pumpAction(tester, {owned()});

        await tester.tap(theButton());
        await tester.pumpAndSettle();

        expect(thePicker(), findsNothing);
      });

      // Asked every time rather than read from `sessionElevatedProvider`: the server owns the elevation
      // window, so a button acting on cached state is acting on a guess.
      testWidgets('asks the service even when the session looks elevated already', (tester) async {
        answerElevation(SessionElevation.denied);
        await pumpAction(tester, {owned()}, elevated: true);

        await tester.tap(theButton());
        await tester.pumpAndSettle();

        verify(elevation.elevate).called(1);
      });
    });
  });
}
