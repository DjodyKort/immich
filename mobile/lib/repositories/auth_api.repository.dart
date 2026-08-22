import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/models/auth/login_response.model.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/providers/api.provider.dart';
import 'package:immich_mobile/repositories/api.repository.dart';
import 'package:immich_mobile/services/api.service.dart';
import 'package:openapi/api.dart';

final authApiRepositoryProvider = Provider((ref) => AuthApiRepository(ref.watch(apiServiceProvider)));

class AuthApiRepository extends ApiRepository {
  final ApiService _apiService;

  AuthApiRepository(this._apiService);

  Future<void> changePassword(String newPassword) async {
    await _apiService.usersApi.updateMyUser(UserUpdateMeDto(password: Optional.present(newPassword)));
  }

  Future<LoginResponse> login(String email, String password) async {
    final loginResponseDto = await checkNull(
      _apiService.authenticationApi.login(LoginCredentialDto(email: email, password: password)),
    );

    return _mapLoginReponse(loginResponseDto);
  }

  Future<void> logout() async {
    if (_apiService.apiClient.basePath.isEmpty) {
      return;
    }

    await _apiService.authenticationApi.logout().timeout(const Duration(seconds: 7));
  }

  LoginResponse _mapLoginReponse(LoginResponseDto dto) {
    return LoginResponse(
      accessToken: dto.accessToken,
      isAdmin: dto.isAdmin,
      name: dto.name,
      profileImagePath: dto.profileImagePath,
      shouldChangePassword: dto.shouldChangePassword,
      userEmail: dto.userEmail,
      userId: dto.userId,
    );
  }

  Future<bool> unlockPinCode(String pinCode) async {
    try {
      await _apiService.authenticationApi.unlockAuthSession(SessionUnlockDto(pinCode: Optional.present(pinCode)));
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> setupPinCode(String pinCode) {
    return _apiService.authenticationApi.setupPinCode(PinCodeSetupDto(pinCode: pinCode));
  }

  Future<void> lockPinCode() {
    return _apiService.authenticationApi.lockAuthSession();
  }

  /// Both halves of the locked-folder gate: whether a PIN exists, and whether the session is elevated.
  ///
  /// `null` when the status cannot be read at all, which callers must treat as "not elevated" -- the
  /// same fail-closed rule as [isSessionElevated]. Returns a domain model rather than the generated
  /// DTO so that `SessionElevationService` never has to import the OpenAPI client.
  Future<AuthGateStatus?> getAuthStatus() async {
    try {
      final status = await _apiService.authenticationApi.getAuthStatus();
      if (status == null) {
        return null;
      }
      return AuthGateStatus(hasPinCode: status.pinCode, isElevated: status.isElevated);
    } catch (_) {
      return null;
    }
  }

  /// Unlocks the session with a PIN, distinguishing a refusal from a failure.
  ///
  /// [unlockPinCode] collapses both into `false`, which is right for a form the user just typed into --
  /// they retype it either way. It is wrong for a *stored* PIN, where a refusal means the stored copy
  /// is stale and must be discarded while a transport failure must leave it alone. `ApiException` is
  /// the server having answered and said no; anything else is not having got an answer.
  Future<PinUnlockOutcome> unlockWithStoredPinCode(String pinCode) async {
    try {
      await _apiService.authenticationApi.unlockAuthSession(SessionUnlockDto(pinCode: Optional.present(pinCode)));
      return PinUnlockOutcome.unlocked;
    } on ApiException {
      return PinUnlockOutcome.rejected;
    } catch (_) {
      return PinUnlockOutcome.failed;
    }
  }

  /// Whether the server still considers this session elevated, i.e. inside the window opened by the
  /// PIN/biometric flow that `LockedGuard` drives.
  ///
  /// Fails closed: an unreachable server or a malformed response means "not elevated", never the
  /// reverse, so a caller that gates locked content on this can only ever under-expose.
  Future<bool> isSessionElevated() async {
    try {
      final status = await _apiService.authenticationApi.getAuthStatus();
      return status?.isElevated ?? false;
    } catch (_) {
      return false;
    }
  }
}
