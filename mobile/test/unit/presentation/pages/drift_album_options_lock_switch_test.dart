import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/user.service.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/auth/auth_state.model.dart';
import 'package:immich_mobile/presentation/pages/album_options.page.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:mocktail/mocktail.dart';

import '../../../service.mocks.dart';
import '../../../widget_tester_extensions.dart';
import '../../factories/remote_album_factory.dart';
import '../../factories/user_factory.dart';

/// Pins the lock switch's *direction*.
///
/// `AlbumService.setLocked` refuses a shared album only inside `if (dto.isLocked)`, so unlocking a
/// shared album is deliberately allowed. Both clients used to gate the switch in both directions, which
/// made them stricter than the server in the one direction where being stricter traps the user: an album
/// that became shared after it was locked could never be unlocked again.
///
/// Worth pinning rather than reading, because the condition is a two-term expression repeated in the
/// switch and in its subtitle, and getting one of the two wrong shows a caption that contradicts the
/// control next to it.
class _TestAuthNotifier extends AuthNotifier {
  _TestAuthNotifier(Ref ref, String userId)
    : super(
        MockAuthService(),
        MockApiService(),
        MockUserService(),
        MockSecureStorageService(),
        MockWidgetService(),
        ref,
      ) {
    state = AuthState(
      deviceId: 'device-1',
      userId: userId,
      userEmail: 'owner@example.com',
      name: 'Owner',
      profileImagePath: '',
      isAdmin: false,
      isAuthenticated: true,
    );
  }
}

class _TestCurrentUser extends CurrentUserProvider {
  _TestCurrentUser(UserDto user) : super(_stubUserService(user)) {
    state = user;
  }

  static UserService _stubUserService(UserDto user) {
    final service = MockUserService();
    when(service.tryGetMyUser).thenReturn(user);
    when(service.watchMyUser).thenAnswer((_) => Stream<UserDto?>.value(user));
    return service;
  }
}

void main() {
  final owner = UserFactory.createDto();

  Future<void> pumpOptions(WidgetTester tester, RemoteAlbum album) => tester.pumpConsumerWidget(
    AlbumOptionsPage(album: album),
    overrides: [
      authProvider.overrideWith((ref) => _TestAuthNotifier(ref, album.ownerId)),
      // The page renders the owner's avatar row, so this has to resolve even though the row is not
      // what is asserted here.
      currentUserProvider.overrideWith((ref) => _TestCurrentUser(owner)),
      remoteAlbumSharedUsersProvider(album.id).overrideWith((ref) async => const []),
    ],
  );

  RemoteAlbum album({required bool isLocked, required bool isShared}) =>
      RemoteAlbumFactory.create(ownerId: owner.id, isLocked: isLocked, isShared: isShared);

  SwitchListTile lockSwitch(WidgetTester tester) => tester.widget<SwitchListTile>(
    find.ancestor(of: find.text(StaticTranslations.instance.lock_album), matching: find.byType(SwitchListTile)),
  );

  group('AlbumOptionsPage lock switch', () {
    testWidgets('is operable on an album shared with nobody', (tester) async {
      await pumpOptions(tester, album(isLocked: false, isShared: false));

      expect(lockSwitch(tester).onChanged, isNotNull);
      expect(find.text(StaticTranslations.instance.lock_album_description), findsOneWidget);
    });

    testWidgets('refuses to lock a shared album, and says why', (tester) async {
      await pumpOptions(tester, album(isLocked: false, isShared: true));

      expect(lockSwitch(tester).onChanged, isNull);
      expect(find.text(StaticTranslations.instance.lock_album_error_shared), findsOneWidget);
    });

    // The direction that matters. The server allows this, so blocking it here is what trapped the album.
    testWidgets('still allows unlocking an album that is shared', (tester) async {
      await pumpOptions(tester, album(isLocked: true, isShared: true));

      expect(lockSwitch(tester).onChanged, isNotNull);
      expect(find.text(StaticTranslations.instance.lock_album_error_shared), findsNothing);
    });

    testWidgets('allows unlocking an unshared album', (tester) async {
      await pumpOptions(tester, album(isLocked: true, isShared: false));

      expect(lockSwitch(tester).onChanged, isNotNull);
    });
  });
}
