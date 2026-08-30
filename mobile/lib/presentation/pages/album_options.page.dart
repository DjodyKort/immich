import 'dart:async';

import 'package:auto_route/auto_route.dart';
import 'package:collection/collection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_hooks/flutter_hooks.dart';
import 'package:fluttertoast/fluttertoast.dart';
import 'package:hooks_riverpod/hooks_riverpod.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/domain/models/user.model.dart';
import 'package:immich_mobile/extensions/build_context_extensions.dart';
import 'package:immich_mobile/extensions/theme_extensions.dart';
import 'package:immich_mobile/generated/translations.g.dart';
import 'package:immich_mobile/presentation/pages/user_selection.page.dart';
import 'package:immich_mobile/providers/auth.provider.dart';
import 'package:immich_mobile/providers/infrastructure/album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/current_album.provider.dart';
import 'package:immich_mobile/providers/infrastructure/remote_album.provider.dart';
import 'package:immich_mobile/providers/user.provider.dart';
import 'package:immich_mobile/routing/router.dart';
import 'package:immich_mobile/widgets/common/confirm_dialog.dart';
import 'package:immich_mobile/widgets/common/hide_from_places_picker.dart';
import 'package:immich_mobile/widgets/common/immich_toast.dart';
import 'package:immich_mobile/widgets/common/user_circle_avatar.dart';

@RoutePage()
class AlbumOptionsPage extends HookConsumerWidget {
  final RemoteAlbum album;
  const AlbumOptionsPage({super.key, required this.album});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sharedUsersAsync = ref.watch(remoteAlbumSharedUsersProvider(album.id));
    final userId = ref.watch(authProvider).userId;
    final activityEnabled = useState(album.isActivityEnabled);
    final hidden = useState(album.isHidden);
    final locked = useState(album.isLocked);
    final hiddenFrom = useState(album.hiddenFrom);
    final isOwner = album.ownerId == userId;
    final owner = isOwner ? ref.watch(currentUserProvider) : null;
    final allUsers = isOwner ? null : ref.watch(usersProvider);

    void showErrorMessage() {
      ContextHelper(context).pop();
      ImmichToast.show(
        context: context,
        msg: context.t.shared_album_section_people_action_error,
        toastType: ToastType.error,
        gravity: ToastGravity.BOTTOM,
      );
    }

    /// Confirms, then moves the album and its contents into or out of the locked folder.
    ///
    /// The switch is only flipped once the server has agreed, rather than optimistically: this is not a
    /// preference that can be silently retried, and a switch that snapped back after a refusal would leave
    /// the user unsure whether their photos moved.
    Future<void> setLocked(bool value) async {
      // An album with sub-albums is locked as a branch or not at all -- the server refuses to
      // half-lock a tree. When there are children the confirm has to describe what the *branch* costs
      // rather than what this album costs, and those two numbers can be very far apart.
      final hasSubAlbums = ref.read(remoteAlbumProvider).albums.any((candidate) => candidate.parentId == album.id);

      var content = value
          ? context.t.lock_album_confirm_prompt(count: album.assetCount)
          : context.t.unlock_album_confirm_prompt(count: album.assetCount);

      if (hasSubAlbums) {
        try {
          final impact = await ref.read(remoteAlbumProvider.notifier).getLockImpact(album.id, includeSubAlbums: true);

          if (!context.mounted) {
            return;
          }

          final blockedReason = impact.blockedReason;
          if (blockedReason != null) {
            // The server already knows this will be refused. Saying so now beats a confirm followed by
            // a failure, which asks the user to agree to something that cannot happen.
            ImmichToast.show(context: context, msg: blockedReason, toastType: ToastType.error);
            return;
          }

          final evicted = impact.evictions.fold<int>(0, (total, e) => total + e.assetCount.toInt());
          content = [
            context.t.album_lock_impact_albums(count: impact.albums.length),
            context.t.album_lock_impact_assets(count: impact.assetCount.toInt()),
            if (evicted > 0) context.t.album_lock_impact_evictions(count: evicted, albums: impact.evictions.length),
            if (value) context.t.album_lock_impact_undo,
          ].join(' · ');
        } catch (_) {
          if (!context.mounted) {
            return;
          }
          showErrorMessage();
          return;
        }
      }

      if (!context.mounted) {
        return;
      }

      final confirmed = await showDialog<bool>(
        context: context,
        builder: (_) => ConfirmDialog(
          title: value ? context.t.lock_album_confirm_title : context.t.unlock_album_confirm_title,
          content: content,
          ok: value ? context.t.lock_album_confirm_action : context.t.unlock_album_confirm_action,
        ),
      );
      if (confirmed != true || !context.mounted) {
        return;
      }

      try {
        await ref.read(remoteAlbumProvider.notifier).setLocked(album.id, value, includeSubAlbums: hasSubAlbums);
        locked.value = value;
        if (!context.mounted) {
          return;
        }
        ImmichToast.show(
          context: context,
          msg: value ? context.t.lock_album_locked : context.t.lock_album_unlocked,
          gravity: ToastGravity.BOTTOM,
        );
      } catch (_) {
        if (!context.mounted) {
          return;
        }
        // Deliberately generic: the server's refusals here are about ownership of the album or of the
        // assets in it, neither of which this screen can distinguish, and guessing wrong would be worse
        // than saying it did not work.
        ImmichToast.show(
          context: context,
          msg: context.t.shared_album_section_people_action_error,
          toastType: ToastType.error,
          gravity: ToastGravity.BOTTOM,
        );
      }
    }

    Future<void> leaveAlbum() async {
      try {
        await ref.read(remoteAlbumProvider.notifier).leaveAlbum(album.id, userId: userId);
        if (!context.mounted) {
          return;
        }

        unawaited(context.navigateTo(const AlbumsRoute()));
      } catch (_) {
        showErrorMessage();
      }
    }

    Future<void> removeUserFromAlbum(UserDto user) async {
      try {
        await ref.read(remoteAlbumProvider.notifier).removeUser(album.id, user.id);
        ref.invalidate(remoteAlbumSharedUsersProvider(album.id));
      } catch (_) {
        showErrorMessage();
      }

      ContextHelper(context).pop();
    }

    Future<void> addUsers() async {
      final newUsers = await context.pushRoute<List<String>>(UserSelectionRoute(album: album));

      if (newUsers == null || newUsers.isEmpty) {
        return;
      }

      try {
        if (!context.mounted) {
          return;
        }

        await ref.read(remoteAlbumProvider.notifier).addUsers(album.id, newUsers);
        ref.invalidate(remoteAlbumSharedUsersProvider(album.id));
        if (!context.mounted) {
          return;
        }

        ImmichToast.show(
          context: context,
          msg: context.t.users_added_to_album_count(count: newUsers.length),
          toastType: ToastType.success,
        );
      } catch (e) {
        if (!context.mounted) {
          return;
        }

        ImmichToast.show(context: context, msg: "Failed to add users to album: $e", toastType: ToastType.error);
      }
    }

    void handleUserClick(UserDto user) {
      var actions = [];

      if (user.id == userId) {
        actions = [
          ListTile(
            leading: const Icon(Icons.exit_to_app_rounded),
            title: Text(context.t.leave_album),
            onTap: leaveAlbum,
          ),
        ];
      }

      if (isOwner) {
        actions = [
          ListTile(
            leading: const Icon(Icons.person_remove_rounded),
            title: Text(context.t.remove_user),
            onTap: () => removeUserFromAlbum(user),
          ),
        ];
      }

      unawaited(
        showModalBottomSheet(
          backgroundColor: context.colorScheme.surfaceContainer,
          isScrollControlled: false,
          context: context,
          builder: (context) {
            return SafeArea(
              child: Padding(
                padding: const EdgeInsets.only(top: 24.0),
                child: Column(mainAxisSize: MainAxisSize.min, children: [...actions]),
              ),
            );
          },
        ),
      );
    }

    Widget buildOwnerInfo() {
      if (isOwner) {
        return ListTile(
          leading: owner != null ? UserCircleAvatar(user: owner) : const SizedBox(),
          title: Text(album.ownerName, style: const TextStyle(fontWeight: FontWeight.w500)),
          subtitle: Text(owner?.email ?? "", style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
          trailing: Text(context.t.owner, style: context.textTheme.labelLarge),
        );
      } else {
        if (allUsers == null) {
          return const SizedBox();
        }

        return allUsers.maybeWhen(
          data: (users) {
            final user = users.firstWhereOrNull((u) => u.id == album.ownerId);

            if (user == null) {
              return const SizedBox();
            }

            return ListTile(
              leading: UserCircleAvatar(user: user),
              title: Text(user.name, style: const TextStyle(fontWeight: FontWeight.w500)),
              subtitle: Text(user.email, style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
              trailing: Text(context.t.owner, style: context.textTheme.labelLarge),
            );
          },
          orElse: () => const SizedBox(),
        );
      }
    }

    Widget buildSharedUsersList() {
      return sharedUsersAsync.maybeWhen(
        data: (sharedUsers) => ListView.builder(
          primary: false,
          shrinkWrap: true,
          itemCount: sharedUsers.length,
          itemBuilder: (context, index) {
            final user = sharedUsers[index];
            return ListTile(
              leading: UserCircleAvatar(user: user),
              title: Text(user.name, style: const TextStyle(fontWeight: FontWeight.w500)),
              subtitle: Text(user.email, style: TextStyle(color: context.colorScheme.onSurfaceSecondary)),
              trailing: userId == user.id || isOwner ? const Icon(Icons.more_horiz_rounded) : const SizedBox(),
              onTap: userId == user.id || isOwner ? () => handleUserClick(user) : null,
            );
          },
        ),
        orElse: () => const Center(child: CircularProgressIndicator()),
      );
    }

    Padding buildSectionTitle(String text) {
      return Padding(
        padding: const EdgeInsets.all(16.0),
        child: Text(text, style: context.textTheme.bodySmall),
      );
    }

    return ProviderScope(
      overrides: [currentRemoteAlbumScopedProvider.overrideWithValue(album)],
      child: Scaffold(
        appBar: AppBar(
          leading: IconButton(
            icon: const Icon(Icons.arrow_back_ios_new_rounded),
            onPressed: () => context.maybePop(null),
          ),
          centerTitle: true,
          title: Text(context.t.options),
        ),
        body: ListView(
          children: [
            const SizedBox(height: 8),
            if (isOwner)
              SwitchListTile.adaptive(
                value: activityEnabled.value,
                onChanged: (bool value) async {
                  activityEnabled.value = value;
                  await ref.read(remoteAlbumProvider.notifier).setActivityStatus(album.id, value);
                },
                activeThumbColor: activityEnabled.value ? context.primaryColor : context.themeData.disabledColor,
                dense: true,
                title: Text(
                  context.t.comments_and_likes,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w500),
                ),
                subtitle: Text(
                  context.t.let_others_respond,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
            if (isOwner)
              SwitchListTile.adaptive(
                value: hidden.value,
                onChanged: (bool value) async {
                  hidden.value = value;
                  await ref.read(remoteAlbumProvider.notifier).setHidden(album.id, value);
                },
                activeThumbColor: hidden.value ? context.primaryColor : context.themeData.disabledColor,
                dense: true,
                title: Text(
                  context.t.hide_album,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w500),
                ),
                subtitle: Text(
                  context.t.hide_album_description,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
            // Locking is not hiding: it moves the album *and every photo in it* behind the PIN, so unlike
            // the switch above it confirms first and names what will happen. Disabled while the album is
            // shared, because the server refuses that case and saying so up front beats a toast after the
            // tap. Assets owned by someone else are not knowable here, so that one stays a server error.
            //
            // Sharing blocks the *locking* direction only. `AlbumService.setLocked` checks it inside
            // `if (dto.isLocked)`, so unlocking a shared album is deliberately allowed -- and gating both
            // directions would leave a locked album that later became shared with no way back out.
            if (isOwner)
              SwitchListTile.adaptive(
                value: locked.value,
                onChanged: !locked.value && album.isShared ? null : (bool value) async => setLocked(value),
                activeThumbColor: locked.value ? context.primaryColor : context.themeData.disabledColor,
                dense: true,
                title: Text(
                  context.t.lock_album,
                  style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w500),
                ),
                subtitle: Text(
                  !locked.value && album.isShared
                      ? context.t.lock_album_error_shared
                      : context.t.lock_album_description,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
            // The third member of the family, and the only one that acts on the contents: hide_album
            // keeps the album out of the album list and touches no photo, lock_album moves album and
            // photos behind the PIN, and this leaves the album where it is and takes its photos off the
            // places named. Owner only, because the rule reaches assets an editor does not own and the
            // server refuses them.
            if (isOwner) ...[
              buildSectionTitle(context.t.album_hidden_from),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Text(
                  context.t.album_hidden_from_description,
                  style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                ),
              ),
              const SizedBox(height: 8),
              for (final surface in hideFromPlaces)
                SwitchListTile.adaptive(
                  value: hiddenFrom.value.contains(surface),
                  onChanged: (bool value) async {
                    final next = {...hiddenFrom.value};
                    if (value) {
                      next.add(surface);
                    } else {
                      next.remove(surface);
                    }
                    // Optimistic, like every other switch here: the notifier reports failures as a toast
                    // and the next sync corrects the row either way.
                    hiddenFrom.value = next;
                    await ref.read(remoteAlbumProvider.notifier).setHiddenFrom(album.id, next);
                  },
                  activeThumbColor: hiddenFrom.value.contains(surface)
                      ? context.primaryColor
                      : context.themeData.disabledColor,
                  dense: true,
                  title: Text(
                    // A locked album's rows are named for the locked folder, the same as web's
                    // AlbumHiddenFromFields -- the timeline switch governs where its (locked) assets
                    // appear, and for them that view is the locked folder.
                    hideFromPlaceLabel(context, surface, locked: album.isLocked),
                    style: context.textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w500),
                  ),
                  subtitle: Text(
                    hideFromPlaceDescription(context, surface, locked: album.isLocked),
                    style: context.textTheme.labelLarge?.copyWith(color: context.colorScheme.onSurfaceSecondary),
                  ),
                ),
            ],
            buildSectionTitle(context.t.shared_album_section_people_title),
            if (isOwner) ...[
              ListTile(
                leading: const Icon(Icons.person_add_rounded),
                title: Text(context.t.invite_people),
                onTap: () async => addUsers(),
              ),
              const Divider(indent: 16),
            ],
            buildOwnerInfo(),
            buildSharedUsersList(),
          ],
        ),
      ),
    );
  }
}
