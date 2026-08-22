import 'package:flutter/services.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/constants.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/repositories/auth_api.repository.dart';
import 'package:immich_mobile/services/local_auth.service.dart';
import 'package:immich_mobile/services/secure_storage.service.dart';
import 'package:local_auth/error_codes.dart' as auth_error;
import 'package:logging/logging.dart';

final sessionElevationServiceProvider = Provider(
  (ref) => SessionElevationService(
    ref.watch(authApiRepositoryProvider),
    ref.watch(secureStorageServiceProvider),
    ref.watch(localAuthServiceProvider),
  ),
);

/// The PIN/biometric sequence that opens the locked folder, in one place.
///
/// Extracted from `LockedGuard`, which was the only implementation and had no tests. It stayed there as
/// long as the router was the only way in; the moment a second caller wanted to elevate -- see
/// `MoveToLockedAlbumAction`, which is currently offered only to a session that is already elevated --
/// the choice was between a service and a second copy of the most safety-critical path in the app.
///
/// It deliberately does no navigation. [elevate] reports what the caller must do and the caller decides
/// how: a router guard resolves, a screen pushes, an action gives up. Navigation is what made this
/// untestable in the first place.
///
/// Fails closed throughout. Every unexpected outcome -- an unreadable status, an unavailable sensor, an
/// exception nobody predicted -- is [SessionElevation.denied], never granted.
class SessionElevationService {
  final AuthApiRepository _authApi;
  final SecureStorageService _secureStorage;
  final LocalAuthService _localAuth;
  final _log = Logger('SessionElevationService');

  SessionElevationService(this._authApi, this._secureStorage, this._localAuth);

  /// Elevates the session if it can be done without asking for the PIN, and says so if it cannot.
  ///
  /// [needsPinCreation] is separate from the result rather than a fourth result value because it is a
  /// separate fact: an account with no PIN needs one set up *and* still needs elevating afterwards, so
  /// a caller has two things to do, not one. `LockedGuard` has always pushed the create-PIN form and
  /// then continued into the rest of the sequence, and this keeps that shape.
  Future<({SessionElevation result, bool needsPinCreation})> elevate() async {
    final status = await _authApi.getAuthStatus();
    if (status == null) {
      return (result: SessionElevation.denied, needsPinCreation: false);
    }

    final needsPinCreation = !status.hasPinCode;

    if (status.isElevated) {
      return (result: SessionElevation.granted, needsPinCreation: needsPinCreation);
    }

    // Present only if the user enabled biometric unlock, which is what stores it. Its absence is the
    // ordinary case, not an error, and it means the PIN has to be typed.
    final storedPinCode = await _secureStorage.read(kSecuredPinCode);
    if (storedPinCode == null) {
      return (result: SessionElevation.pinEntryRequired, needsPinCreation: needsPinCreation);
    }

    return (result: await _elevateWithBiometrics(storedPinCode), needsPinCreation: needsPinCreation);
  }

  Future<SessionElevation> _elevateWithBiometrics(String storedPinCode) async {
    try {
      if (!await _localAuth.authenticate()) {
        return SessionElevation.denied;
      }

      switch (await _authApi.unlockWithStoredPinCode(storedPinCode)) {
        case PinUnlockOutcome.unlocked:
          return SessionElevation.granted;
        case PinUnlockOutcome.rejected:
          // The account's PIN changed since it was stored, so the stored copy is now wrong. Discard it
          // and fall back to typing, or every future attempt repeats a refusal that cannot succeed.
          await _secureStorage.delete(kSecuredPinCode);
          return SessionElevation.pinEntryRequired;
        case PinUnlockOutcome.failed:
          // Kept on purpose: the server never answered, so there is no evidence the stored PIN is
          // wrong. Discarding it would cost the user their biometric unlock over a moment of bad signal.
          return SessionElevation.denied;
      }
    } on PlatformException catch (error) {
      switch (error.code) {
        case auth_error.notAvailable:
          _log.severe('notAvailable: $error');
        case auth_error.notEnrolled:
          _log.severe('not enrolled');
        default:
          _log.severe('error');
      }

      return SessionElevation.denied;
    } catch (error) {
      _log.severe('Failed to elevate the session', error);
      return SessionElevation.denied;
    }
  }
}
