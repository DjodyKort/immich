import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/archive.action.dart';
import 'package:immich_mobile/presentation/actions/asset_debug.action.dart';
import 'package:immich_mobile/presentation/actions/delete.action.dart';
import 'package:immich_mobile/presentation/actions/download.action.dart';
import 'package:immich_mobile/presentation/actions/edit_datetime.action.dart';
import 'package:immich_mobile/presentation/actions/edit_location.action.dart';
import 'package:immich_mobile/presentation/actions/favorite.action.dart';
import 'package:immich_mobile/presentation/actions/hide_from_places.action.dart';
import 'package:immich_mobile/presentation/actions/lock.action.dart';
import 'package:immich_mobile/presentation/actions/move_to_locked_album.action.dart';
import 'package:immich_mobile/presentation/actions/remove_from_album.action.dart';
import 'package:immich_mobile/presentation/actions/set_album_cover.action.dart';
import 'package:immich_mobile/presentation/actions/share.action.dart';
import 'package:immich_mobile/presentation/actions/share_link.action.dart';
import 'package:immich_mobile/presentation/actions/stack.action.dart';
import 'package:immich_mobile/presentation/widgets/album/album_selector.widget.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/base_bottom_sheet.widget.dart';
import 'package:immich_mobile/providers/infrastructure/action.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// The selection sheet for a single album.
///
/// `ownsAlbum` gates the *destructive* actions only -- delete, archive, lock, remove-from-album. It
/// deliberately does not gate the add-to-album half below them: that acts on a different album, and
/// the timeline sheet offers it for the same assets with no ownership test at all.
///
/// The add-to-album half is withheld inside a locked album, because there is nothing it could do that
/// the server accepts. Every asset shown is already in this album, so adding it here is a duplicate;
/// an asset may belong to **at most one locked album** (`getAssetIdsInOtherLockedAlbums`, rejected as
/// `ALREADY_IN_LOCKED_ALBUM`), so every other locked album is a rejection; and an ordinary album may
/// not hold a locked asset at all. The create button beside it is worse than useless there --
/// `createAlbum` does not evict from other locked albums, so building one out of assets that are
/// already in a locked album puts them in two, which is the invariant this rule exists to protect.
///
/// Moving between locked albums is a real thing to want and is [MoveToLockedAlbumAction]'s job, which
/// goes through `POST /albums/:id/locked-assets`. That route calls `moveIntoLockedFolder`, which
/// removes the assets from every other album in the same operation -- a move, atomically, rather than
/// the remove-then-add this sheet would have had to fake.
///
/// The web reached the same conclusion first and for the same reason; see the `album.isLocked` guard
/// in `routes/(user)/albums/[albumId=id]`.
class RemoteAlbumBottomSheet extends ConsumerStatefulWidget {
  final RemoteAlbum album;
  const RemoteAlbumBottomSheet({super.key, required this.album});

  @override
  ConsumerState<RemoteAlbumBottomSheet> createState() => _RemoteAlbumBottomSheetState();
}

class _RemoteAlbumBottomSheetState extends ConsumerState<RemoteAlbumBottomSheet> {
  late DraggableScrollableController sheetController;

  @override
  void initState() {
    super.initState();
    sheetController = DraggableScrollableController();
  }

  @override
  void dispose() {
    sheetController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final ownsAlbum = ref.watch(currentUserProvider)?.id == widget.album.ownerId;
    final isLocked = widget.album.isLocked;

    Future<void> addToAlbum(RemoteAlbum album) async {
      final result = await ref.read(actionProvider.notifier).addToAlbum(ActionSource.timeline, album);

      if (!context.mounted) {
        return;
      }

      if (!result.success) {
        ImmichToast.show(context: context, msg: context.t.scaffold_body_error_occurred, toastType: ToastType.error);
        return;
      }

      ImmichToast.show(
        context: context,
        msg: result.count == 0
            ? context.t.add_to_album_bottom_sheet_already_exists(album: album.name)
            : context.t.add_to_album_bottom_sheet_added(album: album.name),
      );
    }

    Future<void> onKeyboardExpand() {
      return sheetController.animateTo(0.85, duration: const Duration(milliseconds: 200), curve: Curves.easeInOut);
    }

    return BaseBottomSheet(
      controller: sheetController,
      initialChildSize: 0.22,
      minChildSize: 0.22,
      maxChildSize: 0.85,
      shouldCloseOnMinExtent: false,
      actions: <ActionColumnButton>[
        const .new(action: AssetDebugAction(source: .timeline)),
        const .new(action: ShareAction(source: .timeline)),
        const .new(action: ShareLinkAction(source: .timeline)),

        if (ownsAlbum) ...const [
          .new(action: ArchiveAction(source: .timeline)),
          .new(action: FavoriteAction(source: .timeline)),
        ],
        const .new(action: DownloadAction(source: .timeline)),
        if (ownsAlbum) ...const [
          .new(action: DeleteAction(source: .timeline)),
          .new(action: EditDateTimeAction(source: .timeline)),
          .new(action: EditLocationAction(source: .timeline)),
          .new(action: LockAction(source: .timeline)),
          .new(action: MoveToLockedAlbumAction(source: .timeline)),
          .new(action: HideFromPlacesAction(source: .timeline)),
          .new(action: StackAction(source: .timeline)),
        ],
        const .new(action: CleanupLocalAction(source: .timeline)),
        if (ownsAlbum) ...[
          ActionColumnButton(
            action: RemoveFromAlbumAction(source: .timeline, albumId: widget.album.id),
          ),
          ActionColumnButton(
            action: SetAlbumCoverAction(source: .timeline, albumId: widget.album.id),
          ),
        ],
      ],
      // Gated on `isLocked` alone. It used to require `ownsAlbum` too, which withheld the whole
      // add-to-album half inside any album shared *to* you -- while the timeline sheet, holding the
      // very same assets, offers it unconditionally. Owning the album you happen to be browsing has
      // nothing to do with whether you may put its photos into an album of your own; the server
      // decides that from the target album and the assets, and answers with a toast if it refuses.
      slivers: isLocked
          ? null
          : [
              const AddToAlbumHeader(),
              AlbumSelector(onAlbumSelected: addToAlbum, onKeyboardExpanded: onKeyboardExpand),
            ],
    );
  }
}
