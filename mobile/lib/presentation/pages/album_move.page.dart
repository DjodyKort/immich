import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:flutter/material.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/utils/album_tree.utils.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';

/// Pick where an album should sit.
///
/// Every album is listed, including the ones that cannot receive this move -- disabled, with the
/// reason beside them. Filtering them out is the shortcut that leaves the user staring at a list their
/// own album is missing from, with nothing explaining the absence; the locked-album selector already
/// made that mistake once, offering destinations that could only fail.
///
/// The list here is not the authority. It disables what it can see is invalid so it can explain
/// itself, but the server sees the whole tree -- including albums this session cannot -- so its
/// refusal is shown verbatim rather than pre-empted.
@RoutePage()
class AlbumMovePage extends ConsumerWidget {
  final RemoteAlbum album;

  const AlbumMovePage({super.key, required this.album});

  String _reasonFor(BuildContext context, MoveBlocker blocker) => switch (blocker) {
    MoveBlocker.self => context.t.album_move_blocked_self,
    MoveBlocker.descendant => context.t.album_move_blocked_descendant,
    MoveBlocker.currentParent => context.t.album_move_blocked_current_parent,
    MoveBlocker.lockMismatch => context.t.album_move_blocked_lock_mismatch,
    MoveBlocker.notOwned => context.t.album_move_blocked_not_owned,
    MoveBlocker.tooDeep => context.t.album_move_blocked_too_deep,
  };

  Future<void> _move(BuildContext context, WidgetRef ref, String? parentId, String? targetName) async {
    try {
      await ref.read(remoteAlbumServiceProvider).setParent(album.id, parentId);
      await ref.read(remoteAlbumProvider.notifier).refresh();

      if (!context.mounted) {
        return;
      }
      ImmichToast.show(
        context: context,
        msg: targetName == null ? context.t.album_moved_to_top_level : context.t.album_moved(album: targetName),
      );
      unawaited(context.maybePop(true));
    } catch (error) {
      if (!context.mounted) {
        return;
      }
      // The server's own words. It knows the whole tree; restating its refusal in the client would be
      // a second explanation that can disagree with the first.
      ImmichToast.show(context: context, msg: error.toString(), toastType: ToastType.error);
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final albums = ref.watch(remoteAlbumProvider).albums;
    final userId = ref.watch(authProvider).userId;
    final targets = albumMoveTargets(albums, album, userId);

    return Scaffold(
      appBar: AppBar(title: Text(context.t.album_move_to)),
      body: ListView.builder(
        itemCount: targets.length + 1,
        itemBuilder: (context, index) {
          if (index == 0) {
            final alreadyThere = album.parentId == null;
            return ListTile(
              enabled: !alreadyThere,
              leading: const Icon(Icons.home_outlined),
              title: Text(context.t.album_move_to_top_level),
              subtitle: alreadyThere ? Text(context.t.album_move_blocked_current_parent) : null,
              onTap: alreadyThere ? null : () => unawaited(_move(context, ref, null, null)),
            );
          }

          final target = targets[index - 1];
          return ListTile(
            enabled: target.isAllowed,
            contentPadding: EdgeInsetsDirectional.only(start: 16.0 + target.depth * 20.0, end: 16.0),
            leading: Icon(target.album.isLocked ? Icons.lock_outline : Icons.folder_outlined),
            title: Text(target.album.name, overflow: TextOverflow.ellipsis),
            subtitle: target.blocker == null ? null : Text(_reasonFor(context, target.blocker!)),
            onTap: target.isAllowed ? () => unawaited(_move(context, ref, target.album.id, target.album.name)) : null,
          );
        },
      ),
    );
  }
}
