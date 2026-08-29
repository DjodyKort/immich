import 'package:auto_route/auto_route.dart';
import 'package:easy_localization/easy_localization.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/locales.dart';
import 'package:immich_mobile/generated/codegen_loader.g.dart';
import 'package:immich_mobile/models/auth/auth_state.model.dart';
import 'package:immich_mobile/models/auth/biometric_status.model.dart';
import 'package:immich_mobile/pages/library/locked/pin_auth.page.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/local_auth.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:mocktail/mocktail.dart';

import '../../../test_utils.dart';

class _MockRouter extends Mock implements StackRouter {}

class _FakeAuth extends StateNotifier<AuthState> with Mock implements AuthNotifier {
  _FakeAuth()
    : super(
        const AuthState(
          deviceId: 'device',
          userId: 'user',
          userEmail: 'user@immich.test',
          isAuthenticated: true,
          name: 'User',
          isAdmin: false,
          profileImagePath: '',
        ),
      );

  @override
  Future<bool> unlockPinCode(String pinCode) async => true;
}

class _FakeLocalAuth extends StateNotifier<BiometricStatus> with Mock implements LocalAuthNotifier {
  // No biometrics, so the page shows the PIN form alone and the test drives the one path a machine
  // without an enrolled fingerprint can drive.
  _FakeLocalAuth() : super(const BiometricStatus(availableBiometrics: [], canAuthenticate: false));
}

/// Where the PIN form leaves you, which is the whole of what `popOnSuccess` changes.
///
/// This page is the app's most safety-critical, and it grew a second exit so that
/// `MoveToLockedAlbumAction` could elevate without dragging the user into the locked folder. Both exits
/// are pinned here because the risk in adding one is the *old* caller silently taking the new path --
/// `LockedGuard` pushes this page and never awaits a result, so if the default started popping, the
/// locked folder would simply never open and nothing would throw.
///
/// Only the typed-PIN path is driven. The biometric path shares the same `finish()` and cannot be
/// exercised without a device with an enrolled sensor.
void main() {
  late _MockRouter router;

  setUpAll(() {
    TestUtils.init();
    registerFallbackValue(const LockedFolderRoute());
  });

  setUp(() {
    router = _MockRouter();
    when(() => router.maybePop<bool>(any())).thenAnswer((_) async => true);
    when(() => router.replace(any())).thenAnswer((_) async => null);
  });

  Future<void> pumpPage(WidgetTester tester, {required bool popOnSuccess}) async {
    await tester.pumpWidget(
      EasyLocalization(
        supportedLocales: locales.values.toList(),
        path: translationsPath,
        startLocale: locales.values.first,
        fallbackLocale: locales.values.first,
        saveLocale: false,
        useFallbackTranslations: true,
        assetLoader: const CodegenLoader(),
        child: ProviderScope(
          overrides: [
            authProvider.overrideWith((ref) => _FakeAuth()),
            localAuthProvider.overrideWith((ref) => _FakeLocalAuth()),
          ],
          child: Builder(
            builder: (context) => MaterialApp(
              debugShowCheckedModeBanner: false,
              localizationsDelegates: context.localizationDelegates,
              supportedLocales: context.supportedLocales,
              locale: context.locale,
              home: StackRouterScope(
                controller: router,
                stateHash: 0,
                child: PinAuthPage(popOnSuccess: popOnSuccess),
              ),
            ),
          ),
        ),
      ),
    );
    // Not pumpAndSettle: the PIN field's cursor blinks forever, so nothing here ever settles.
    await tester.pump();
  }

  Future<void> enterCorrectPin(WidgetTester tester) async {
    await tester.enterText(find.byType(EditableText).first, '123456');
    // The form holds a one-second success animation before it calls back.
    await tester.pump();
    await tester.pump(const Duration(seconds: 2));
    await tester.pump();
  }

  group('PinAuthPage', () {
    testWidgets('opens the locked folder by default, which is what LockedGuard depends on', (tester) async {
      await pumpPage(tester, popOnSuccess: false);

      await enterCorrectPin(tester);

      verify(() => router.replace(const LockedFolderRoute())).called(1);
      verifyNever(() => router.maybePop<bool>(any()));
    });

    testWidgets('pops true to its caller when asked to, and does not navigate', (tester) async {
      await pumpPage(tester, popOnSuccess: true);

      await enterCorrectPin(tester);

      verify(() => router.maybePop<bool>(true)).called(1);
      verifyNever(() => router.replace(any()));
    });
  });
}
