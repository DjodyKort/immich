<script lang="ts">
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { AssetSurface, updateAsset, updateAssets } from '@immich/sdk';
  import { Alert, Button, Field, FormModal, modalManager, Stack, Switch, Text, toastManager } from '@immich/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
    /**
     * The current exclusions, when they are known. Only the single-asset entry points know them: a
     * multi-selection is made of timeline assets, which do not carry `hiddenFrom`, so the modal
     * opens blank there and says so in the copy rather than pretending to show a merged state.
     */
    hiddenFrom?: AssetSurface[];
    /**
     * Whether every asset here has Locked visibility. Only relabels the timeline row: for a locked
     * asset that switch governs the locked folder, not the main timeline, because the locked folder is
     * the timeline with visibility pinned to locked. The other five rows keep their copy -- a locked
     * asset is off those places already, so switching them changes nothing today and stays correct if
     * its visibility later changes.
     */
    locked?: boolean;
  }

  let { onClose, assetIds, hiddenFrom = [], locked = false }: Props = $props();

  // Ordered the way a person meets these places in the app, not the way the enum is declared.
  const surfaces = [
    AssetSurface.Timeline,
    AssetSurface.Search,
    AssetSurface.Map,
    AssetSurface.People,
    AssetSurface.Memories,
    AssetSurface.Folders,
  ];

  let selected = $state<Record<string, boolean>>(
    Object.fromEntries(surfaces.map((surface) => [surface, hiddenFrom.includes(surface)])),
  );

  const options = $derived([
    {
      surface: AssetSurface.Timeline,
      label: locked ? $t('hide_from_place_locked_folder') : $t('hide_from_place_timeline'),
      description: locked
        ? $t('hide_from_place_locked_folder_description')
        : $t('hide_from_place_timeline_description'),
    },
    {
      surface: AssetSurface.Search,
      label: $t('hide_from_place_search'),
      description: $t('hide_from_place_search_description'),
    },
    { surface: AssetSurface.Map, label: $t('hide_from_place_map'), description: $t('hide_from_place_map_description') },
    {
      surface: AssetSurface.People,
      label: $t('hide_from_place_people'),
      description: $t('hide_from_place_people_description'),
    },
    {
      surface: AssetSurface.Memories,
      label: $t('hide_from_place_memories'),
      description: $t('hide_from_place_memories_description'),
    },
    {
      surface: AssetSurface.Folders,
      label: $t('hide_from_place_folders'),
      description: $t('hide_from_place_folders_description'),
    },
  ]);

  const anySelected = $derived(surfaces.some((surface) => selected[surface]));

  const clearAll = () => {
    for (const surface of surfaces) {
      selected[surface] = false;
    }
  };

  const onSubmit = async () => {
    // The API replaces the whole set, so an empty array is how "show everywhere again" is expressed.
    const nextHiddenFrom = surfaces.filter((surface) => selected[surface]);

    // Hiding from all six surfaces is allowed -- it's not a one-way door, the Hidden view exists
    // precisely so this stays findable -- but it's easy to flip every switch without meaning to,
    // so it gets a confirmation rather than silent application.
    if (nextHiddenFrom.length === surfaces.length) {
      const confirmed = await modalManager.showDialog({
        title: $t('hide_from_places_all_confirm_title'),
        prompt: $t('hide_from_places_all_confirm_prompt', { values: { count: assetIds.length } }),
        confirmText: $t('hide_from_places_all_confirm_action'),
      });

      if (!confirmed) {
        return;
      }
    }

    try {
      if (assetIds.length === 1) {
        const response = await updateAsset({ id: assetIds[0], updateAssetDto: { hiddenFrom: nextHiddenFrom } });
        // Refreshes the open viewer and its detail panel with the value the server actually stored.
        eventManager.emit('AssetUpdate', response);
      } else {
        await updateAssets({ assetBulkUpdateDto: { ids: assetIds, hiddenFrom: nextHiddenFrom } });
      }

      // Emitted after AssetUpdate on purpose: that event upserts into the timeline, and a page whose
      // own surface is now excluded has to get the last word and drop the asset.
      eventManager.emit('AssetsHiddenFrom', { assetIds, hiddenFrom: nextHiddenFrom });
      toastManager.primary($t('hide_from_places_updated', { values: { count: assetIds.length } }));
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    }
  };
</script>

<FormModal size="small" title={$t('hide_from_places')} icon={mdiEyeOffOutline} {onClose} {onSubmit}>
  <Stack gap={4} class="my-4">
    <Text size="small" color="muted">{$t('hide_from_places_help')}</Text>

    {#if assetIds.length > 1}
      <Alert color="warning" size="small">
        {$t('hide_from_places_bulk_help', { values: { count: assetIds.length } })}
      </Alert>
    {/if}

    {#each options as option (option.surface)}
      <Field label={option.label} description={option.description}>
        <Switch bind:checked={selected[option.surface]} />
      </Field>
    {/each}

    <div class="flex justify-start">
      <Button color="primary" size="small" variant="ghost" disabled={!anySelected} onclick={clearAll}>
        {$t('hide_from_places_clear')}
      </Button>
    </div>
  </Stack>
</FormModal>
