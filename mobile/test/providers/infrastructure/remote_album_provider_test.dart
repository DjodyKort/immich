import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../../unit/factories/remote_album_factory.dart';

void main() {
  late MockRemoteAlbumService albumService;
  late MockAuthService authService;
  late ProviderContainer container;

  final ordinary = RemoteAlbumFactory.create(id: 'album-1', name: 'Holidays');
  final locked = RemoteAlbumFactory.create(id: 'locked-1', name: 'Private', isLocked: true);

  ProviderContainer makeContainer() => ProviderContainer(
    overrides: [
      remoteAlbumServiceProvider.overrideWithValue(albumService),
      authServiceProvider.overrideWithValue(authService),
    ],
  );

  setUp(() {
    albumService = MockRemoteAlbumService();
    authService = MockAuthService();
  });

  tearDown(() {
    container.dispose();
  });

  group('RemoteAlbumNotifier._getAll', () {
    /// The regression this exists for: the album list used to await `isSessionElevated()` -- an HTTP
    /// call -- before its first database read, so every add-to-album sheet sat empty for the length of
    /// a request before showing albums that were already on the device.
    test('publishes the unelevated albums before the elevation call answers', () async {
      final elevationCall = Completer<bool>();
      when(() => albumService.getAll(isElevated: false)).thenAnswer((_) async => [ordinary]);
      when(() => authService.isSessionElevated()).thenAnswer((_) => elevationCall.future);
      when(() => albumService.getAll(isElevated: true)).thenAnswer((_) async => [ordinary, locked]);

      container = makeContainer();
      final refreshing = container.read(remoteAlbumProvider.notifier).refresh();

      // Let the first database read settle while the network call is still outstanding.
      await Future<void>.delayed(Duration.zero);

      expect(container.read(remoteAlbumProvider).albums.map((album) => album.id), [
        ordinary.id,
      ], reason: 'the local albums must be visible while the elevation request is still in flight');

      elevationCall.complete(true);
      await refreshing;
    });

    test('folds locked albums in once the session is confirmed elevated', () async {
      when(() => albumService.getAll(isElevated: false)).thenAnswer((_) async => [ordinary]);
      when(() => authService.isSessionElevated()).thenAnswer((_) async => true);
      when(() => albumService.getAll(isElevated: true)).thenAnswer((_) async => [ordinary, locked]);

      container = makeContainer();
      await container.read(remoteAlbumProvider.notifier).refresh();

      expect(container.read(remoteAlbumProvider).albums.map((album) => album.id), [ordinary.id, locked.id]);
    });

    /// Fails closed. An unreachable server answers `false`, and this must leave the list exactly as the
    /// unelevated query returned it -- never wider.
    test('shows no locked album when the session is not elevated', () async {
      when(() => albumService.getAll(isElevated: false)).thenAnswer((_) async => [ordinary]);
      when(() => authService.isSessionElevated()).thenAnswer((_) async => false);

      container = makeContainer();
      await container.read(remoteAlbumProvider.notifier).refresh();

      expect(container.read(remoteAlbumProvider).albums.map((album) => album.id), [ordinary.id]);
      verifyNever(() => albumService.getAll(isElevated: true));
    });
  });
}
