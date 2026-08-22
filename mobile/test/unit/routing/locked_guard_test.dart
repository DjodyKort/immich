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

    test('sends an account with no PIN to create one, and still lets it through once elevated', () async {
      elevates(SessionElevation.granted, needsPinCreation: true);

      await sut.onNavigation(resolver, router);

      expect(pushedPinRoutes(), hasLength(1));
      verify(() => resolver.next(true)).called(1);
    });

    // Pre-existing behaviour, preserved through the extraction rather than quietly changed: a brand-new
    // account is pushed the create form and then the entry form, because it can be neither elevated nor
    // holding a stored PIN. Asserted so that fixing it is a deliberate act with a test to update.
    test('pushes both PIN forms for a brand-new account', () async {
      elevates(SessionElevation.pinEntryRequired, needsPinCreation: true);

      await sut.onNavigation(resolver, router);

      expect(pushedPinRoutes(), hasLength(2));
      verifyNever(() => resolver.next(any()));
    });
  });
}
