import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/constants/enums.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/models/auth/session_elevation.model.dart';
import 'package:immich_mobile/presentation/actions/action.dart';
import 'package:immich_mobile/presentation/widgets/album/album_selector.widget.dart';
import 'package:immich_mobile/providers/infrastructure/action.provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/services/session_elevation.service.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// Move the selected photos straight into a locked album, from wherever they are now.
///
/// The gap it closes: a locked album may only hold locked assets, and locking an asset evicts it from
/// every album, so doing this by hand meant locking the photos (they leave the album you wanted),
/// opening the locked folder, finding them again, and adding them there. The server does it as one
/// operation; this is the button for it.
///
/// **Elevates on tap.** It used to be offered only to a session that had already cleared the PIN --
/// which in practice meant visiting the locked folder first, the very detour this action exists to
/// remove. It now runs the same sequence the router guard runs, through the shared
/// [SessionElevationService], so there is still exactly one implementation of the gate. What differs is
/// only what happens afterwards: the guard resolves navigation, this returns the user to their
/// selection.
///
/// Elevation is asked for on tap rather than watched for visibility, deliberately. Hiding the button
/// until the session happened to be elevated made a permanent capability look intermittent, and the
/// server is the authority on the elevation window in any case -- a button shown from cached state is a
/// guess, and asking at the moment of use is not.
typedef _State = ({List<String> assetIds});

final _stateProvider = Provider.family.autoDispose<_State?, ActionSource>((ref, source) {
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
      onAction: () => _run(context, ref),
    );
  }

  Future<void> _run(BuildContext context, WidgetRef ref) async {
    if (!await _ensureElevated(context, ref) || !context.mounted) {
      return;
    }

    await _pickAlbum(context, ref);
  }

  /// Gets the session elevated, or reports that it could not be.
  ///
  /// The same sequence `LockedGuard` runs, differing only in what it does with the answer: the guard
  /// resolves a route, this comes back here. Fails closed -- anything other than an explicit success is
  /// treated as a refusal, including a user who backs out of the PIN form, which pops `null`.
  Future<bool> _ensureElevated(BuildContext context, WidgetRef ref) async {
    final (result: result, needsPinCreation: needsPinCreation) = await ref
        .read(sessionElevationServiceProvider)
        .elevate();

    if (result == SessionElevation.granted) {
      return true;
    }

    if (result == SessionElevation.denied || !context.mounted) {
      return false;
    }

    // An account with no PIN needs one before it can type it, and the page does both in that order when
    // it is asked to create one -- so this is a single push rather than the guard's two.
    final elevated = await context.pushRoute<bool>(PinAuthRoute(createPinCode: needsPinCreation, popOnSuccess: true));
    if (elevated != true) {
      return false;
    }

    // Both lists were fetched with the elevation the server reported at the time, so they are now stale
    // by exactly the albums the picker is about to need.
    ref.invalidate(sessionElevatedProvider);
    await ref.read(remoteAlbumProvider.notifier).refresh();

    return true;
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
