import {
  addAssetsToAlbum as addToAlbum,
  addAssetsToAlbums as addToAlbums,
  addLockedAssetsToAlbum,
  addUsersToAlbum,
  AlbumUserRole,
  BulkIdErrorReason,
  deleteAlbum,
  removeUserFromAlbum,
  setAlbumLocked,
  updateAlbumInfo,
  updateAlbumUser,
  type AlbumResponseDto,
  type AlbumsAddAssetsResponseDto,
  type AssetResponseDto,
  type BulkIdResponseDto,
  type UpdateAlbumDto,
  type UserResponseDto,
} from '@immich/sdk';
import { modalManager, toastManager, type ActionItem } from '@immich/ui';
import { mdiImageOutline, mdiLink, mdiPlus, mdiPlusBoxOutline, mdiShareVariantOutline, mdiUpload } from '@mdi/js';
import { type MessageFormatter } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { page } from '$app/state';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import AlbumAddUsersModal from '$lib/modals/AlbumAddUsersModal.svelte';
import AlbumOptionsModal from '$lib/modals/AlbumOptionsModal.svelte';
import SharedLinkCreateModal from '$lib/modals/SharedLinkCreateModal.svelte';
import { Route } from '$lib/route';
import { createAlbumAndRedirect } from '$lib/utils/album-utils';
import { downloadArchive } from '$lib/utils/asset-utils';
import { openFileUploadDialog } from '$lib/utils/file-uploader';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const getAlbumsActions = ($t: MessageFormatter) => {
  const Create: ActionItem = {
    title: $t('create_album'),
    icon: mdiPlusBoxOutline,
    onAction: () => createAlbumAndRedirect(),
  };

  return { Create };
};

export const getAlbumActions = ($t: MessageFormatter, album: AlbumResponseDto) => {
  const isOwned = album.albumUsers[0].user.id === authManager.user.id;

  const Share: ActionItem = {
    title: $t('share'),
    icon: mdiShareVariantOutline,
    $if: () => isOwned,
    onAction: async () => {
      if (await redirectIfLockedAndNotElevated(album)) {
        return;
      }
      await modalManager.show(AlbumOptionsModal, { album });
    },
  };

  const AddUsers: ActionItem = {
    title: $t('invite_people'),
    icon: mdiPlus,
    color: 'primary',
    onAction: async () => {
      if (await redirectIfLockedAndNotElevated(album)) {
        return;
      }
      await modalManager.show(AlbumAddUsersModal, { album });
    },
  };

  const CreateSharedLink: ActionItem = {
    title: $t('create_link'),
    icon: mdiLink,
    color: 'primary',
    onAction: async () => {
      if (await redirectIfLockedAndNotElevated(album)) {
        return;
      }
      await modalManager.show(SharedLinkCreateModal, { albumId: album.id });
    },
  };

  return { Share, AddUsers, CreateSharedLink };
};

export const getAlbumAssetActions = ($t: MessageFormatter, album: AlbumResponseDto, asset: AssetResponseDto) => {
  const SetCover: ActionItem = {
    title: $t('set_as_album_cover'),
    icon: mdiImageOutline,
    onAction: () => handleUpdateThumbnail(album, asset.id),
  };

  return { SetCover };
};

export const getAlbumAssetsActions = ($t: MessageFormatter, album: AlbumResponseDto, assets: TimelineAsset[]) => {
  const AddAssets: ActionItem = {
    title: $t('add_assets'),
    color: 'primary',
    icon: mdiPlusBoxOutline,
    $if: () => assets.length > 0,
    onAction: async () => {
      if (await redirectIfLockedAndNotElevated(album)) {
        return;
      }
      await addAssetsToAlbums(
        [album.id],
        assets.map(({ id }) => id),
        { notify: true },
      );
    },
  };

  const Upload: ActionItem = {
    title: $t('select_from_computer'),
    description: $t('album_upload_assets'),
    icon: mdiUpload,
    onAction: () => void openFileUploadDialog({ albumId: album.id }),
  };

  return { AddAssets, Upload };
};

export const addAssetsToAlbums = async (albumIds: string[], assetIds: string[], { notify }: { notify: boolean }) => {
  const $t = await getFormatter();

  try {
    if (albumIds.length === 1) {
      const albumId = albumIds[0];
      const results = await addToAlbum({ ...authManager.params, id: albumId, bulkIdsDto: { ids: assetIds } });
      if (notify) {
        notifyAddToAlbum($t, albumId, assetIds, results);
      }
    }

    if (albumIds.length > 1) {
      const results = await addToAlbums({ ...authManager.params, albumsAddAssetsDto: { albumIds, assetIds } });
      if (notify) {
        notifyAddToAlbums($t, albumIds, assetIds, results);
      }
    }

    eventManager.emit('AlbumAddAssets', { assetIds, albumIds });
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_assets_to_album'));
    return false;
  }
};

/**
 * Move assets into a locked album, evicting them from wherever they were.
 *
 * Not the same operation as `addAssetsToAlbums`, and the difference is why this exists. That posts to
 * the ordinary add-assets route, which refuses an asset that is already in a *different* locked album
 * -- an asset may belong to at most one at a time, and the refusal comes back as
 * `ALREADY_IN_LOCKED_ALBUM`. From inside a locked album that is every possible destination, so the
 * album picker had nothing it could offer and the button was simply removed. What was left was
 * "Remove from album".
 *
 * `POST /albums/:id/locked-assets` calls `moveIntoLockedFolder` server-side: it sets the assets to
 * Locked and removes them from every other album in the same operation. That eviction is what makes
 * it a move rather than an add, and what makes it legal for an asset that already lives in one.
 *
 * One album only, unlike its neighbour above -- "add to several albums at once" has no meaning when
 * membership is exclusive.
 */
export const moveAssetsToLockedAlbum = async (albumId: string, assetIds: string[]) => {
  const $t = await getFormatter();

  try {
    const results = await addLockedAssetsToAlbum({ ...authManager.params, id: albumId, bulkIdsDto: { ids: assetIds } });
    notifyAddToAlbum($t, albumId, assetIds, results);
    eventManager.emit('AlbumAddAssets', { assetIds, albumIds: [albumId] });
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_assets_to_album'));
    return false;
  }
};

const notifyAddToAlbum = ($t: MessageFormatter, albumId: string, assetIds: string[], results: BulkIdResponseDto[]) => {
  const successCount = results.filter(({ success }) => success).length;
  const duplicateCount = results.filter(({ error }) => error === BulkIdErrorReason.Duplicate).length;
  const alreadyInLockedAlbumCount = results.filter(
    ({ error }) => error === BulkIdErrorReason.AlreadyInLockedAlbum,
  ).length;
  // Guard clauses rather than an else-if chain: the branches test three different counts against one
  // total, so a `switch` on that total would put variables in its `case` labels and still need an `if`
  // in `default` for the partial-success branch.
  const describe = (): { description: string; severity: 'primary' | 'info' | 'warning' } => {
    if (duplicateCount === assetIds.length) {
      return {
        description: $t('assets_were_part_of_album_count', { values: { count: duplicateCount } }),
        severity: 'info',
      };
    }

    if (alreadyInLockedAlbumCount === assetIds.length) {
      return {
        description: $t('assets_already_in_another_locked_album_count', {
          values: { count: alreadyInLockedAlbumCount },
        }),
        severity: 'warning',
      };
    }

    if (successCount === assetIds.length) {
      return {
        description: $t('assets_added_to_album_count', { values: { count: successCount } }),
        severity: 'primary',
      };
    }

    if (successCount > 0) {
      return {
        description: $t('assets_added_to_album_partial_count', {
          values: { successCount, totalCount: assetIds.length },
        }),
        severity: 'primary',
      };
    }

    return {
      description: $t('assets_cannot_be_added_to_album_count', { values: { count: assetIds.length } }),
      severity: 'warning',
    };
  };

  const { description, severity } = describe();

  toastManager[severity](
    { description, button: { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id: albumId })) } },
    { timeout: 5000 },
  );
};

const notifyAddToAlbums = (
  $t: MessageFormatter,
  albumIds: string[],
  assetIds: string[],
  results: AlbumsAddAssetsResponseDto,
) => {
  if (results.error === BulkIdErrorReason.Duplicate) {
    toastManager.info($t('assets_were_part_of_albums_count', { values: { count: assetIds.length } }));
  } else if (results.error === BulkIdErrorReason.AlreadyInLockedAlbum) {
    toastManager.warning($t('assets_already_in_another_locked_album_count', { values: { count: assetIds.length } }));
  } else if (results.error) {
    toastManager.warning($t('assets_cannot_be_added_to_albums', { values: { count: assetIds.length } }));
  } else {
    toastManager.primary(
      $t('assets_added_to_albums_count', {
        values: { albumTotal: albumIds.length, assetTotal: assetIds.length },
      }),
    );
  }
};

export const handleUpdateUserAlbumRole = async ({
  albumId,
  userId,
  role,
}: {
  albumId: string;
  userId: string;
  role: AlbumUserRole;
}) => {
  const $t = await getFormatter();

  try {
    await updateAlbumUser({ id: albumId, userId, updateAlbumUserDto: { role } });
    eventManager.emit('AlbumUserUpdate', { albumId, userId, role });
  } catch (error) {
    handleError(error, $t('errors.unable_to_change_album_user_role'));
  }
};

export const handleAddUsersToAlbum = async (album: AlbumResponseDto, users: UserResponseDto[]) => {
  const $t = await getFormatter();

  try {
    await addUsersToAlbum({ id: album.id, addUsersDto: { albumUsers: users.map(({ id }) => ({ userId: id })) } });
    eventManager.emit('AlbumShare');
    return true;
  } catch (error) {
    handleError(error, $t('errors.error_adding_users_to_album'));
  }
};

export const handleRemoveUserFromAlbum = async (album: AlbumResponseDto, albumUser: UserResponseDto) => {
  const $t = await getFormatter();

  const confirmed = await modalManager.showDialog({
    title: $t('album_remove_user'),
    prompt: $t('album_remove_user_confirmation', { values: { user: albumUser.name } }),
    confirmText: $t('remove_user'),
  });

  if (!confirmed) {
    return;
  }

  try {
    await removeUserFromAlbum({ id: album.id, userId: albumUser.id });
    eventManager.emit('AlbumUserDelete', { albumId: album.id, userId: albumUser.id });
  } catch (error) {
    handleError(error, $t('errors.unable_to_remove_album_users'));
  }
};

const handleUpdateThumbnail = async (album: AlbumResponseDto, assetId: string) => {
  const $t = await getFormatter();

  try {
    const response = await updateAlbumInfo({
      id: album.id,
      updateAlbumDto: {
        albumThumbnailAssetId: assetId,
      },
    });
    eventManager.emit('AlbumUpdate', response);
    toastManager.primary($t('album_cover_updated'));
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_cover'));
  }
};

export const handleUpdateAlbum = async (album: AlbumResponseDto, dto: UpdateAlbumDto) => {
  const $t = await getFormatter();
  const { id } = album;

  if (await redirectIfLockedAndNotElevated(album)) {
    return false;
  }

  try {
    const response = await updateAlbumInfo({ id, updateAlbumDto: dto });
    eventManager.emit('AlbumUpdate', response);
    toastManager.primary({
      description: $t('album_info_updated'),
      button: { label: $t('view_album'), onclick: () => goto(Route.viewAlbum({ id })) },
    });

    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
  }
};

/**
 * True (and redirects to the PIN prompt) if `album` is locked and the current session isn't
 * elevated -- the server rejects any mutation on a locked album's contents (deleting the album,
 * etc.) in that state, same as it does for viewing/unlocking. Call this before attempting such a
 * mutation to get a proper PIN-prompt redirect instead of a raw "no access" error surfacing from
 * a failed API call.
 *
 * Deliberately does NOT carry the original action through as a resume-after-PIN action (unlike
 * lock/unlock) -- delete is destructive enough that we want the user to land on the album itself
 * and take a fresh, deliberate action once elevated, rather than have a delete silently fire the
 * moment they enter their PIN.
 */
export const redirectIfLockedAndNotElevated = async (album: AlbumResponseDto): Promise<boolean> => {
  if (!album.isLocked || authManager.isElevated) {
    return false;
  }

  const continueUrl = new URL(Route.viewAlbum({ id: album.id }), page.url);
  await goto(Route.pinPrompt({ continue: `${continueUrl.pathname}${continueUrl.search}` }));
  return true;
};

/**
 * Moves an album, and every photo in it, into or out of the locked folder.
 *
 * Not part of `handleUpdateAlbum`: the server rewrites the visibility of every member asset and evicts
 * them from other albums, so it is its own route and gets its own confirmation naming what will happen.
 * Elevation is required in both directions, so an unelevated session is sent to the PIN prompt rather
 * than allowed to fail against the API.
 */
/**
 * Announce an album change that moved its photos on or off a surface -- locking, unlocking, or a
 * `hiddenFrom` rule edit.
 *
 * Two events, always together, which is why this is a function rather than two lines at each call site.
 * `AlbumUpdate` refreshes the album's own metadata everywhere it is displayed; `AlbumVisibilityChange`
 * additionally makes the timelines re-read, because the set of photos that moved is not enumerable from
 * the response. Emitting only the first is precisely the bug this pairing exists to prevent: the rule
 * saved, the album row updated, and the open timeline kept showing photos that had left it until F5.
 */
export const notifyAlbumVisibilityChanged = (album: AlbumResponseDto) => {
  eventManager.emit('AlbumUpdate', album);
  eventManager.emit('AlbumVisibilityChange', album);
};

export const handleSetAlbumLocked = async (album: AlbumResponseDto, isLocked: boolean) => {
  const $t = await getFormatter();

  if (!authManager.isElevated) {
    const continueUrl = new URL(Route.viewAlbum({ id: album.id }), page.url);
    await goto(Route.pinPrompt({ continue: `${continueUrl.pathname}${continueUrl.search}` }));
    return false;
  }

  const confirmed = await modalManager.showDialog({
    title: $t(isLocked ? 'lock_album_confirm_title' : 'unlock_album_confirm_title'),
    prompt: $t(isLocked ? 'lock_album_confirm_prompt' : 'unlock_album_confirm_prompt', {
      values: { count: album.assetCount },
    }),
    confirmText: $t(isLocked ? 'lock_album_confirm_action' : 'unlock_album_confirm_action'),
  });

  if (!confirmed) {
    return false;
  }

  try {
    const response = await setAlbumLocked({ id: album.id, albumSetLockedDto: { isLocked } });
    notifyAlbumVisibilityChanged(response);
    toastManager.primary($t(isLocked ? 'lock_album_locked' : 'lock_album_unlocked'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_update_album_info'));
    return false;
  }
};

export const handleDeleteAlbum = async (album: AlbumResponseDto, options?: { prompt?: boolean; notify?: boolean }) => {
  const $t = await getFormatter();
  const { prompt = true, notify = true } = options ?? {};

  if (await redirectIfLockedAndNotElevated(album)) {
    return false;
  }

  if (prompt) {
    const confirmation =
      album.albumName.length > 0
        ? $t('album_delete_confirmation', { values: { album: album.albumName } })
        : $t('unnamed_album_delete_confirmation');
    const description = $t('album_delete_confirmation_description');
    const success = await modalManager.showDialog({ prompt: `${confirmation} ${description}` });
    if (!success) {
      return false;
    }
  }

  try {
    await deleteAlbum({ id: album.id });
    eventManager.emit('AlbumDelete', album);
    if (notify) {
      toastManager.primary();
    }
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_delete_album'), { notify });
    return false;
  }
};

export const handleDownloadAlbum = async (album: AlbumResponseDto) => {
  if (await redirectIfLockedAndNotElevated(album)) {
    return;
  }

  await downloadArchive(`${album.albumName}.zip`, { albumId: album.id });
};
