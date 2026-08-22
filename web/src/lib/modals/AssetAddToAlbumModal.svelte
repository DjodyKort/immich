<script lang="ts">
  import AlbumPickerModal from '$lib/modals/AlbumPickerModal.svelte';
  import { addAssetsToAlbums, moveAssetsToLockedAlbum } from '$lib/services/album.service';
  import { type AlbumResponseDto } from '@immich/sdk';

  type Props = {
    assetIds: string[];
    onClose: () => void;
    lockedOnly?: boolean;
    /**
     * Move into one locked album rather than add to albums.
     *
     * The add-assets route refuses an asset that is already in a different locked album, so it cannot
     * reorganise a locked album's contents -- only `POST /albums/:id/locked-assets` can, because it
     * evicts from the old album as part of the same operation. Always paired with `lockedOnly`: an
     * ordinary album is not a legal destination for this route, and the server says so.
     */
    move?: boolean;
  };

  const { assetIds, onClose, lockedOnly = false, move = false }: Props = $props();

  const handleClose = async (albums?: AlbumResponseDto[]) => {
    const albumIds = (albums ?? []).map(({ id }) => id);
    if (albumIds.length === 0) {
      onClose();
      return;
    }

    // One album when moving. Membership in a locked album is exclusive, so "move into several" has no
    // meaning, and the picker's multi-select would otherwise silently drop all but the first.
    const success = move
      ? await moveAssetsToLockedAlbum(albumIds[0], assetIds)
      : await addAssetsToAlbums(albumIds, assetIds, { notify: true });
    if (success) {
      onClose();
    }
  };
</script>

<AlbumPickerModal selectedItemsCount={assetIds.length} onClose={handleClose} {lockedOnly} />
