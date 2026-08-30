<script lang="ts">
  import AlbumCard from '$lib/components/album-page/AlbumCard.svelte';
  import AlbumFolderSection from '$lib/components/album-page/AlbumFolderSection.svelte';
  import { Route } from '$lib/route';
  import { albumViewSettings } from '$lib/stores/preferences.store';
  import { isAlbumGroupCollapsed, toggleAlbumGroupCollapsing, type AlbumTreeNode } from '$lib/utils/album-utils';
  import type { ContextMenuPosition } from '$lib/utils/context-menu';
  import { getContextMenuPositionFromEvent } from '$lib/utils/context-menu';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { slide } from 'svelte/transition';

  interface Props {
    node: AlbumTreeNode;
    showOwner?: boolean;
    onShowContextMenu?: ((position: ContextMenuPosition, album: AlbumResponseDto) => unknown) | undefined;
  }

  let { node, showOwner = false, onShowContextMenu }: Props = $props();

  // Keyed by album id, and stored under the `Folder` grouping, so folder collapse state is independent
  // of the year/owner collapse sets. See `getCollapsedAlbumGroups`.
  let isCollapsed = $derived(isAlbumGroupCollapsed($albumViewSettings, node.album.id));
  let iconRotation = $derived(isCollapsed ? 'rotate-0' : 'rotate-90');

  // Folders first, then plain albums. A folder is represented by its header rather than by a card, so
  // mixing the two in one grid would put a heading between cards at unpredictable points.
  let folders = $derived(node.children.filter((child) => child.children.length > 0));
  let leaves = $derived(node.children.filter((child) => child.children.length === 0).map(({ album }) => album));
</script>

<section style="margin-inline-start: {node.depth > 0 ? '1.5rem' : '0'}">
  <div class="mt-2 flex items-center gap-2">
    <button
      type="button"
      class="flex items-center gap-1 rounded-sm p-1 hover:bg-gray-100 focus-visible:outline-2 dark:hover:bg-gray-800"
      aria-expanded={!isCollapsed}
      aria-label={node.album.albumName}
      onclick={() => toggleAlbumGroupCollapsing(node.album.id)}
    >
      <Icon icon={mdiChevronRight} size="1.5rem" class="transition-transform duration-200 {iconRotation}" />
    </button>

    <!-- The header links to the folder's own album: a parent has photos of its own, and with no card
         in the grid this is the only way to reach them. -->
    <a href={Route.viewAlbum({ id: node.album.id })} class="truncate text-2xl font-bold hover:underline">
      {node.album.albumName}
    </a>

    <Text size="small" color="muted" class="shrink-0">
      {$t('album_sub_album_count', { values: { count: node.children.length } })}
      {#if node.album.assetCount > 0}
        &middot; {$t('items_count', { values: { count: node.album.assetCount } })}
      {/if}
    </Text>
  </div>
  <hr class="mb-2 dark:border-immich-dark-gray" />

  {#if !isCollapsed}
    <div transition:slide={{ duration: 300 }}>
      {#each folders as child (child.album.id)}
        <AlbumFolderSection node={child} {showOwner} {onShowContextMenu} />
      {/each}

      {#if leaves.length > 0}
        <div class="grid grid-auto-fill-56 gap-y-4">
          {#each leaves as album, index (album.id)}
            <a
              href={Route.viewAlbum({ id: album.id })}
              oncontextmenu={(event) => {
                event.preventDefault();
                onShowContextMenu?.(getContextMenuPositionFromEvent(event), album);
              }}
            >
              <AlbumCard
                {album}
                {showOwner}
                showDateRange
                showItemCount
                preload={index < 20}
                onShowContextMenu={(position) => onShowContextMenu?.(position, album)}
              />
            </a>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</section>
