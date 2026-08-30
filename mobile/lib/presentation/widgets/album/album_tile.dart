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
  });

  final RemoteAlbum album;
  final bool isOwner;
  final Function(RemoteAlbum)? onAlbumSelected;

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
