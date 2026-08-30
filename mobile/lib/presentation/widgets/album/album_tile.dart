import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/pages/common/large_leading_tile.dart';
import 'package:immich_mobile/presentation/widgets/images/thumbnail.widget.dart';
import 'package:immich_mobile/providers/infrastructure/asset.provider.dart';

class AlbumTile extends ConsumerWidget {
  const AlbumTile({
    super.key,
    required this.album,
    required this.isOwner,
    this.onAlbumSelected,
    this.subAlbumCount = 0,
    this.depth = 0,
    this.isExpanded = true,
    this.onToggleExpanded,
  });

  final RemoteAlbum album;
  final bool isOwner;
  final Function(RemoteAlbum)? onAlbumSelected;

  /// Nesting level, 0 at the top.
  ///
  /// Capped by the caller rather than here: `LargeLeadingTile` sizes its title at a fixed fraction of
  /// the screen width, which does not shrink as the row is indented, so unbounded depth would push the
  /// name off the edge. The breadcrumb on the album page carries the true depth.
  final int depth;

  final bool isExpanded;

  /// Null for an album with no sub-albums, which is what decides whether a chevron is drawn at all.
  final VoidCallback? onToggleExpanded;

  /// How many sub-albums to signpost, or 0 for none.
  ///
  /// Passed in rather than read from the album, because it is counted from the list the *viewer* can
  /// see: a locked child is absent for an unelevated session, and a number that included it would
  /// promise something the folder does not open to.
  final int subAlbumCount;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final albumThumbnailAsset = ref.watch(assetServiceProvider).getRemoteAsset(album.thumbnailAssetId ?? "");

    return LargeLeadingTile(
      title: Row(
        children: [
          if (onToggleExpanded != null)
            // Its own hit target, not the row's: the row opens the album, and expanding a folder is a
            // different intent from entering it.
            GestureDetector(
              onTap: onToggleExpanded,
              behavior: HitTestBehavior.opaque,
              child: Padding(
                padding: const EdgeInsets.only(right: 4),
                child: AnimatedRotation(
                  turns: isExpanded ? 0.25 : 0,
                  duration: const Duration(milliseconds: 150),
                  child: Icon(Icons.chevron_right, size: 20, color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
            ),
          if (album.isLocked)
            Padding(
              padding: const EdgeInsets.only(right: 6),
              child: Icon(Icons.lock_rounded, size: 14, color: context.colorScheme.onSurfaceSecondary),
            ),
          Expanded(
            child: Text(
              album.name,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: context.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
        ],
      ),
      subtitle: Text(
        [
          if (subAlbumCount > 0) context.t.album_sub_album_count(count: subAlbumCount),
          context.t.items_count(count: album.assetCount),
          isOwner ? context.t.owned : context.t.shared_by_user(user: album.ownerName),
        ].join(' • '),
        overflow: TextOverflow.ellipsis,
        style: context.textTheme.bodyMedium?.copyWith(color: context.colorScheme.onSurfaceSecondary),
      ),
      onTap: () => onAlbumSelected?.call(album),
      leadingPadding: const EdgeInsets.only(right: 16),
      leading: FutureBuilder(
        future: albumThumbnailAsset,
        builder: (context, snapshot) {
          return snapshot.hasData && snapshot.data != null
              ? ClipRRect(
                  borderRadius: const BorderRadius.all(Radius.circular(15)),
                  child: SizedBox(
                    width: 80,
                    height: 80,
                    child: Thumbnail.remote(
                      remoteId: album.thumbnailAssetId!,
                      thumbhash: snapshot.data!.thumbHash ?? "",
                    ),
                  ),
                )
              : SizedBox(
                  width: 80,
                  height: 80,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: context.colorScheme.surfaceContainer,
                      borderRadius: const BorderRadius.all(Radius.circular(16)),
                      border: Border.all(color: context.colorScheme.outline.withAlpha(50), width: 1),
                    ),
                    child: const Icon(Icons.photo_album_rounded, size: 24, color: Colors.grey),
                  ),
                );
        },
      ),
    );
  }
}
