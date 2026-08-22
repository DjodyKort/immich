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
  import { notifyAlbumVisibilityChanged } from '$lib/services/album.service';
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

  // Read straight off the album rather than held as local state, so an update from elsewhere (this modal
  // is reachable while the album page is open behind it) is reflected instead of being overwritten by a
  // stale snapshot on the next toggle. An array rather than a Set: six members make `includes` a
  // non-question, and a Set here would have to be a `SvelteSet` to satisfy `prefer-svelte-reactivity`
  // for no gain.
  const hidden = $derived(album.hiddenFrom);

  const handleToggle = async (surface: AssetSurface, checked: boolean) => {
    // The route replaces the whole set, so send the full list in the shared display order rather than
    // whatever order the server last returned.
    const next = hideFromPlaces.filter((place) => (place === surface ? checked : hidden.includes(place)));

    try {
      const response = await setAlbumHiddenFrom({
        id: album.id,
        albumSetHiddenFromDto: { hiddenFrom: next },
      });
      notifyAlbumVisibilityChanged(response);
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
        checked={hidden.includes(surface)}
        onCheckedChange={(checked) => handleToggle(surface, checked)}
        disabled={readOnly}
      />
    </Field>
  {/each}

  {#if hidden.length === 0}
    <Text size="small" color="muted">{$t('album_hidden_from_none')}</Text>
  {/if}
</Stack>
