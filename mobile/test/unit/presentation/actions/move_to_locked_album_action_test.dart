import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/move_to_locked_album.action.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';

import '../../factories/remote_asset_factory.dart';
import '../presentation_context.dart';

/// Pins the *gate* on this action, which is the safety-relevant half.
///
/// The action is deliberately offered only to an already-elevated session: the PIN and biometric flow
/// lives in `LockedGuard`, and re-implementing it inside an action would be a second copy of the most
/// safety-critical path in the app. That restriction is the thing most likely to be relaxed by accident
/// later, and CLAUDE.md records a day this fork spent with exactly that class of mistake -- a gate
/// loosened in one place and left tight in another.
///
/// The album picker itself is not driven here. It needs `AlbumSelector` over `remoteAlbumProvider`, and
/// what is worth pinning is which sessions and selections reach it at all.
void main() {
  late PresentationContext context;

  setUp(() async {
    context = await PresentationContext.create();
  });

  tearDown(() async {
    await context.dispose();
  });

  RemoteAsset owned({AssetVisibility visibility = .timeline}) =>
      RemoteAssetFactory.create(ownerId: context.currentUser.id, visibility: visibility);

  Future<void> pumpAction(WidgetTester tester, Set<BaseAsset> selection, {required bool elevated}) =>
      tester.pumpTestWidget(
        context,
        const ActionColumnButton(action: MoveToLockedAlbumAction(source: .timeline)),
        overrides: [...context.selected(selection), sessionElevatedProvider.overrideWith((ref) async => elevated)],
      );

  Finder theButton() => find.text(StaticTranslations.instance.move_to_locked_album);

  group('MoveToLockedAlbumAction', () {
    testWidgets('is offered to an elevated session with an unlocked owned asset', (tester) async {
      await pumpAction(tester, {owned()}, elevated: true);

      expect(theButton(), findsOneWidget);
    });

    // Elevation is the gate. Without it the locked-album picker would open on an empty list, because
    // `lockedRemoteAlbumsProvider` withholds locked albums from an unelevated session -- so the action
    // would look broken rather than gated.
    testWidgets('is withheld from a session that has not been elevated', (tester) async {
      await pumpAction(tester, {owned()}, elevated: false);

      expect(theButton(), findsNothing);
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
  });
}
