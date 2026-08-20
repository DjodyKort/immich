import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.widget.dart';
import 'package:immich_mobile/presentation/actions/asset_debug.action.dart';
import 'package:immich_mobile/presentation/actions/delete.action.dart';
import 'package:immich_mobile/presentation/actions/download.action.dart';
import 'package:immich_mobile/presentation/actions/hide_from_places.action.dart';
import 'package:immich_mobile/presentation/actions/lock.action.dart';
import 'package:immich_mobile/presentation/actions/share.action.dart';
import 'package:immich_mobile/presentation/widgets/album/album_selector.widget.dart';
import 'package:immich_mobile/presentation/widgets/bottom_sheet/base_bottom_sheet.widget.dart';
import 'package:immich_mobile/providers/infrastructure/action.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// The selection sheet for the locked folder.
///
/// Carries an album selector like the other sheets do, restricted to locked albums, which is what makes
/// "add these to a locked album" and "make a new locked album out of these" reachable from the phone at
/// all. Both restrictions are requirements rather than conveniences: the server refuses a locked asset
/// into an ordinary album and an unlocked asset into a locked one, so offering the whole album list would
/// be offering choices that cannot succeed. This replaced a standalone create-album action, which the
/// header's own create button already covers - the other sheets all follow this shape.
class LockedFolderBottomSheet extends ConsumerStatefulWidget {
  const LockedFolderBottomSheet({super.key});

  @override
  ConsumerState<LockedFolderBottomSheet> createState() => _LockedFolderBottomSheetState();
}

class _LockedFolderBottomSheetState extends ConsumerState<LockedFolderBottomSheet> {
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

      // The albums section above the timeline reads its own provider, so it has to be told the membership
      // changed - otherwise a newly filled locked album keeps showing its old count.
      ref.invalidate(lockedRemoteAlbumsProvider);
    }

    Future<void> onKeyboardExpand() {
      return sheetController.animateTo(0.85, duration: const Duration(milliseconds: 200), curve: Curves.easeInOut);
    }

    return BaseBottomSheet(
      controller: sheetController,
      initialChildSize: 0.3,
      maxChildSize: 0.85,
      shouldCloseOnMinExtent: false,
      actions: const <ActionColumnButton>[
        .new(action: AssetDebugAction(source: .timeline)),
        .new(action: ShareAction(source: .timeline)),
        .new(action: DownloadAction(source: .timeline)),
        .new(action: DeleteAction(source: .timeline)),
        .new(action: LockAction(source: .timeline)),
        // The locked folder is the timeline with visibility pinned to locked, so the timeline switch
        // decides whether a locked photo appears here while leaving it in its locked albums.
        .new(action: HideFromPlacesAction(source: .timeline)),
      ],
      slivers: [
        const AddToAlbumHeader(createLocked: true),
        AlbumSelector(
          onAlbumSelected: addToAlbum,
          onKeyboardExpanded: onKeyboardExpand,
          albumFilter: (album) => album.isLocked,
        ),
      ],
    );
  }
}
