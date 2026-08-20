<!--
  The album's own per-surface rule, as six switches in album settings.

  Sits next to "Hide album" and "Lock album" because it is the third member of that family and the one
  that was missing: `isHidden` hides the album from the album list and touches no photo, `isLocked` moves
  the album and its photos behind the PIN, and this leaves the album exactly where it is and takes its
  photos off the surfaces named here. The copy has to keep the first two apart from this one, since
  "hide album" and "hide the album's photos" are easy to conflate and do entirely different things.

  Writes go to `PUT /albums/:id/hidden-from` one switch at a time rather than being batched behind a save
  button, matching every other row in this modal. The route replaces the whole set, so each call sends the
  full list.
-->
<script lang="ts">
  import { hideFromPlaceLabels, hideFromPlaces } from '$lib/utils/hidden-from';
  import { handleError } from '$lib/utils/handle-error';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { AssetSurface, setAlbumHiddenFrom, type AlbumResponseDto } from '@immich/sdk';
  import { Field, Stack, Switch, Text, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  interface Props {
    album: AlbumResponseDto;
    /** Non-owners see the state but cannot change it; the server refuses them anyway. */
    readOnly?: boolean;
  }

  let { album, readOnly = false }: Props = $props();

  const labels = $derived(hideFromPlaceLabels($t, { locked: album.isLocked }));

  // Derived from the album rather than held as local state, so an update from elsewhere (this modal is
  // reachable while the album page is open behind it) is reflected instead of being overwritten by a
  // stale snapshot on the next toggle.
  const hidden = $derived(new Set(album.hiddenFrom));

  const handleToggle = async (surface: AssetSurface, checked: boolean) => {
    const next = new Set(hidden);
    if (checked) {
      next.add(surface);
    } else {
      next.delete(surface);
    }

    try {
      const response = await setAlbumHiddenFrom({
        id: album.id,
        albumSetHiddenFromDto: { hiddenFrom: hideFromPlaces.filter((place) => next.has(place)) },
      });
      // Same event the other rows emit, so the album page and the album lists behind this modal pick the
      // new rule up without a reload.
      eventManager.emit('AlbumUpdate', response);
      toastManager.primary($t('album_hidden_from_saved'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_save_album'));
    }
  };
</script>

<Stack gap={2}>
  <div>
    <Text size="medium" fontWeight="medium">{$t('album_hidden_from')}</Text>
    <Text size="small" color="muted">
      {readOnly ? $t('album_hidden_from_owner_only') : $t('album_hidden_from_description')}
    </Text>
  </div>

  {#each hideFromPlaces as surface (surface)}
    <Field
      label={labels.get(surface)?.label ?? surface}
      description={labels.get(surface)?.description}
      disabled={readOnly}
    >
      <Switch
        checked={hidden.has(surface)}
        onCheckedChange={(checked) => handleToggle(surface, checked)}
        disabled={readOnly}
      />
    </Field>
  {/each}

  {#if hidden.size === 0}
    <Text size="small" color="muted">{$t('album_hidden_from_none')}</Text>
  {/if}
</Stack>
