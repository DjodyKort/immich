<script lang="ts">
  import AlbumCardGroup from '$lib/components/album-page/AlbumCardGroup.svelte';
  import AlbumFolderSection from '$lib/components/album-page/AlbumFolderSection.svelte';
  import AlbumsTable from '$lib/components/album-page/AlbumsTable.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import RightClickContextMenu from '$lib/components/shared-components/context-menu/RightClickContextMenu.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import AlbumEditModal from '$lib/modals/AlbumEditModal.svelte';
  import AlbumOptionsModal from '$lib/modals/AlbumOptionsModal.svelte';
  import {
    handleDeleteAlbum,
    handleDownloadAlbum,
    handleMoveAlbum,
    redirectIfLockedAndNotElevated,
  } from '$lib/services/album.service';
  import {
    albumViewSettings,
    AlbumFilter,
    AlbumGroupBy,
    AlbumSortBy,
    AlbumViewMode,
    locale,
    SortOrder,
    type AlbumViewSettings,
  } from '$lib/stores/preferences.store';
  import {
    buildAlbumTree,
    flattenAlbumTree,
    getSelectedAlbumGroupOption,
    isAlbumGroupCollapsed,
    sortAlbums,
    stringToSortOrder,
    type AlbumGroup,
    type AlbumTreeNode,
  } from '$lib/utils/album-utils';
  import type { ContextMenuPosition } from '$lib/utils/context-menu';
  import { normalizeSearchString } from '$lib/utils/string-utils';
  import { AlbumUserRole, type AlbumResponseDto, type SharedLinkResponseDto } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import {
    mdiDeleteOutline,
    mdiDownload,
    mdiFolderMoveOutline,
    mdiRenameOutline,
    mdiShareVariantOutline,
  } from '@mdi/js';
  import { groupBy } from 'lodash-es';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    ownedAlbums?: AlbumResponseDto[];
    sharedAlbums?: AlbumResponseDto[];
    searchQuery?: string;
    userSettings: AlbumViewSettings;
    allowEdit?: boolean;
    showOwner?: boolean;
    albumGroupIds?: string[];
    empty?: Snippet;
  }

  let {
    ownedAlbums = $bindable([]),
    sharedAlbums = $bindable([]),
    searchQuery = '',
    userSettings,
    allowEdit = false,
    showOwner = false,
    // eslint-disable-next-line no-useless-assignment
    albumGroupIds = $bindable([]),
    empty,
  }: Props = $props();

  interface AlbumGroupOption {
    [option: string]: (order: SortOrder, albums: AlbumResponseDto[]) => AlbumGroup[];
  }

  const groupOptions: AlbumGroupOption = {
    /** No grouping */
    [AlbumGroupBy.None]: (order, albums): AlbumGroup[] => {
      return [
        {
          id: $t('albums'),
          name: $t('albums'),
          albums,
        },
      ];
    },

    /** Group by year */
    [AlbumGroupBy.Year]: (order, albums): AlbumGroup[] => {
      const unknownYear = $t('unknown_year');
      const useStartDate = userSettings.sortBy === AlbumSortBy.OldestPhoto;

      const groupedByYear = groupBy(albums, (album) => {
        const date = useStartDate ? album.startDate : album.endDate;
        return date ? new Date(date).getFullYear() : unknownYear;
      });

      const sortSign = order === SortOrder.Desc ? -1 : 1;
      const sortedByYear = Object.entries(groupedByYear).sort(([a], [b]) => {
        // We make sure empty albums stay at the end of the list
        if (a === unknownYear) {
          return 1;
        }
        return b === unknownYear ? -1 : (Number.parseInt(a) - Number.parseInt(b)) * sortSign;
      });

      return sortedByYear.map(([year, albums]) => ({
        id: year,
        name: year,
        albums,
      }));
    },

    /** Group by owner */
    [AlbumGroupBy.Owner]: (order, albums): AlbumGroup[] => {
      const currentUserId = authManager.user.id;
      const groupedByOwnerIds = groupBy(albums, (album) => album.albumUsers[0].user.id);

      const sortSign = order === SortOrder.Desc ? -1 : 1;
      const sortedByOwnerNames = Object.entries(groupedByOwnerIds).sort(([ownerIdA, albumsA], [ownerIdB, albumsB]) => {
        // We make sure owned albums stay either at the beginning or the end
        // of the list
        if (ownerIdA === currentUserId) {
          return -sortSign;
        }
        if (ownerIdB === currentUserId) {
          return sortSign;
        }

        const ownerA = albumsA[0].albumUsers[0].user;
        const ownerB = albumsB[0].albumUsers[0].user;
        return ownerA.name.localeCompare(ownerB.name, $locale) * sortSign;
      });

      return sortedByOwnerNames.map(([ownerId, albums]) => ({
        id: ownerId,
        name: ownerId === currentUserId ? $t('my_albums') : albums[0].albumUsers[0].user.name,
        albums,
      }));
    },
  };

  let albums = $derived.by(() => {
    switch (userSettings.filter) {
      case AlbumFilter.Owned: {
        return ownedAlbums;
      }
      case AlbumFilter.Shared: {
        return sharedAlbums;
      }
      default: {
        const nonOwnedAlbums = sharedAlbums.filter(
          (album) =>
            album.albumUsers.find(({ user: { id } }) => id === authManager.user.id)?.role !== AlbumUserRole.Owner,
        );
        return nonOwnedAlbums.length > 0 ? ownedAlbums.concat(nonOwnedAlbums) : ownedAlbums;
      }
    }
  });
  const normalizedSearchQuery = $derived(normalizeSearchString(searchQuery));
  let filteredAlbums = $derived(
    normalizedSearchQuery
      ? albums.filter(
          ({ albumName, description }) =>
            normalizeSearchString(albumName).includes(normalizedSearchQuery) ||
            normalizeSearchString(description).includes(normalizedSearchQuery),
        )
      : albums,
  );

  let albumGroupOption = $derived(getSelectedAlbumGroupOption(userSettings));

  /**
   * Whether to render the tree rather than a flat list.
   *
   * A search is always flat, in every grouping. Nesting must never make an album unfindable, and the
   * answer to "show me albums matching this" has to include nested ones -- so the one place structure
   * is dropped is the one place the user has already narrowed the list themselves.
   */
  let isFolderView = $derived(albumGroupOption === AlbumGroupBy.Folder && !normalizedSearchQuery);

  /**
   * The tree, sorted per level.
   *
   * Sorting the flat list *before* building means each node's children come out in sort order, because
   * `buildAlbumTree` preserves input order within a level. Sorting after would interleave children
   * with albums they have nothing to do with.
   */
  let folderTree = $derived(
    isFolderView
      ? buildAlbumTree(sortAlbums(filteredAlbums, { sortBy: userSettings.sortBy, orderBy: userSettings.sortOrder }))
      : [],
  );

  /**
   * The tree as rows, parents immediately before their children, collapsed subtrees omitted.
   *
   * The sort is the identity here on purpose: `folderTree` was built from an already-sorted flat list,
   * so every level is in order and sorting again would only redo it.
   */
  let folderRows = $derived(
    isFolderView
      ? flattenAlbumTree(
          folderTree,
          (albumId) => !isAlbumGroupCollapsed($albumViewSettings, albumId),
          (albums) => albums,
        )
      : [],
  );

  let folderNodes = $derived(folderTree.filter((node) => node.children.length > 0));
  let folderLeaves = $derived(folderTree.filter((node) => node.children.length === 0).map(({ album }) => album));
  let groupedAlbums = $derived.by(() => {
    const groupFunc = groupOptions[albumGroupOption] ?? groupOptions[AlbumGroupBy.None];
    const groupedAlbums = groupFunc(stringToSortOrder(userSettings.groupOrder), filteredAlbums);

    return groupedAlbums.map((group) => ({
      id: group.id,
      name: group.name,
      albums: sortAlbums(group.albums, { sortBy: userSettings.sortBy, orderBy: userSettings.sortOrder }),
    }));
  });

  let contextMenuPosition: ContextMenuPosition = $state({ x: 0, y: 0 });
  let selectedAlbum: AlbumResponseDto | undefined = $state();
  let isOpen = $state(false);

  // TODO get rid of this
  $effect(() => {
    // In folder view the collapsible units are the folders themselves, at every depth -- that is what
    // collapse-all has to act on. `groupedAlbums` describes the year/owner arrangement and says nothing
    // about the tree.
    albumGroupIds = isFolderView ? collectFolderIds(folderTree) : groupedAlbums.map(({ id }) => id);
  });

  const collectFolderIds = (nodes: AlbumTreeNode[]): string[] =>
    nodes.flatMap((node) => (node.children.length > 0 ? [node.album.id, ...collectFolderIds(node.children)] : []));

  let showFullContextMenu = $derived(
    allowEdit && selectedAlbum && selectedAlbum.albumUsers[0].user.id === authManager.user.id,
  );

  onMount(async () => {
    if (allowEdit) {
      await removeAlbumsIfEmpty();
    }
  });

  const showAlbumContextMenu = (contextMenuDetail: ContextMenuPosition, album: AlbumResponseDto) => {
    selectedAlbum = album;
    contextMenuPosition = {
      x: contextMenuDetail.x,
      y: contextMenuDetail.y,
    };
    isOpen = true;
  };

  const closeAlbumContextMenu = () => {
    isOpen = false;
  };

  const handleSelect = async (action: 'edit' | 'share' | 'download' | 'delete' | 'move') => {
    closeAlbumContextMenu();

    if (!selectedAlbum) {
      return;
    }

    switch (action) {
      case 'edit': {
        if (await redirectIfLockedAndNotElevated(selectedAlbum)) {
          break;
        }
        await modalManager.show(AlbumEditModal, { album: selectedAlbum });
        break;
      }

      case 'share': {
        if (await redirectIfLockedAndNotElevated(selectedAlbum)) {
          break;
        }
        await modalManager.show(AlbumOptionsModal, { album: selectedAlbum });
        break;
      }

      case 'move': {
        if (await redirectIfLockedAndNotElevated(selectedAlbum)) {
          break;
        }
        await handleMoveAlbum(selectedAlbum);
        break;
      }

      case 'download': {
        await handleDownloadAlbum(selectedAlbum);
        break;
      }

      case 'delete': {
        await handleDeleteAlbum(selectedAlbum);
        break;
      }
    }
  };

  const removeAlbumsIfEmpty = async () => {
    const albumsToRemove = ownedAlbums.filter((album) => album.assetCount === 0 && !album.albumName);
    await Promise.allSettled(albumsToRemove.map((album) => handleDeleteAlbum(album, { prompt: false, notify: false })));
  };

  const findAndUpdate = (albums: AlbumResponseDto[], album: AlbumResponseDto) => {
    const target = albums.find(({ id }) => id === album.id);
    if (target) {
      Object.assign(target, album);
    }

    return albums;
  };

  const onAlbumUpdate = (album: AlbumResponseDto) => {
    ownedAlbums = findAndUpdate(ownedAlbums, album);
    sharedAlbums = findAndUpdate(sharedAlbums, album);
  };

  /**
   * A move changes where an album sits, so the row has to move with it -- `onAlbumUpdate` patches the
   * object in place, which is right for a rename and not enough for this.
   */
  const onAlbumMove = (album: AlbumResponseDto) => {
    onAlbumUpdate(album);
    ownedAlbums = [...ownedAlbums];
    sharedAlbums = [...sharedAlbums];
  };

  const onAlbumDelete = (album: AlbumResponseDto) => {
    ownedAlbums = ownedAlbums.filter(({ id }) => id !== album.id);
    sharedAlbums = sharedAlbums.filter(({ id }) => id !== album.id);
  };

  const onSharedLinkCreate = (sharedLink: SharedLinkResponseDto) => {
    if (sharedLink.album) {
      onAlbumUpdate(sharedLink.album);
    }
  };
</script>

<OnEvents {onAlbumUpdate} {onAlbumMove} {onAlbumDelete} {onSharedLinkCreate} />

{#if albums.length > 0}
  {#if isFolderView && userSettings.view === AlbumViewMode.Cover}
    <!-- Folders, then the albums that are not inside one. A folder is its header rather than a card,
         so the two cannot share a grid. -->
    {#each folderNodes as node (node.album.id)}
      <AlbumFolderSection {node} {showOwner} onShowContextMenu={showAlbumContextMenu} />
    {/each}
    {#if folderLeaves.length > 0}
      <AlbumCardGroup
        albums={folderLeaves}
        {showOwner}
        showDateRange
        showItemCount
        onShowContextMenu={showAlbumContextMenu}
      />
    {/if}
  {:else if userSettings.view === AlbumViewMode.Cover}
    <!-- Album Cards. Folder grouping reaches here only while searching, where the list is flat and a
         group header would be a heading over the whole result. -->
    {#if albumGroupOption === AlbumGroupBy.None || albumGroupOption === AlbumGroupBy.Folder}
      <AlbumCardGroup
        albums={groupedAlbums[0].albums}
        {showOwner}
        showDateRange
        showItemCount
        onShowContextMenu={showAlbumContextMenu}
      />
    {:else}
      {#each groupedAlbums as albumGroup (albumGroup.id)}
        <AlbumCardGroup
          albums={albumGroup.albums}
          group={albumGroup}
          {showOwner}
          showDateRange
          showItemCount
          onShowContextMenu={showAlbumContextMenu}
        />
      {/each}
    {/if}
  {:else if userSettings.view === AlbumViewMode.List}
    <!-- Album Table -->
    <AlbumsTable {groupedAlbums} {albumGroupOption} {folderRows} onShowContextMenu={showAlbumContextMenu} />
  {/if}
{:else}
  <!-- Empty Message -->
  {@render empty?.()}
{/if}

<!-- Context Menu -->
<RightClickContextMenu title={$t('album_options')} {...contextMenuPosition} {isOpen} onClose={closeAlbumContextMenu}>
  {#if showFullContextMenu}
    <MenuOption icon={mdiRenameOutline} text={$t('edit_album')} onClick={() => handleSelect('edit')} />
    <MenuOption icon={mdiShareVariantOutline} text={$t('share')} onClick={() => handleSelect('share')} />
    <MenuOption icon={mdiFolderMoveOutline} text={$t('album_move_to')} onClick={() => handleSelect('move')} />
  {/if}
  <MenuOption icon={mdiDownload} text={$t('download')} onClick={() => handleSelect('download')} />
  {#if showFullContextMenu}
    <MenuOption icon={mdiDeleteOutline} text={$t('delete')} onClick={() => handleSelect('delete')} />
  {/if}
</RightClickContextMenu>
