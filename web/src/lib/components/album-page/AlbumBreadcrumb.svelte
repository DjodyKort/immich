<script lang="ts">
  import { Route } from '$lib/route';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiLockOutline } from '@mdi/js';

  type Props = {
    /** Root first, the album itself last. Rendered only when there is an ancestor to show. */
    chain: AlbumResponseDto[];
  };

  let { chain }: Props = $props();

  // The album itself is the page title right below; repeating it here would be noise.
  const ancestors = $derived(chain.slice(0, -1));
</script>

{#if ancestors.length > 0}
  <nav class="flex flex-wrap items-center gap-1 text-sm text-gray-500 dark:text-gray-400">
    {#each ancestors as ancestor (ancestor.id)}
      <a
        href={Route.viewAlbum({ id: ancestor.id })}
        class="flex items-center gap-1 rounded-sm px-1 hover:underline focus-visible:outline-2"
      >
        {#if ancestor.isLocked}
          <Icon icon={mdiLockOutline} size="0.9rem" />
        {/if}
        <span class="max-w-40 truncate">{ancestor.albumName}</span>
      </a>
      <Icon icon={mdiChevronRight} size="0.9rem" />
    {/each}
  </nav>
{/if}
