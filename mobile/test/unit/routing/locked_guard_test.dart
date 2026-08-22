import 'package:auto_route/auto_route.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/routing/locked_guard.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/session_elevation.service.dart';
import 'package:mocktail/mocktail.dart';

class _MockElevation extends Mock implements SessionElevationService {}

class _MockResolver extends Mock implements NavigationResolver {}

class _MockRouter extends Mock implements StackRouter {}

/// The half of the locked-folder gate that decides navigation.
///
/// Split from [SessionElevationService] so each side can be asserted on its own; this one is four lines
/// of translation and every one of them is a decision about whether someone gets in.
///
/// `pinEntryRequired` leaving the resolver *unresolved* is the case worth pinning and the one that looks
/// like an omission. The PIN form navigates onward itself when it succeeds, so resolving false here
/// would pop it straight back off the stack -- the user would see the form flash and vanish.
void main() {
  late _MockElevation elevation;
  late _MockResolver resolver;
  late _MockRouter router;
  late LockedGuard sut;

  setUpAll(() {
    registerFallbackValue(PinAuthRoute());
  });

  setUp(() {
    elevation = _MockElevation();
    resolver = _MockResolver();
    router = _MockRouter();
    sut = LockedGuard(elevation);
    when(() => router.push<Object?>(any())).thenAnswer((_) async => null);
  });

  void elevates(SessionElevation result, {bool needsPinCreation = false}) {
    when(() => elevation.elevate()).thenAnswer((_) async => (result: result, needsPinCreation: needsPinCreation));
  }

  List<PinAuthRoute> pushedPinRoutes() =>
      verify(() => router.push<Object?>(captureAny())).captured.whereType<PinAuthRoute>().toList();

  /// auto_route types generated route args as nullable, so a missing `args` reads as `null` here and
  /// fails whichever of `isTrue`/`isFalse` the caller asked for -- which is the right answer either way.
  bool? createsPin(PinAuthRoute route) => route.args?.createPinCode;

  group('LockedGuard', () {
    test('lets an elevated session through', () async {
      elevates(SessionElevation.granted);

      await sut.onNavigation(resolver, router);

      verify(() => resolver.next(true)).called(1);
      verifyNever(() => router.push<Object?>(any()));
    });

    test('turns a denial away', () async {
      elevates(SessionElevation.denied);

      await sut.onNavigation(resolver, router);

      verify(() => resolver.next(false)).called(1);
      verifyNever(() => router.push<Object?>(any()));
    });

    test('shows the PIN form and leaves the resolver alone', () async {
      elevates(SessionElevation.pinEntryRequired);

      await sut.onNavigation(resolver, router);

      expect(pushedPinRoutes(), hasLength(1));
      verifyNever(() => resolver.next(any()));
    });

    // An already-elevated session needs no form of any kind. The guard used to push the create-PIN
    // form here too, from an unconditional `if (needsPinCreation)` above the switch, which put a PIN
    // screen on top of the locked folder it had just let the user into.
    test('lets an elevated session through without a form, even with no PIN set', () async {
      elevates(SessionElevation.granted, needsPinCreation: true);

      await sut.onNavigation(resolver, router);

      // verifyNever rather than `expect(pushedPinRoutes(), isEmpty)`: mocktail's `verify` throws
      // "no matching calls" when nothing was pushed, so that spelling fails for the wrong reason.
      verifyNever(() => router.push<Object?>(any()));
      verify(() => resolver.next(true)).called(1);
    });

    // The fix. This used to push twice -- the create form from that unconditional `if`, then the entry
    // form from the switch -- and a brand-new account always lands here, being neither elevated nor
    // holding a stored PIN. Dismissing the first left you looking at a second screen asking for a PIN
    // that had never been set.
    //
    // One push now, carrying `createPinCode`, because `PinAuthPage` already does both in order: it
    // shows the registration form and swaps itself to the verification form when that finishes. The
    // flag is asserted, not just the count -- pushing one *entry* form would also be one push, and
    // would strand an account with no PIN on a form it cannot satisfy.
    test('sends a brand-new account to a single form that creates the PIN and then asks for it', () async {
      elevates(SessionElevation.pinEntryRequired, needsPinCreation: true);

      await sut.onNavigation(resolver, router);

      final pushed = pushedPinRoutes();
      expect(pushed, hasLength(1));
      expect(createsPin(pushed.single), isTrue);
      verifyNever(() => resolver.next(any()));
    });

    // The counterpart: an account that has a PIN must not be shown the create form.
    test('asks an account that already has a PIN to type it, not to create one', () async {
      elevates(SessionElevation.pinEntryRequired);

      await sut.onNavigation(resolver, router);

      expect(createsPin(pushedPinRoutes().single), isFalse);
    });

    // No form on a refusal either, whether or not a PIN exists. A create-PIN screen over a denial
    // reads as "set a PIN to continue" when continuing is not on offer.
    test('turns a denial away without offering to create a PIN', () async {
      elevates(SessionElevation.denied, needsPinCreation: true);

      await sut.onNavigation(resolver, router);

      verify(() => resolver.next(false)).called(1);
      verifyNever(() => router.push<Object?>(any()));
    });
  });
}
