import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/services/remote_album.service.dart';
import 'package:mocktail/mocktail.dart';

import '../../service.mocks.dart';
import '../mocks.dart';

void main() {
  late RemoteAlbumService sut;
  final mocks = RepositoryMocks();

  setUpAll(() {
    registerFallbackValue(<String>[]);
  });

  setUp(() {
    sut = RemoteAlbumService(mocks.remoteAlbum, mocks.albumApi, MockForegroundUploadService());
  });

  tearDown(() {
    mocks.resetAll();
  });

  group('RemoteAlbumService', () {
    group('removeAssets', () {
      test('persists only the assets the server actually removed, not the whole request', () async {
        const albumId = 'album-1';
        const requested = ['asset-1', 'asset-2', 'asset-3'];
        const removed = ['asset-1', 'asset-3'];

        // The server rejected 'asset-2'
        when(
          () => mocks.albumApi.removeAssets(albumId, requested),
        ).thenAnswer((_) async => (removed: removed, failed: ['asset-2']));
        when(() => mocks.remoteAlbum.removeAssets(albumId, any())).thenAnswer((_) async {});

        final count = await sut.removeAssets(albumId: albumId, assetIds: requested);

        final persisted =
            verify(() => mocks.remoteAlbum.removeAssets(albumId, captureAny())).captured.single as List<String>;
        expect(persisted, removed);
        expect(persisted, isNot(contains('asset-2')));

        expect(count, removed.length);
      });
    });

    group('setHidden', () {
      test('reaches the server before writing locally', () async {
        const albumId = 'album-1';
        final calls = <String>[];

        when(() => mocks.albumApi.setHidden(albumId, true)).thenAnswer((_) async {
          calls.add('api');
          return true;
        });
        when(() => mocks.remoteAlbum.setHidden(albumId, true)).thenAnswer((_) async {
          calls.add('local');
        });

        await sut.setHidden(albumId, true);

        expect(calls, ['api', 'local']);
      });

      test('leaves the local column alone when the server rejects the change', () async {
        const albumId = 'album-1';

        // Otherwise the album reads as hidden on this device while the server still lists it, and the
        // next sync silently reverts it -- the same failure the API-first order avoids elsewhere.
        when(() => mocks.albumApi.setHidden(albumId, true)).thenThrow(Exception('offline'));
        when(() => mocks.remoteAlbum.setHidden(albumId, true)).thenAnswer((_) async {});

        await expectLater(sut.setHidden(albumId, true), throwsException);

        verifyNever(() => mocks.remoteAlbum.setHidden(any(), any()));
      });
    });
  });
}
