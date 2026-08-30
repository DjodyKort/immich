<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumLockedIcon from '$lib/components/album-page/AlbumLockedIcon.svelte';
  import { dateFormats } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import type { ContextMenuPosition } from '$lib/utils/context-menu';
  import { AlbumUserRole, type AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiShareVariantOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    album: AlbumResponseDto;
    /** Nesting level, 0 at the top. Only ever non-zero under folder grouping. */
    depth?: number;
    isFolder?: boolean;
    isExpanded?: boolean;
    onToggleExpanded?: (() => void) | undefined;
    onShowContextMenu?: ((position: ContextMenuPosition, album: AlbumResponseDto) => unknown) | undefined;
  }

  let {
    album,
    depth = 0,
    isFolder = false,
    isExpanded = true,
    onToggleExpanded = undefined,
    onShowContextMenu = undefined,
  }: Props = $props();

  const showContextMenu = (position: ContextMenuPosition) => {
    onShowContextMenu?.(position, album);
  };

  const dateLocaleString = (dateString: string) => {
    return new Date(dateString).toLocaleDateString($locale, dateFormats.album);
  };

  const oncontextmenu = (event: MouseEvent) => {
    event.preventDefault();
    showContextMenu({ x: event.x, y: event.y });
  };
</script>

<tr
  class="flex w-full place-items-center border-3 border-transparent p-2 text-center odd:bg-subtle/80 even:bg-subtle/20 hover:cursor-pointer hover:border-immich-primary/75 md:px-5 md:py-2 odd:dark:bg-immich-dark-gray/75 even:dark:bg-immich-dark-gray/50 dark:hover:border-immich-dark-primary/75"
  onclick={() => goto(Route.viewAlbum(album))}
  {oncontextmenu}
>
  <td class="text-md w-8/12 items-center text-start text-ellipsis sm:w-4/12 md:w-4/12 xl:w-[30%] 2xl:w-[40%]">
    <span style="padding-inline-start: {depth * 1.5}rem" class="inline-flex items-center align-middle">
      {#if isFolder}
        <!-- `stopPropagation`: the row itself navigates to the album, and expanding a folder is not
             the same intent as opening it. -->
        <button
          type="button"
          class="me-1 rounded-sm p-0.5 hover:bg-gray-200 focus-visible:outline-2 dark:hover:bg-gray-700"
          aria-expanded={isExpanded}
          aria-label={album.albumName}
          onclick={(event) => {
            event.stopPropagation();
            onToggleExpanded?.();
          }}
        >
          <Icon
            icon={mdiChevronRight}
            size="16"
            class="transition-transform duration-200 {isExpanded ? 'rotate-90' : 'rotate-0'}"
          />
        </button>
      {:else if depth > 0}
        <!-- Keeps a leaf's name aligned with its siblings that do have a chevron. -->
        <span class="me-1 inline-block w-[21px]"></span>
      {/if}
    </span><AlbumLockedIcon {album} class="me-1 inline align-text-bottom" />{album.albumName}
    {#if album.shared}
      <Icon
        icon={mdiShareVariantOutline}
        size="16"
        class="ms-1 inline opacity-70"
        title={album.albumUsers.find(({ user: { id } }) => id === authManager.user.id)?.role === AlbumUserRole.Owner
          ? $t('shared_by_you')
          : $t('shared_by_user', {
              values: { user: album.albumUsers[0].user.name },
            })}
      />
    {/if}
  </td>
  <td class="text-md text-center text-ellipsis sm:w-2/12 md:w-2/12 xl:w-[15%] 2xl:w-[12%]">
    {$t('items_count', { values: { count: album.assetCount } })}
  </td>
  <td class="text-md hidden w-3/12 text-center text-ellipsis sm:block xl:w-[15%] 2xl:w-[12%]">
    {dateLocaleString(album.updatedAt)}
  </td>
  <td class="text-md hidden w-3/12 text-center text-ellipsis sm:block xl:w-[15%] 2xl:w-[12%]">
    {dateLocaleString(album.createdAt)}
  </td>
  <td class="text-md hidden text-center text-ellipsis xl:block xl:w-[15%] 2xl:w-[12%]">
    {#if album.endDate}
      {dateLocaleString(album.endDate)}
    {:else}
      -
    {/if}
  </td>
  <td class="text-md hidden text-center text-ellipsis xl:block xl:w-[15%] 2xl:w-[12%]">
    {#if album.startDate}
      {dateLocaleString(album.startDate)}
    {:else}
      -
    {/if}
  </td>
</tr>
