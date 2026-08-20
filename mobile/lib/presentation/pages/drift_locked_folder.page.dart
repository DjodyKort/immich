import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/album/album_tile.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/locked_folder_bottom_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/mesmerizing_sliver_app_bar.dart';

/// The locked albums, above the locked folder's own timeline.
///
/// Mirrors the web locked page and the Hidden page's albums section, deliberately: an album section above a
/// timeline is now how this app says "these belong here too". Reaching this screen means the PIN guard has
/// already passed, which is why [lockedRemoteAlbumsProvider] asks for no elevation flag.
///
/// The empty state is a line of text rather than nothing, unlike the Hidden page's section: locking an
/// existing album is new, and a person who has just been told it exists needs to see where it lands.
class _LockedAlbumsSection extends ConsumerWidget {
  const _LockedAlbumsSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final albums = ref.watch(lockedRemoteAlbumsProvider).valueOrNull ?? const [];
    final userId = ref.watch(currentUserProvider)?.id;

    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      sliver: SliverToBoxAdapter(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(context.t.locked_albums, style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: 8),
            if (albums.isEmpty)
              Text(
                context.t.locked_albums_empty,
                style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceVariant),
              ),
            for (final album in albums)
              Padding(
                padding: const EdgeInsets.only(bottom: 8.0),
                child: AlbumTile(
                  album: album,
                  isOwner: album.ownerId == userId,
                  onAlbumSelected: (album) => unawaited(context.router.push(RemoteAlbumRoute(album: album))),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

@RoutePage()
class DriftLockedFolderPage extends ConsumerStatefulWidget {
  const DriftLockedFolderPage({super.key});

  @override
  ConsumerState<DriftLockedFolderPage> createState() => _DriftLockedFolderPageState();
}

class _DriftLockedFolderPageState extends ConsumerState<DriftLockedFolderPage> with WidgetsBindingObserver {
  bool _showOverlay = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (!mounted) {
      return;
    }
    if (state == AppLifecycleState.paused) {
      unawaited(ref.read(authProvider.notifier).lockPinCode());
      unawaited(context.navigateTo(const TabShellRoute()));
      return;
    }
    setState(() {
      _showOverlay = state != AppLifecycleState.resumed;
    });
  }

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to access locked folder');
          }

          final timelineService = ref.watch(timelineFactoryProvider).lockedFolder(user.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: _showOverlay
          ? const SizedBox()
          : PopScope(
              onPopInvokedWithResult: (didPop, _) => didPop ? ref.read(authProvider.notifier).lockPinCode() : null,
              child: Timeline(
                appBar: MesmerizingSliverAppBar(title: context.t.locked_folder),
                topSliverWidget: const _LockedAlbumsSection(),
                bottomSheet: const LockedFolderBottomSheet(),
              ),
            ),
    );
  }
}
