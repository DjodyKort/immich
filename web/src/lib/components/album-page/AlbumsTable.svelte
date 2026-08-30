<script lang="ts">
  import AlbumTableHeader from '$lib/components/album-page/AlbumsTableHeader.svelte';
  import AlbumTableRow from '$lib/components/album-page/AlbumsTableRow.svelte';
  import { AlbumGroupBy, albumViewSettings } from '$lib/stores/preferences.store';
  import {
    isAlbumGroupCollapsed,
    sortOptionsMetadata,
    toggleAlbumGroupCollapsing,
    type AlbumGroup,
    type AlbumTreeNode,
  } from '$lib/utils/album-utils';
  import type { ContextMenuPosition } from '$lib/utils/context-menu';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';

  interface Props {
    groupedAlbums: AlbumGroup[];
    albumGroupOption?: string;
    /**
     * The tree as rows, when folder grouping is active. Empty otherwise.
     *
     * Kept separate from `groupedAlbums` rather than folded into it: a folder is not a group of
     * albums, it *is* an album, with its own row, its own counts and its own page.
     */
    folderRows?: AlbumTreeNode[];
    onShowContextMenu?: ((position: ContextMenuPosition, album: AlbumResponseDto) => unknown) | undefined;
  }

  let { groupedAlbums, albumGroupOption = AlbumGroupBy.None, folderRows = [], onShowContextMenu }: Props = $props();
</script>

<table class="mt-2 w-full text-start">
  <thead
    class="mb-4 flex h-12 w-full rounded-md border bg-gray-50 text-primary dark:border-immich-dark-gray dark:bg-immich-dark-gray"
  >
    <tr class="flex w-full place-items-center p-2 md:p-5">
      {#each sortOptionsMetadata as option, index (index)}
        <AlbumTableHeader {option} />
      {/each}
    </tr>
  </thead>
  {#if folderRows.length > 0}
    <!-- Folder grouping. One flat tbody of indented rows: a folder and a plain album are both albums
         and both get a row, which is exactly what the tree view is for. -->
    <tbody class="block w-full overflow-y-auto rounded-md border dark:border-immich-dark-gray dark:text-immich-dark-fg">
      {#each folderRows as row (row.album.id)}
        <AlbumTableRow
          album={row.album}
          depth={row.depth}
          isFolder={row.children.length > 0}
          isExpanded={!isAlbumGroupCollapsed($albumViewSettings, row.album.id)}
          onToggleExpanded={() => toggleAlbumGroupCollapsing(row.album.id)}
          {onShowContextMenu}
        />
      {/each}
    </tbody>
    <!-- Folder grouping with no rows means a search is active: flat, no group header. -->
  {:else if albumGroupOption === AlbumGroupBy.None || albumGroupOption === AlbumGroupBy.Folder}
    <tbody class="block w-full overflow-y-auto rounded-md border dark:border-immich-dark-gray dark:text-immich-dark-fg">
      {#each groupedAlbums[0].albums as album (album.id)}
        <AlbumTableRow {album} {onShowContextMenu} />
      {/each}
    </tbody>
  {:else}
    {#each groupedAlbums as albumGroup (albumGroup.id)}
      {@const isCollapsed = isAlbumGroupCollapsed($albumViewSettings, albumGroup.id)}
      {@const iconRotation = isCollapsed ? 'rotate-0' : 'rotate-90'}
      <tbody
        class="mt-4 block w-full overflow-y-auto rounded-md border dark:border-immich-dark-gray dark:text-immich-dark-fg"
      >
        <tr
          class="flex w-full place-items-center p-2 md:py-3 md:ps-5 md:pe-5"
          onclick={() => toggleAlbumGroupCollapsing(albumGroup.id)}
          aria-expanded={!isCollapsed}
        >
          <td class="text-md -mb-1 text-start">
            <Icon
              icon={mdiChevronRight}
              size="20"
              class="-mt-2 inline-block transition-all duration-250 {iconRotation}"
            />
            <span class="text-2xl font-bold">{albumGroup.name}</span>
            <span class="ms-1.5">
              ({$t('albums_count', { values: { count: albumGroup.albums.length } })})
            </span>
          </td>
        </tr>
      </tbody>
      {#if !isCollapsed}
        <tbody
          class="mt-4 block w-full overflow-y-auto rounded-md border dark:border-immich-dark-gray dark:text-immich-dark-fg"
          transition:slide={{ duration: 300 }}
        >
          {#each albumGroup.albums as album (album.id)}
            <AlbumTableRow {album} {onShowContextMenu} />
          {/each}
        </tbody>
      {/if}
    {/each}
  {/if}
</table>
