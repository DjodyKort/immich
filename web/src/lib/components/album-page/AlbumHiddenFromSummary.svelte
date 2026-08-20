<!--
  States the album's rule once, in the album header.

  This is the load-bearing half of the indication design. Inside an album that hides everything, badging
  all forty thumbnails carries no information - every one is the same - so the rule is stated here and the
  grid stays clean, with glyphs reserved for photos that *deviate* from it. That mirrors the convention
  `showArchiveIcon` already follows: mark the state where it is surprising, stay silent where it is the
  norm.
-->
<script lang="ts">
  import { hideFromPlaceLabels, hideFromPlaces } from '$lib/utils/hidden-from';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon, Text } from '@immich/ui';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    album: AlbumResponseDto;
  }

  let { album }: Props = $props();

  const labels = $derived(hideFromPlaceLabels($t, { locked: album.isLocked }));

  // Ordered by the shared list rather than by whatever order the server returned, so the sentence reads
  // the same way every time.
  const places = $derived(
    hideFromPlaces
      .filter((place) => album.hiddenFrom.includes(place))
      .map((place) => labels.get(place)?.label ?? place),
  );
</script>

{#if places.length > 0}
  <div
    class="my-2 flex w-fit items-center gap-2 rounded-lg bg-subtle px-3 py-1.5 text-sm"
    data-testid="album-hidden-from-summary"
  >
    <Icon icon={mdiEyeOffOutline} size="16" class="shrink-0 text-gray-500 dark:text-gray-400" />
    <Text size="small" color="muted">
      {$t('album_hidden_from_summary', { values: { places: places.join(', ') } })}
    </Text>
  </div>
{/if}
