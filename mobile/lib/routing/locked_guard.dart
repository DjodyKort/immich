import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/session_elevation.service.dart';

/// Gates the locked folder's routes on an elevated session.
///
/// The sequence itself lives in [SessionElevationService]; this is only the translation from its answer
/// into navigation. Keeping the two apart is what makes the sequence testable -- and it means a second
/// caller that wants to elevate does not have to reimplement it.
class LockedGuard extends AutoRouteGuard {
  final SessionElevationService _elevation;

  LockedGuard(this._elevation);

  @override
  Future<void> onNavigation(NavigationResolver resolver, StackRouter router) async {
    final (result: result, needsPinCreation: needsPinCreation) = await _elevation.elevate();

    // Pushed before acting on `result`, and without short-circuiting, which is the shape this guard has
    // always had: an account with no PIN gets the create-PIN form, and the rest of the sequence still
    // runs and decides navigation. Note that means a brand-new account is pushed the create form and
    // then the entry form, since it can be neither elevated nor holding a stored PIN -- pre-existing,
    // preserved here rather than quietly changed as part of an extraction.
    if (needsPinCreation) {
      unawaited(router.push(PinAuthRoute(createPinCode: true)));
    }

    switch (result) {
      case SessionElevation.granted:
        resolver.next(true);
      case SessionElevation.pinEntryRequired:
        // Deliberately leaves the resolver unresolved: the PIN form navigates onward itself when it
        // succeeds, and resolving false here would pop it straight back off.
        unawaited(router.push(PinAuthRoute()));
      case SessionElevation.denied:
        resolver.next(false);
    }
  }
}
