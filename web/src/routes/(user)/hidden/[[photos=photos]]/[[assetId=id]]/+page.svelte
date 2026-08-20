<script lang="ts">
  import AlbumCardGroup from '$lib/components/album-page/AlbumCardGroup.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import FavoriteAction from '$lib/components/timeline/actions/FavoriteAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import type { AssetSurface } from '@immich/sdk';
  import { ActionButton, CommandPaletteDefaultProvider } from '@immich/ui';
  import { mdiDotsVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = { hidden: true };
  const hiddenAlbums = $derived(data.hiddenAlbums);

  const handleEscape = () => {
    if (!assetMultiSelectManager.selectionActive) {
      return;
    }

    assetMultiSelectManager.clear();
    return;
  };

  // This view has no surface of its own to leave -- an asset qualifies purely because
  // `hiddenFrom` is non-empty. Once every switch in the hide-from-places modal is cleared, the
  // mask goes back to empty and the asset no longer belongs here, whether that happened from the
  // bulk action below or from the single-asset viewer opened on a card in this grid.
  const handleHiddenFrom = ({ assetIds, hiddenFrom }: { assetIds: string[]; hiddenFrom: AssetSurface[] }) => {
    if (hiddenFrom.length === 0) {
      timelineManager.removeAssets(assetIds);
    }
  };

  // Deliberately no Archive/Lock actions here: both would trip the shared asset viewer's
  // unconditional removal-on-action behavior and drop an asset from this grid even though its
  // `hiddenFrom` mask -- the only thing that decides membership here -- hasn't changed.
  const { AddToAlbum, HideFromPlaces } = $derived(getAssetBulkActions($t));
</script>

<OnEvents onAssetsHiddenFrom={handleHiddenFrom} />

<UserPageLayout title={data.meta.title} hideNavbar={assetMultiSelectManager.selectionActive} scrollbar={false}>
  <Timeline
    enableRouting={true}
    bind:timelineManager
    {options}
    assetInteraction={assetMultiSelectManager}
    onEscape={handleEscape}
  >
    {#if hiddenAlbums.length > 0}
      <section class="px-2 pt-2 pb-6">
        <h2 class="mb-3 text-lg font-medium text-black dark:text-white">{$t('hidden_albums')}</h2>
        <AlbumCardGroup albums={hiddenAlbums} showDateRange showItemCount />
      </section>
    {/if}
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_hidden_assets_message')} title={$t('nothing_here_yet')} class="mx-auto mt-10" />
    {/snippet}
  </Timeline>
</UserPageLayout>

<!-- Multi-selection mode app bar -->
{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    <CommandPaletteDefaultProvider name={$t('assets')} actions={[AddToAlbum, HideFromPlaces]} />
    <SelectAllAssets {timelineManager} assetInteraction={assetMultiSelectManager} />
    <ActionButton action={AddToAlbum} />
    <ActionButton action={HideFromPlaces} />
    {#if assetMultiSelectManager.isAllUserOwned}
      <FavoriteAction
        removeFavorite={assetMultiSelectManager.isAllFavorite}
        onFavorite={(ids, isFavorite) => timelineManager.update(ids, (asset) => (asset.isFavorite = isFavorite))}
      />
    {/if}
    <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
      <DownloadAction menuItem />
      <DeleteAssets menuItem onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)} />
    </ButtonContextMenu>
  </AssetSelectControlBar>
{/if}
