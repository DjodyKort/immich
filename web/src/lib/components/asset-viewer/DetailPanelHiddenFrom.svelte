<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { AssetSurface, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  const labels = $derived<Record<AssetSurface, string>>({
    [AssetSurface.Timeline]: $t('hide_from_place_timeline'),
    [AssetSurface.Search]: $t('hide_from_place_search'),
    [AssetSurface.Map]: $t('hide_from_place_map'),
    [AssetSurface.People]: $t('hide_from_place_people'),
    [AssetSurface.Memories]: $t('hide_from_place_memories'),
    [AssetSurface.Folders]: $t('hide_from_place_folders'),
  });

  // `hiddenFrom` is always present on the response, and empty for the overwhelming majority of
  // assets -- so this whole section costs nothing until someone has actually excluded something.
  let hiddenFrom = $derived(asset.hiddenFrom ?? []);
</script>

{#if isOwner && !authManager.isSharedLink && hiddenFrom.length > 0}
  <section class="mt-4 px-4">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text color="muted">{$t('hidden_from_places')}</Text>
    </div>
    <section class="flex flex-wrap gap-1 pt-2" data-testid="detail-panel-hidden-from">
      {#each hiddenFrom as surface (surface)}
        <Badge size="small" shape="round">
          <span class="px-2 font-light">{labels[surface]}</span>
        </Badge>
      {/each}
    </section>
  </section>
{/if}
