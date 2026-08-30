<script lang="ts">
  import AlbumCard from '$lib/components/album-page/AlbumCard.svelte';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    children: AlbumResponseDto[];
  };

  let { children }: Props = $props();
</script>

{#if children.length > 0}
  <section class="mb-6">
    <Text size="small" color="muted" class="mb-2 block tracking-wide uppercase">
      {$t('album_sub_album_count', { values: { count: children.length } })}
    </Text>
    <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6">
      {#each children as child (child.id)}
        <AlbumCard album={child} showItemCount />
      {/each}
    </div>
  </section>
{/if}
