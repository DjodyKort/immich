import { AssetSurface, type AssetBulkUpdateDto } from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

/**
 * The six places an asset can be withheld from, in the order a person meets them in the app rather than
 * the order the enum happens to declare.
 */
export const hideFromPlaces = [
  AssetSurface.Timeline,
  AssetSurface.Search,
  AssetSurface.Map,
  AssetSurface.People,
  AssetSurface.Memories,
  AssetSurface.Folders,
] as const;

/**
 * The label and description for each place.
 *
 * Extracted from `AssetHiddenFromModal` once album settings needed the same six pairs. Takes the
 * translator rather than importing it so this file stays free of Svelte context, and `locked` because the
 * timeline row is called "Locked folder" for an asset that lives there - the surface is the same, the name
 * a person knows it by is not.
 */
export const hideFromPlaceLabels = (
  $t: MessageFormatter,
  { locked = false }: { locked?: boolean } = {},
): Map<AssetSurface, { label: string; description: string }> =>
  new Map([
    [
      AssetSurface.Timeline,
      {
        label: locked ? $t('hide_from_place_locked_folder') : $t('hide_from_place_timeline'),
        description: locked
          ? $t('hide_from_place_locked_folder_description')
          : $t('hide_from_place_timeline_description'),
      },
    ],
    [
      AssetSurface.Search,
      { label: $t('hide_from_place_search'), description: $t('hide_from_place_search_description') },
    ],
    [AssetSurface.Map, { label: $t('hide_from_place_map'), description: $t('hide_from_place_map_description') }],
    [
      AssetSurface.People,
      { label: $t('hide_from_place_people'), description: $t('hide_from_place_people_description') },
    ],
    [
      AssetSurface.Memories,
      { label: $t('hide_from_place_memories'), description: $t('hide_from_place_memories_description') },
    ],
    [
      AssetSurface.Folders,
      { label: $t('hide_from_place_folders'), description: $t('hide_from_place_folders_description') },
    ],
  ]);

/**
 * What a person asked to change about one place, for a selection.
 *
 * `unchanged` is the default and the reason a bulk edit is safe: the modal cannot know what a
 * multi-selection is currently hidden from, and the assets in it need not agree, so any place left alone
 * has to stay alone rather than being flattened to whatever the modal happens to show.
 */
export type HideFromIntent = 'unchanged' | 'hide' | 'show';

/**
 * Turns per-place intents into the adjusting half of an `AssetBulkUpdateDto`.
 *
 * Lives here rather than inside the modal so the rule can be tested directly: the modal's own controls are
 * a headless `Select` that is awkward to drive in jsdom, and the thing worth pinning is this mapping, not
 * the clicking. Deliberately omits `hiddenFrom` -- that field *replaces* the whole set, and the server
 * rejects it alongside either adjusting field.
 *
 * Returns `undefined` when nothing was set, which callers should treat as "do not send a request": an
 * empty add and an empty remove is a no-op the server short-circuits, but issuing it would still emit a
 * success toast and refresh pages for a change that did not happen.
 */
export const toHiddenFromAdjustment = (
  intents: Record<string, HideFromIntent>,
): Pick<AssetBulkUpdateDto, 'hiddenFromAdd' | 'hiddenFromRemove'> | undefined => {
  const hiddenFromAdd = hideFromPlaces.filter((place) => intents[place] === 'hide');
  const hiddenFromRemove = hideFromPlaces.filter((place) => intents[place] === 'show');

  if (hiddenFromAdd.length === 0 && hiddenFromRemove.length === 0) {
    return undefined;
  }

  return {
    ...(hiddenFromAdd.length > 0 && { hiddenFromAdd }),
    ...(hiddenFromRemove.length > 0 && { hiddenFromRemove }),
  };
};
