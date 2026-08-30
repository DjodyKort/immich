import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/routing/router.dart';

/// The albums nested directly inside this one, above its own photos.
///
/// A sliver rather than a box, matching `PendingUploadsBanner` beside it, and self-sizing for the same
/// reason: it collapses to nothing when the album has no sub-albums, which is most albums.
///
/// Children come from the provider's list, which is already filtered by what this session may see. So
/// a locked sub-album is simply absent for an unelevated session rather than being shown and then
/// refusing to open -- the same rule the album list and the move picker follow.
class SubAlbumsRow extends ConsumerWidget {
  final String albumId;

  static const double _height = 132;

  const SubAlbumsRow({super.key, required this.albumId});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final children = ref.watch(
      remoteAlbumProvider.select(
        (state) => state.albums.where((album) => album.parentId == albumId).toList(growable: false),
      ),
    );

    if (children.isEmpty) {
      return const SliverToBoxAdapter(child: SizedBox.shrink());
    }

    return SliverToBoxAdapter(
      child: SizedBox(
        height: _height,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: Text(
                context.t.album_sub_albums.toUpperCase(),
                style: context.textTheme.labelSmall?.copyWith(
                  color: context.colorScheme.onSurfaceSecondary,
                  letterSpacing: 0.8,
                ),
              ),
            ),
            Expanded(
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                itemCount: children.length,
                separatorBuilder: (_, _) => const SizedBox(width: 12),
                itemBuilder: (context, index) => _SubAlbumCard(album: children[index]),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SubAlbumCard extends StatelessWidget {
  final RemoteAlbum album;

  const _SubAlbumCard({required this.album});

  @override
  Widget build(BuildContext context) {
    return InkWell(
      borderRadius: BorderRadius.circular(12),
      onTap: () => unawaited(context.pushRoute(RemoteAlbumRoute(album: album))),
      child: SizedBox(
        width: 128,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              height: 52,
              width: 128,
              decoration: BoxDecoration(
                borderRadius: BorderRadius.circular(12),
                color: context.colorScheme.surfaceContainerHigh,
              ),
              child: Icon(
                album.isLocked ? Icons.lock_rounded : Icons.folder_rounded,
                color: context.colorScheme.onSurfaceSecondary,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              album.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.bodyMedium?.copyWith(fontWeight: FontWeight.w600),
            ),
            Text(
              context.t.items_count(count: album.assetCount),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.bodySmall?.copyWith(color: context.colorScheme.onSurfaceSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
