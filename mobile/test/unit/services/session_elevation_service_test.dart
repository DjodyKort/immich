import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/repositories/auth_api.repository.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:immich_mobile/services/session_elevation.service.dart';
import 'package:local_auth/error_codes.dart' as auth_error;
import 'package:mocktail/mocktail.dart';

class _MockAuthApi extends Mock implements AuthApiRepository {}

class _MockSecureStorage extends Mock implements SecureStorageService {}

class _MockLocalAuth extends Mock implements LocalAuthService {}

/// The first tests this sequence has ever had.
///
/// It lived inside `LockedGuard`, entangled with `NavigationResolver`, and so was only exercised by
/// running the app and typing a PIN. That is why it is extracted: this is the gate on the locked folder,
/// and the cases worth being sure about are the ones a person cannot easily reproduce by hand -- a
/// server that does not answer, a sensor that is not enrolled, a stored PIN the server no longer
/// accepts.
///
/// What is *not* covered, and cannot be here: the biometric prompt itself. `LocalAuthService` is mocked,
/// so these assert what this service does with each answer, not that the platform gives the right one.
/// That needs a device with an enrolled fingerprint.
void main() {
  late _MockAuthApi authApi;
  late _MockSecureStorage secureStorage;
  late _MockLocalAuth localAuth;
  late SessionElevationService sut;

  setUp(() {
    authApi = _MockAuthApi();
    secureStorage = _MockSecureStorage();
    localAuth = _MockLocalAuth();
    sut = SessionElevationService(authApi, secureStorage, localAuth);
  });

  void status({bool hasPinCode = true, bool isElevated = false}) {
    when(
      () => authApi.getAuthStatus(),
    ).thenAnswer((_) async => AuthGateStatus(hasPinCode: hasPinCode, isElevated: isElevated));
  }

  void storedPin(String? pin) {
    when(() => secureStorage.read(kSecuredPinCode)).thenAnswer((_) async => pin);
  }

  void biometrics({required bool succeeds}) {
    when(() => localAuth.authenticate()).thenAnswer((_) async => succeeds);
  }

  void unlock(PinUnlockOutcome outcome) {
    when(() => authApi.unlockWithStoredPinCode(any())).thenAnswer((_) async => outcome);
  }

  group('SessionElevationService.elevate', () {
    test('grants an already-elevated session without touching biometrics', () async {
      status(isElevated: true);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.granted);
      expect(outcome.needsPinCreation, isFalse);
      verifyNever(() => localAuth.authenticate());
      verifyNever(() => secureStorage.read(any()));
    });

    // Fails closed. An unreadable status is the case where guessing wrong opens the locked folder, so it
    // is the one that has to be a denial rather than a retry or a default.
    test('denies when the auth status cannot be read', () async {
      when(() => authApi.getAuthStatus()).thenAnswer((_) async => null);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
      expect(outcome.needsPinCreation, isFalse);
      verifyNever(() => localAuth.authenticate());
    });

    test('asks for the PIN when biometric unlock was never set up', () async {
      status();
      storedPin(null);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.pinEntryRequired);
      verifyNever(() => localAuth.authenticate());
    });

    test('reports that a PIN has to be created, and still resolves the rest of the sequence', () async {
      status(hasPinCode: false);
      storedPin(null);

      final outcome = await sut.elevate();

      expect(outcome.needsPinCreation, isTrue);
      expect(outcome.result, SessionElevation.pinEntryRequired);
    });

    test('grants after a successful biometric unlock', () async {
      status();
      storedPin('1234');
      biometrics(succeeds: true);
      unlock(PinUnlockOutcome.unlocked);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.granted);
      verify(() => authApi.unlockWithStoredPinCode('1234')).called(1);
    });

    test('denies when biometrics are refused, and does not try to unlock', () async {
      status();
      storedPin('1234');
      biometrics(succeeds: false);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
      verifyNever(() => authApi.unlockWithStoredPinCode(any()));
    });

    // The account's PIN changed since it was stored, so the stored copy can never succeed again.
    test('discards a stored PIN the server rejects, and falls back to typing it', () async {
      status();
      storedPin('1234');
      biometrics(succeeds: true);
      unlock(PinUnlockOutcome.rejected);
      when(() => secureStorage.delete(kSecuredPinCode)).thenAnswer((_) async {});

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.pinEntryRequired);
      verify(() => secureStorage.delete(kSecuredPinCode)).called(1);
    });

    // The counterpart, and the reason `PinUnlockOutcome` has three values rather than two: the server
    // never answered, so there is no evidence the stored PIN is wrong. Discarding it here would cost the
    // user their biometric unlock over a moment of bad signal.
    test('keeps a stored PIN when the unlock call merely failed', () async {
      status();
      storedPin('1234');
      biometrics(succeeds: true);
      unlock(PinUnlockOutcome.failed);

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
      verifyNever(() => secureStorage.delete(any()));
    });

    test('denies when the sensor is not enrolled', () async {
      status();
      storedPin('1234');
      when(() => localAuth.authenticate()).thenThrow(PlatformException(code: auth_error.notEnrolled));

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
    });

    test('denies when biometrics are not available at all', () async {
      status();
      storedPin('1234');
      when(() => localAuth.authenticate()).thenThrow(PlatformException(code: auth_error.notAvailable));

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
    });

    test('denies on an exception nobody predicted', () async {
      status();
      storedPin('1234');
      when(() => localAuth.authenticate()).thenThrow(StateError('unexpected'));

      final outcome = await sut.elevate();

      expect(outcome.result, SessionElevation.denied);
    });
  });
}
