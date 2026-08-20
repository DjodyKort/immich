import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/widgets/album/album_tile.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/hidden_bottom_sheet.widget.dart';
import 'package:immich_mobile/presentation/widgets/timeline/timeline.widget.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/timeline.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/mesmerizing_sliver_app_bar.dart';

/// Every asset withheld from at least one surface, gathered in one place regardless of which surfaces.
/// See `TimelineRepository.hidden` for why this is the one view a hidden asset can never fall out of.
///
/// Also shows a "Hidden albums" section above the timeline, mirroring the web page
/// (`(user)/hidden/.../+page.svelte`) — hidden albums are kept out of the main album list but stay
/// reachable from here, same as any other hidden thing.
@RoutePage()
class DriftHiddenPage extends StatelessWidget {
  const DriftHiddenPage({super.key});

  @override
  Widget build(BuildContext context) {
    return ProviderScope(
      overrides: [
        timelineServiceProvider.overrideWith((ref) {
          final user = ref.watch(currentUserProvider);
          if (user == null) {
            throw Exception('User must be logged in to access hidden assets');
          }

          final timelineService = ref.watch(timelineFactoryProvider).hidden(user.id);
          ref.onDispose(timelineService.dispose);
          return timelineService;
        }),
      ],
      child: Timeline(
        appBar: MesmerizingSliverAppBar(title: context.t.hidden, icon: Icons.visibility_off_outlined),
        topSliverWidget: const _HiddenAlbumsSection(),
        bottomSheet: const HiddenBottomSheet(),
      ),
    );
  }
}

class _HiddenAlbumsSection extends ConsumerWidget {
  const _HiddenAlbumsSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final albums = ref.watch(hiddenRemoteAlbumsProvider).valueOrNull ?? const [];
    if (albums.isEmpty) {
      // Unchanged from before this section existed, for the common case of no hidden albums.
      return const SliverToBoxAdapter(child: SizedBox.shrink());
    }

    final userId = ref.watch(currentUserProvider)?.id;

    return SliverPadding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
      sliver: SliverToBoxAdapter(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              context.t.hidden_albums,
              style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 8),
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
