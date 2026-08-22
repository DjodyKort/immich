import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/album/album_selector.widget.dart';
import 'package:immich_mobile/providers/infrastructure/action.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// Move the selected photos straight into a locked album, from wherever they are now.
///
/// The gap it closes: a locked album may only hold locked assets, and locking an asset evicts it from
/// every album, so doing this by hand meant locking the photos (they leave the album you wanted),
/// opening the locked folder, finding them again, and adding them there. The server does it as one
/// operation; this is the button for it.
///
/// **Offered only to an already-elevated session, deliberately.** The PIN and biometric flow lives in
/// `LockedGuard`, wired into the router, and re-implementing it here would mean a second copy of the
/// most safety-critical path in the app. So the action stays hidden until the session has been elevated
/// - which visiting the locked folder does. Lifting that restriction is a worthwhile change, and the
/// shape it should take is extracting the guard's elevation into a service the guard and this both
/// call, rather than copying it.
typedef _State = ({List<String> assetIds});

final _stateProvider = Provider.family.autoDispose<_State?, ActionSource>((ref, source) {
  // Locked albums are withheld from an unelevated session by the provider itself, so without this
  // the picker would open on an empty list and look broken rather than gated.
  final isElevated = ref.watch(sessionElevatedProvider).valueOrNull ?? false;
  if (!isElevated) {
    return null;
  }

  // Assets already in the locked folder have the locked folder's own sheet, which carries a locked
  // album selector. Offering this for them as well would be two routes to one outcome.
  final candidates = ref.watch(ownedAssetsActionProvider(source)).locked(isLocked: false);
  if (candidates.isEmpty) {
    return null;
  }

  return (assetIds: candidates.map((asset) => asset.id).toList(growable: false));
}, dependencies: [ownedAssetsActionProvider]);

class MoveToLockedAlbumAction extends AssetActionBuilder {
  const MoveToLockedAlbumAction({required super.source});

  @override
  ActionItem? create(BuildContext context, WidgetRef ref) {
    if (ref.watch(_stateProvider(source)) == null) {
      return null;
    }

    return .new(
      icon: Icons.lock_person_rounded,
      label: context.t.move_to_locked_album,
      onAction: () => _pickAlbum(context, ref),
    );
  }

  Future<void> _pickAlbum(BuildContext context, WidgetRef ref) async {
    final album = await showModalBottomSheet<RemoteAlbum>(
      context: context,
      isScrollControlled: true,
      useSafeArea: true,
      backgroundColor: context.colorScheme.surfaceContainer,
      shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
      builder: (sheetContext) => DraggableScrollableSheet(
        initialChildSize: 0.7,
        maxChildSize: 0.9,
        expand: false,
        builder: (_, scrollController) => CustomScrollView(
          controller: scrollController,
          slivers: [
            SliverToBoxAdapter(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
                child: Text(
                  sheetContext.t.move_to_locked_album_prompt,
                  style: sheetContext.textTheme.labelLarge?.copyWith(
                    color: sheetContext.colorScheme.onSurfaceSecondary,
                  ),
                ),
              ),
            ),
            AlbumSelector(
              albumFilter: (album) => album.isLocked,
              onAlbumSelected: (album) => Navigator.of(sheetContext).pop(album),
            ),
          ],
        ),
      ),
    );

    if (album == null || !context.mounted) {
      return;
    }

    final result = await ref.read(actionProvider.notifier).addToLockedAlbum(source, album);
    if (!context.mounted) {
      return;
    }

    if (!result.success) {
      ImmichToast.show(context: context, msg: context.t.scaffold_body_error_occurred, toastType: ToastType.error);
      return;
    }

    ref.read(clearSelectionProvider(source))();
    ImmichToast.show(
      context: context,
      msg: context.t.move_to_locked_album_done(count: result.count),
    );
  }
}
