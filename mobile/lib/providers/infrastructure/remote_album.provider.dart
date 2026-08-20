// ignore_for_file: use-ref-and-state-synchronously

import 'dart:async';

import 'package:freezed_annotation/freezed_annotation.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/domain/services/remote_album.service.dart';
import 'package:immich_mobile/models/albums/album_search.model.dart';
import 'package:immich_mobile/providers/album/album_sort_by_options.provider.dart';
import 'package:immich_mobile/providers/album/pending_album_uploads.provider.dart';
import 'package:immich_mobile/providers/backup/asset_upload_progress.provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/services/auth.service.dart';
import 'package:immich_mobile/services/foreground_upload.service.dart';
import 'package:logging/logging.dart';

part 'remote_album.provider.freezed.dart';

@Freezed(toStringOverride: false)
abstract class RemoteAlbumState with _$RemoteAlbumState {
  const RemoteAlbumState._();

  const factory RemoteAlbumState({required List<RemoteAlbum> albums}) = _RemoteAlbumState;

  // Explicitly don't log albums
  @override
  String toString() => 'RemoteAlbumState(albums: ${albums.length})';
}

class RemoteAlbumNotifier extends Notifier<RemoteAlbumState> {
  late RemoteAlbumService _remoteAlbumService;
  final _logger = Logger('RemoteAlbumNotifier');

  @override
  RemoteAlbumState build() {
    _remoteAlbumService = ref.read(remoteAlbumServiceProvider);
    return const RemoteAlbumState(albums: []);
  }

  Future<List<RemoteAlbum>> _getAll() async {
    try {
      // Locked albums stay out of the list until the session has cleared the PIN/biometric flow. Asked
      // per refresh rather than cached so the list follows the server's elevation window, and answered
      // `false` on any failure so an offline refresh under-exposes instead of leaking.
      final isElevated = await ref.read(authServiceProvider).isSessionElevated();
      final albums = await _remoteAlbumService.getAll(isElevated: isElevated);
      state = state.copyWith(albums: albums);
      return albums;
    } catch (error, stack) {
      _logger.severe('Failed to fetch albums', error, stack);
      rethrow;
    }
  }

  Future<void> refresh() async {
    await _getAll();
  }

  List<RemoteAlbum> searchAlbums(
    List<RemoteAlbum> albums,
    String query,
    String? userId, [
    QuickFilterMode filterMode = QuickFilterMode.all,
  ]) {
    return _remoteAlbumService.searchAlbums(albums, query, userId, filterMode);
  }

  Future<List<RemoteAlbum>> sortAlbums(
    List<RemoteAlbum> albums,
    AlbumSortMode sortMode, {
    bool isReverse = false,
  }) async {
    return await _remoteAlbumService.sortAlbums(albums, sortMode, isReverse: isReverse);
  }

  Future<RemoteAlbum?> createAlbum({
    required String title,
    String? description,
    List<String> assetIds = const [],
  }) async {
    try {
      final currentUser = ref.read(currentUserProvider);
      if (currentUser == null) {
        throw Exception('User not logged in');
      }

      final album = await _remoteAlbumService.createAlbum(
        title: title,
        owner: currentUser,
        description: description,
        assetIds: assetIds,
      );

      state = state.copyWith(albums: [...state.albums, album]);

      return album;
    } catch (error, stack) {
      _logger.severe('Failed to create album', error, stack);
      rethrow;
    }
  }

  /// Creates an album from a heterogeneous asset selection. Already-remote
  /// assets seed the album immediately; local-only assets are uploaded in the
  /// background and linked one-by-one as each upload completes.
  /// [isLocked] creates the album already locked; the server requires every asset to be locked already,
  /// which is why the locked folder is the only place that passes it.
  Future<RemoteAlbum?> createAlbumWithAssets({
    required String title,
    String? description,
    Iterable<BaseAsset> assets = const [],
    bool isLocked = false,
  }) async {
    try {
      final currentUser = ref.read(currentUserProvider);
      if (currentUser == null) {
        throw Exception('User not logged in');
      }

      final candidates = RemoteAlbumService.categorizeCandidates(assets);
      final album = await _remoteAlbumService.createAlbum(
        title: title,
        owner: currentUser,
        description: description,
        assetIds: candidates.remoteAssetIds,
        isLocked: isLocked,
      );

      state = state.copyWith(albums: [...state.albums, album]);

      if (candidates.localAssetsToUpload.isNotEmpty) {
        unawaited(
          addAssetsToAlbum(
            album.id,
            candidates.localAssetsToUpload,
          ).then<void>((_) {}).catchError((Object _, StackTrace _) {}),
        );
      }

      return album;
    } catch (error, stack) {
      _logger.severe('Failed to create album with assets', error, stack);
      rethrow;
    }
  }

  Future<RemoteAlbum?> updateAlbum(
    String albumId, {
    String? name,
    String? description,
    String? thumbnailAssetId,
    bool? isActivityEnabled,
    AlbumAssetOrder? order,
  }) async {
    try {
      final updatedAlbum = await _remoteAlbumService.updateAlbum(
        albumId,
        name: name,
        description: description,
        thumbnailAssetId: thumbnailAssetId,
        isActivityEnabled: isActivityEnabled,
        order: order,
      );

      final updatedAlbums = state.albums.map((album) {
        return album.id == albumId ? updatedAlbum : album;
      }).toList();

      state = state.copyWith(albums: updatedAlbums);

      return updatedAlbum;
    } catch (error, stack) {
      _logger.severe('Failed to update album', error, stack);
      rethrow;
    }
  }

  Future<RemoteAlbum?> toggleAlbumOrder(String albumId) async {
    final currentAlbum = state.albums.firstWhere((album) => album.id == albumId);

    final newOrder = currentAlbum.order == AlbumAssetOrder.asc ? AlbumAssetOrder.desc : AlbumAssetOrder.asc;

    return updateAlbum(albumId, order: newOrder);
  }

  Future<void> deleteAlbum(String albumId) async {
    await _remoteAlbumService.deleteAlbum(albumId);

    final updatedAlbums = state.albums.where((album) => album.id != albumId).toList();
    state = state.copyWith(albums: updatedAlbums);
  }

  Future<List<RemoteAsset>> getAssets(String albumId) {
    return _remoteAlbumService.getAssets(albumId);
  }

  Future<({int added, int failed})> addAssets(String albumId, List<String> assetIds) async {
    final result = await _remoteAlbumService.addAssets(albumId: albumId, assetIds: assetIds);
    if (result.added > 0) {
      await _refreshAlbumInState(albumId);
    }
    return result;
  }

  /// Links a freshly-uploaded local asset to an album using its new remote ID,
  /// upserting a placeholder remote asset row so the local DB join survives
  /// until the next sync catches up.
  Future<int> linkUploadedAssetToAlbum(String albumId, LocalAsset source, String remoteId) async {
    final currentUser = ref.read(currentUserProvider);
    if (currentUser == null) {
      throw Exception('User not logged in');
    }

    final added = await _remoteAlbumService.linkUploadedAssetToAlbum(albumId, remoteId, currentUser, source);
    if (added > 0) {
      await _refreshAlbumInState(albumId);
    }
    return added;
  }

  /// Adds a heterogeneous asset selection to an album. Already-remote assets
  /// are linked immediately; local-only assets are queued in
  /// [pendingAlbumUploadsProvider] (so the album page can show them with
  /// progress indicators), uploaded, and linked one-by-one as each finishes.
  Future<int> addAssetsToAlbum(String albumId, Iterable<BaseAsset> assets) async {
    final currentUser = ref.read(currentUserProvider);
    if (currentUser == null) {
      throw Exception('User not logged in');
    }

    final candidates = RemoteAlbumService.categorizeCandidates(assets);
    final pendingNotifier = ref.read(pendingAlbumUploadsProvider(albumId).notifier);
    pendingNotifier.enqueue(candidates.localAssetsToUpload);

    Completer<void>? cancelToken;
    if (candidates.localAssetsToUpload.isNotEmpty) {
      cancelToken = Completer<void>();
      ref.read(manualUploadCancelTokenProvider.notifier).state = cancelToken;
    }

    try {
      final added = await _remoteAlbumService.addAssetsToAlbum(
        albumId: albumId,
        uploader: currentUser,
        candidates: candidates,
        cancelToken: cancelToken,
        uploadCallbacks: UploadCallbacks(
          onProgress: (localAssetId, _, bytes, totalBytes) {
            final progress = totalBytes > 0 ? bytes / totalBytes : 0.0;
            pendingNotifier.updateProgress(localAssetId, progress);
          },
          onSuccess: (localAssetId, _) => pendingNotifier.remove(localAssetId),
          onError: (localAssetId, _) => pendingNotifier.markFailed(localAssetId),
        ),
      );
      if (added > 0) {
        await _refreshAlbumInState(albumId);
      }
      return added;
    } catch (error, stack) {
      if (candidates.localAssetsToUpload.isNotEmpty) {
        pendingNotifier.markAllFailed();
      }
      _logger.severe('Failed to add assets to album $albumId', error, stack);
      rethrow;
    } finally {
      if (cancelToken != null) {
        if (cancelToken.isCompleted) {
          pendingNotifier.clear();
        }
        if (ref.read(manualUploadCancelTokenProvider) == cancelToken) {
          ref.read(manualUploadCancelTokenProvider.notifier).state = null;
        }
      }
    }
  }

  /// Re-reads a single album from the local DB and replaces it in [state] so
  /// that views bound to the album list (counts, thumbnails) reflect the
  /// latest junction-table changes without a full `refresh()`.
  Future<void> _refreshAlbumInState(String albumId) async {
    final updated = await _remoteAlbumService.get(albumId);
    if (updated == null) {
      return;
    }

    state = state.copyWith(albums: state.albums.map((album) => album.id == albumId ? updated : album).toList());
  }

  Future<void> addUsers(String albumId, List<String> userIds) {
    return _remoteAlbumService.addUsers(albumId: albumId, userIds: userIds);
  }

  Future<void> removeUser(String albumId, String userId) {
    return _remoteAlbumService.removeUser(albumId, userId: userId);
  }

  Future<void> leaveAlbum(String albumId, {required String userId}) async {
    await _remoteAlbumService.removeUser(albumId, userId: userId);

    final updatedAlbums = state.albums.where((album) => album.id != albumId).toList();
    state = state.copyWith(albums: updatedAlbums);
  }

  Future<void> setActivityStatus(String albumId, bool enabled) {
    return _remoteAlbumService.setActivityStatus(albumId, enabled);
  }

  Future<void> setHidden(String albumId, bool isHidden) async {
    await _remoteAlbumService.setHidden(albumId, isHidden);

    // Unlike the other settings on that screen, this one changes which listing the album belongs to, so
    // the cached list cannot be left to the next pull-to-refresh: the album the user just hid would sit
    // there looking unhidden. Dropping it locally mirrors deleteAlbum and leaveAlbum. Unhiding has to
    // re-read instead, because the album is not in state to put back.
    if (isHidden) {
      state = state.copyWith(albums: state.albums.where((album) => album.id != albumId).toList());
    } else {
      await _getAll();
    }

    ref.invalidate(hiddenRemoteAlbumsProvider);
  }

  /// Moves the album, and every asset in it, into or out of the locked folder.
  ///
  /// Refreshes rather than patching state, unlike [setHidden]: this changes the visibility of every member
  /// asset too, so the timelines those assets appear on are stale as well and there is nothing useful to
  /// surgically adjust. `_getAll` is correct in both directions here — locking removes the album from the
  /// ordinary listing only while the session is unelevated, and an elevated session should still see it.
  Future<void> setLocked(String albumId, bool isLocked) async {
    await _remoteAlbumService.setLocked(albumId, isLocked);
    await _getAll();

    ref.invalidate(lockedRemoteAlbumsProvider);
    ref.invalidate(hiddenRemoteAlbumsProvider);
  }
}

final remoteAlbumDateRangeProvider = StreamProvider.autoDispose.family<(DateTime, DateTime), String>((ref, albumId) {
  final service = ref.watch(remoteAlbumServiceProvider);
  return service.watchDateRange(albumId);
});

final remoteAlbumSharedUsersProvider = FutureProvider.autoDispose.family<List<UserDto>, String>((ref, albumId) async {
  final link = ref.keepAlive();
  ref.onDispose(() => link.close());
  final service = ref.watch(remoteAlbumServiceProvider);
  return service.getSharedUsers(albumId);
});

/// Albums for the Hidden page's "Hidden albums" section. Respects elevation the same way
/// [RemoteAlbumNotifier._getAll] does, so a hidden album that is also locked stays invisible until the
/// session clears the PIN/biometric flow. [AuthApiRepository.isSessionElevated] fails closed on its
/// own, so a failure here resolves to `false` too.
/// Left to dispose with the page, like [remoteAlbumSharedUsersProvider]: the section is small, and a
/// cached copy that outlived the page would show an album the user has since unhidden.
final hiddenRemoteAlbumsProvider = FutureProvider.autoDispose<List<RemoteAlbum>>((ref) async {
  final service = ref.watch(remoteAlbumServiceProvider);
  final isElevated = await ref.read(authServiceProvider).isSessionElevated();
  return service.getAll(isElevated: isElevated, hidden: true);
});

/// Whether this session has cleared the PIN/biometric flow.
///
/// The one place screens should ask, rather than each calling `isSessionElevated()` and inventing its own
/// loading and failure handling. Autodisposed on purpose: elevation expires, so a value cached past the
/// screen that asked for it would be a stale claim about the user's authorisation. Callers should treat
/// loading and error alike as *not* elevated — [AuthApiRepository.isSessionElevated] already fails closed,
/// and the narrow branch is the safe one to guess.
final sessionElevatedProvider = FutureProvider.autoDispose<bool>((ref) async {
  return ref.read(authServiceProvider).isSessionElevated();
});

/// The locked albums, for the locked folder's own album section.
///
/// Only ever asked for from behind the PIN guard, so it does not take an elevation flag: it passes
/// `isElevated: true` because reaching this at all means the session is elevated, and a locked album is by
/// definition invisible without that. Returns an empty list rather than throwing if elevation has lapsed
/// mid-session, which the listing query enforces anyway.
final lockedRemoteAlbumsProvider = FutureProvider.autoDispose<List<RemoteAlbum>>((ref) async {
  final service = ref.watch(remoteAlbumServiceProvider);
  final isElevated = await ref.watch(sessionElevatedProvider.future);
  if (!isElevated) {
    return const [];
  }

  return service.getAllLocked();
});
