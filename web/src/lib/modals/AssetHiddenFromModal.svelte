<script lang="ts">
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    hideFromPlaceLabels,
    hideFromPlaces,
    toHiddenFromAdjustment,
    type HideFromIntent,
  } from '$lib/utils/hidden-from';
  import { AssetSurface, updateAsset, updateAssets } from '@immich/sdk';
  import { Alert, Button, Field, FormModal, modalManager, Select, Stack, Switch, Text, toastManager } from '@immich/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    onClose: (updated?: boolean) => void;
    assetIds: string[];
    /**
     * The current exclusions, when they are known. Only the single-asset entry points know them: a
     * multi-selection is made of timeline assets, which do not carry `hiddenFrom`, so the modal
     * cannot prefill there. That is why a selection is edited per place rather than as a set -- see
     * the `bulk` comment below.
     */
    hiddenFrom?: AssetSurface[];
    /**
     * What the asset's albums withhold it from, and what it already overrides. Single-asset only, same
     * reason as `hiddenFrom`.
     *
     * These turn the timeline row from a two-state switch into a real three-state choice for a photo in
     * a rule-bearing album: leave the album's rule alone, hide it here as well, or show it here despite
     * the album. Without them the switch would appear off while the photo was in fact hidden, and
     * turning it on and off again would look like a no-op.
     */
    hiddenFromInherited?: AssetSurface[];
    hiddenFromShown?: AssetSurface[];
    /**
     * Whether every asset here has Locked visibility. Only relabels the timeline row: for a locked
     * asset that switch governs the locked folder, not the main timeline, because the locked folder is
     * the timeline with visibility pinned to locked. The other five rows keep their copy -- a locked
     * asset is off those places already, so switching them changes nothing today and stays correct if
     * its visibility later changes.
     */
    locked?: boolean;
  }

  let {
    onClose,
    assetIds,
    hiddenFrom = [],
    hiddenFromInherited = [],
    hiddenFromShown = [],
    locked = false,
  }: Props = $props();

  /**
   * A selection is edited as a set of per-place *intentions*, not as a set of places.
   *
   * The modal cannot know what a multi-selection is currently hidden from, and the assets in it need
   * not agree. Sending a complete `hiddenFrom` set would therefore flatten them all to whatever this
   * modal happens to show, silently discarding exclusions the user never saw. Instead each place is
   * left alone unless it is explicitly set, and the server applies the difference with
   * `hiddenFromAdd`/`hiddenFromRemove` -- one bitwise update per place, leaving every other bit of
   * every asset untouched.
   */
  const bulk = $derived(assetIds.length > 1);

  // The places list and the intent-to-payload rule both live in $lib/utils/hidden-from, so that rule can
  // be unit-tested directly rather than by driving a headless Select in jsdom. Its spec is what pins the
  // guarantee that only the places actually set are ever sent.
  const surfaces = hideFromPlaces;

  /** Which places an album withholds this photo from. Drives the extra copy on those rows. */
  const inherited = new Set(hiddenFromInherited);

  /**
   * The switches show the **effective** state, not just the asset's own setting.
   *
   * For a photo in an album with a rule, "hide from the timeline as well" and "follow the album" are the
   * same outcome, so a three-way control would offer two options that do the same thing. One switch
   * meaning "hidden here" is the honest control; which column expresses it is this modal's problem, not
   * the user's. Reading the effective state is also what stops the switch from sitting in the off
   * position while the photo is in fact hidden.
   */
  let selected = $state<Record<string, boolean>>(
    Object.fromEntries(
      surfaces.map((surface) => [
        surface,
        hiddenFrom.includes(surface) || (inherited.has(surface) && !hiddenFromShown.includes(surface)),
      ]),
    ),
  );

  let intents = $state<Record<string, HideFromIntent>>(
    Object.fromEntries(surfaces.map((surface) => [surface, 'unchanged'])),
  );

  // The six label/description pairs live in $lib/utils/hidden-from, shared with album settings.
  const labels = $derived(hideFromPlaceLabels($t, { locked }));

  const intentOptions = $derived([
    { label: $t('hide_from_places_bulk_unchanged'), value: 'unchanged' },
    { label: $t('hide_from_places_bulk_hide'), value: 'hide' },
    { label: $t('hide_from_places_bulk_show'), value: 'show' },
  ]);

  const toHide = $derived(surfaces.filter((surface) => intents[surface] === 'hide'));
  /** The adjusting half of the bulk payload, or `undefined` when nothing was set. */
  const adjustment = $derived(toHiddenFromAdjustment(intents));

  const anySelected = $derived(surfaces.some((surface) => selected[surface]));
  const anyIntent = $derived(adjustment !== undefined);

  // Nothing to send is not an error, but submitting would emit a "0 updated" toast and refresh pages
  // for no reason, so the button is simply inert until there is something to apply.
  const submitDisabled = $derived(bulk && !anyIntent);

  const resetAll = () => {
    if (bulk) {
      for (const surface of surfaces) {
        intents[surface] = 'unchanged';
      }
      return;
    }
    for (const surface of surfaces) {
      selected[surface] = false;
    }
  };

  const onSubmit = async () => {
    if (bulk && !anyIntent) {
      return;
    }

    // Hiding from all six surfaces is allowed -- it's not a one-way door, the Hidden view exists
    // precisely so this stays findable -- but it's easy to set every place without meaning to, so it
    // gets a confirmation rather than silent application. In bulk that means every place set to
    // "hide"; nothing about the assets' prior state can turn a partial edit into this.
    const hidingEverywhere = bulk ? toHide.length === surfaces.length : surfaces.every((surface) => selected[surface]);

    if (hidingEverywhere) {
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
      if (bulk) {
        await updateAssets({ assetBulkUpdateDto: { ids: assetIds, ...adjustment } });
        // Only the places actually set are announced. A page whose surface was left unchanged must
        // not drop its assets, and one whose surface was set to "show" must not either.
        eventManager.emit('AssetsHiddenFrom', { assetIds, hiddenFrom: toHide });
      } else {
        // The API replaces both sets here, so this sends the minimal representation of what the
        // switches now say. A place the album already withholds
        // needs no own bit, and a place turned off that the album withholds needs an override -- so each
        // place ends up in exactly one of the two columns, or neither. Writing it this way means
        // reopening the modal shows the same switches back.
        const nextHiddenFrom = surfaces.filter((surface) => selected[surface] && !inherited.has(surface));
        const nextShown = surfaces.filter((surface) => !selected[surface] && inherited.has(surface));
        const response = await updateAsset({
          id: assetIds[0],
          updateAssetDto: { hiddenFrom: nextHiddenFrom, hiddenFromShown: nextShown },
        });
        // Refreshes the open viewer and its detail panel with the value the server actually stored.
        eventManager.emit('AssetUpdate', response);
        // Emitted after AssetUpdate on purpose: that event upserts into the timeline, and a page whose
        // own surface is now excluded has to get the last word and drop the asset.
        eventManager.emit('AssetsHiddenFrom', { assetIds, hiddenFrom: nextHiddenFrom });
      }

      toastManager.primary($t('hide_from_places_updated', { values: { count: assetIds.length } }));
      onClose(true);
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_settings'));
    }
  };
</script>

<FormModal
  size="small"
  title={$t('hide_from_places')}
  icon={mdiEyeOffOutline}
  {onClose}
  {onSubmit}
  disabled={submitDisabled}
>
  <Stack gap={4} class="my-4">
    <Text size="small" color="muted">{$t('hide_from_places_help')}</Text>

    {#if bulk}
      <Alert color="info" size="small">
        {$t('hide_from_places_bulk_help', { values: { count: assetIds.length } })}
      </Alert>
    {/if}

    {#each surfaces as surface (surface)}
      {@const copy = labels.get(surface)!}
      <!--
        A row the album withholds says so, because otherwise a switch that is on for a reason the user
        did not set here looks like their own setting - and turning it off is an override rather than a
        plain un-hide, which is worth knowing before doing it.
      -->
      <Field
        label={copy.label}
        description={inherited.has(surface)
          ? `${copy.description} ${$t('album_hidden_from_inherited_note')}`
          : copy.description}
      >
        {#if bulk}
          <Select
            value={intents[surface]}
            options={intentOptions}
            onChange={(value) => (intents[surface] = value as HideFromIntent)}
          />
        {:else}
          <Switch bind:checked={selected[surface]} />
        {/if}
      </Field>
    {/each}

    <div class="flex justify-start">
      <Button
        color="primary"
        size="small"
        variant="ghost"
        disabled={bulk ? !anyIntent : !anySelected}
        onclick={resetAll}
      >
        {bulk ? $t('hide_from_places_bulk_reset') : $t('hide_from_places_clear')}
      </Button>
    </div>
  </Stack>
</FormModal>
