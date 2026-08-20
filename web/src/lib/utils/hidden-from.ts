import { AssetSurface, type AssetBulkUpdateDto } from '@immich/sdk';

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
