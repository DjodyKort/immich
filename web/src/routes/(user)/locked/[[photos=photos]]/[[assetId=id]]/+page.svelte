<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumCardGroup from '$lib/components/album-page/AlbumCardGroup.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import MenuOption from '$lib/components/shared-components/context-menu/MenuOption.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetBulkActions } from '$lib/services/asset.service';
  import { getUserActions } from '$lib/services/user.service';
  import { createAlbum } from '$lib/utils/album-utils';
  import { AssetVisibility } from '@immich/sdk';
  import { mdiDotsVertical, mdiLockPlusOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = { visibility: AssetVisibility.Locked };
  const lockedAlbums = $derived(data.lockedAlbums);

  const handleEscape = () => {
    if (!assetMultiSelectManager.selectionActive) {
      return;
    }

    assetMultiSelectManager.clear();
    return;
  };

  const handleMoveOffLockedFolder = (assetIds: string[]) => {
    assetMultiSelectManager.clear();
    timelineManager.removeAssets(assetIds);
  };

  // Every asset here already has Locked visibility, so the shared AddToAlbum and HideFromPlaces
  // actions (which are selection-aware: AddToAlbum only offers locked albums when the selection
  // is locked) naturally work here too -- no bespoke handling needed.
  const { AddToAlbum, HideFromPlaces } = $derived(getAssetBulkActions($t));

  const { LockSession } = $derived(getUserActions($t));

  const onSessionLocked = async () => {
    await goto(Route.photos());
  };

  // Unlike AddToAlbum (which only ever offers existing albums), this creates a brand new locked
  // album directly from the current selection in one step. The server accepts asset IDs straight
  // in the create call for a locked album, and rejects outright if any of them isn't already
  // locked -- createAlbum() surfaces that as a toast via handleError, so no extra handling is
  // needed here for the rejection case.
  const handleCreateLockedAlbum = async () => {
    const assetIds = assetMultiSelectManager.ownedAssets.map(({ id }) => id);
    if (assetIds.length === 0) {
      return;
    }

    const newAlbum = await createAlbum(undefined, assetIds, true);
    if (newAlbum) {
      assetMultiSelectManager.clear();
      await goto(Route.viewAlbum(newAlbum));
    }
  };
</script>

<OnEvents {onSessionLocked} />

<UserPageLayout
  title={data.meta.title}
  actions={[LockSession]}
  hideNavbar={assetMultiSelectManager.selectionActive}
  scrollbar={false}
>
  <Timeline
    enableRouting={true}
    bind:timelineManager
    {options}
    assetInteraction={assetMultiSelectManager}
    onEscape={handleEscape}
    removeAction={AssetAction.SET_VISIBILITY_TIMELINE}
  >
    {#if lockedAlbums.length > 0}
      <section class="px-2 pt-2 pb-6">
        <h2 class="mb-3 text-lg font-medium text-black dark:text-white">{$t('locked_albums')}</h2>
        <AlbumCardGroup albums={lockedAlbums} showDateRange showItemCount />
      </section>
    {/if}
    {#snippet empty()}
      <EmptyPlaceholder text={$t('no_locked_photos_message')} title={$t('nothing_here_yet')} class="mx-auto mt-10" />
    {/snippet}
  </Timeline>
</UserPageLayout>

<!-- Multi-selection mode app bar -->
{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    <SelectAllAssets withText {timelineManager} assetInteraction={assetMultiSelectManager} />
    <SetVisibilityAction unlock onVisibilitySet={handleMoveOffLockedFolder} />
    <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
      <MenuOption icon={AddToAlbum.icon} text={AddToAlbum.title} onClick={() => AddToAlbum.onAction(AddToAlbum)} />
      <MenuOption icon={mdiLockPlusOutline} text={$t('create_locked_album')} onClick={handleCreateLockedAlbum} />
      <MenuOption
        icon={HideFromPlaces.icon}
        text={HideFromPlaces.title}
        onClick={() => HideFromPlaces.onAction(HideFromPlaces)}
      />
      <DownloadAction menuItem />
      <ChangeDate menuItem />
      <ChangeLocation menuItem />
      <DeleteAssets menuItem force onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)} />
    </ButtonContextMenu>
  </AssetSelectControlBar>
{/if}
