<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { hideFromPlaceLabels } from '$lib/utils/hidden-from';
  import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
  import { Badge, Text } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    isOwner: boolean;
  }

  let { asset, isOwner }: Props = $props();

  // The shared table rather than a sixth copy of the same six strings. It also carries the `locked`
  // relabel, which this panel was missing: for an asset in the locked folder the timeline bit governs
  // that grid, so the hide-from modal calls the row "Locked folder" while this said "Main timeline" --
  // one state described two ways, in two places a person sees within a tap of each other.
  const labels = $derived(hideFromPlaceLabels($t, { locked: asset.visibility === AssetVisibility.Locked }));

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
          <span class="px-2 font-light">{labels.get(surface)?.label ?? surface}</span>
        </Badge>
      {/each}
    </section>
  </section>
{/if}
