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

  const LockedGuard(this._elevation);

  @override
  Future<void> onNavigation(NavigationResolver resolver, StackRouter router) async {
    final (result: result, needsPinCreation: needsPinCreation) = await _elevation.elevate();

    switch (result) {
      case SessionElevation.granted:
        resolver.next(true);
      case SessionElevation.pinEntryRequired:
        // One push, not two. `needsPinCreation` used to be handled by an unconditional push above this
        // switch that then fell through into it, so a brand-new account -- which can be neither
        // elevated nor holding a stored PIN, and therefore always lands here -- got the create form
        // with the entry form stacked behind it. Dismiss the first and you are looking at a second
        // screen asking for a PIN that was never set.
        //
        // `PinAuthPage` already does both in the right order when asked to create one: it shows the
        // registration form and swaps itself to the verification form when that finishes. This is the
        // same single push `MoveToLockedAlbumAction` makes, so the two callers now agree.
        //
        // Deliberately leaves the resolver unresolved: the PIN form navigates onward itself when it
        // succeeds, and resolving false here would pop it straight back off.
        unawaited(router.push(PinAuthRoute(createPinCode: needsPinCreation)));
      case SessionElevation.denied:
        // No form for an account with no PIN either. `denied` is a refusal, and a create-PIN screen
        // pushed over one reads as "set a PIN to continue" when continuing is not on offer.
        resolver.next(false);
    }
  }
}
