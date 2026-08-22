/// The state of the PIN/biometric gate on the locked folder.
///
/// Returned by `AuthApiRepository.getAuthStatus`, so callers can ask the two questions the gate turns
/// on -- has this account set up a PIN at all, and is the session inside the window that PIN opened --
/// without touching a generated OpenAPI DTO.
class AuthGateStatus {
  /// Whether the account has a PIN. Without one there is nothing to verify against, so the only way
  /// forward is to create it.
  final bool hasPinCode;

  /// Whether the server still considers this session elevated.
  final bool isElevated;

  const AuthGateStatus({required this.hasPinCode, required this.isElevated});
}

/// What came of trying to unlock the session with a stored PIN.
///
/// Three outcomes rather than a bool because the caller does different things with the middle one: a
/// *rejected* PIN means the account's PIN has changed since it was stored, so the stored copy is now
/// wrong and has to be discarded. Any other failure -- no network, server down -- must not discard it,
/// or a moment of bad signal silently costs the user their biometric unlock.
enum PinUnlockOutcome { unlocked, rejected, failed }

/// What an attempt to elevate the session produced.
///
/// Deliberately says what the caller must *do*, not what happened, because two callers need to act on
/// it differently: a router guard resolves navigation, and anything else decides whether to proceed.
enum SessionElevation {
  /// The session is elevated -- it already was, or biometrics just made it so. Proceed.
  granted,

  /// Elevation needs the PIN typed in. Show that form; it cannot be done silently.
  pinEntryRequired,

  /// Biometrics were unavailable, refused, or failed, or the auth status could not be read at all.
  /// Do not proceed. Deliberately conflated: every one of them is "no", and a caller that treated
  /// them differently would be deciding how hard to try to get past its own gate.
  denied,
}
