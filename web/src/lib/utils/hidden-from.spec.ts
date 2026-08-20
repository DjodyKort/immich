import { AssetSurface } from '@immich/sdk';
import { hideFromPlaces, toHiddenFromAdjustment, type HideFromIntent } from '$lib/utils/hidden-from';

/**
 * The rule that makes a bulk hide-from-places edit safe: only the places actually set are sent, so every
 * other exclusion on every selected asset survives. Getting this wrong is silent -- the request succeeds
 * and quietly clears things nobody was shown.
 */
describe('toHiddenFromAdjustment', () => {
  const intents = (overrides: Partial<Record<AssetSurface, HideFromIntent>> = {}) =>
    Object.fromEntries(hideFromPlaces.map((place) => [place, overrides[place] ?? 'unchanged'])) as Record<
      string,
      HideFromIntent
    >;

  it('sends nothing when every place is left unchanged', () => {
    expect(toHiddenFromAdjustment(intents())).toBeUndefined();
  });

  it('sends only the places set to hide', () => {
    expect(toHiddenFromAdjustment(intents({ [AssetSurface.Search]: 'hide' }))).toEqual({
      hiddenFromAdd: [AssetSurface.Search],
    });
  });

  it('sends only the places set to show', () => {
    expect(toHiddenFromAdjustment(intents({ [AssetSurface.Map]: 'show' }))).toEqual({
      hiddenFromRemove: [AssetSurface.Map],
    });
  });

  it('sends an add and a remove together, omitting the untouched places', () => {
    const result = toHiddenFromAdjustment(intents({ [AssetSurface.Search]: 'hide', [AssetSurface.Map]: 'show' }));

    expect(result).toEqual({ hiddenFromAdd: [AssetSurface.Search], hiddenFromRemove: [AssetSurface.Map] });
    // Timeline appears in neither, which is what leaves each asset's existing timeline exclusion alone.
    expect(result?.hiddenFromAdd).not.toContain(AssetSurface.Timeline);
    expect(result?.hiddenFromRemove).not.toContain(AssetSurface.Timeline);
  });

  // `hiddenFrom` replaces the whole set and the server rejects it alongside either adjusting field, so it
  // must never appear here however the intents are arranged.
  it('never emits the replacing field', () => {
    const every = toHiddenFromAdjustment(
      intents(Object.fromEntries(hideFromPlaces.map((place) => [place, 'hide' as const]))),
    );

    expect(every).not.toHaveProperty('hiddenFrom');
    expect(every?.hiddenFromAdd).toEqual([...hideFromPlaces]);
  });

  it('keeps the places in the order a person meets them, not enum order', () => {
    const result = toHiddenFromAdjustment(intents({ [AssetSurface.Folders]: 'hide', [AssetSurface.Timeline]: 'hide' }));

    expect(result?.hiddenFromAdd).toEqual([AssetSurface.Timeline, AssetSurface.Folders]);
  });
});

/**
 * The single-asset write rule, extracted here because the modal computes it inline and the interesting
 * part is the arithmetic, not the clicking. Mirrors `AssetHiddenFromModal`'s submit branch exactly.
 */
const toSingleAssetWrite = (selected: Record<string, boolean>, inherited: AssetSurface[]) => {
  const has = new Set(inherited);
  return {
    hiddenFrom: hideFromPlaces.filter((place) => selected[place] && !has.has(place)),
    hiddenFromShown: hideFromPlaces.filter((place) => !selected[place] && has.has(place)),
  };
};

describe('single-asset hidden-from write', () => {
  const none = Object.fromEntries(hideFromPlaces.map((place) => [place, false]));

  it('stores an own bit when nothing inherits it', () => {
    expect(toSingleAssetWrite({ ...none, [AssetSurface.Timeline]: true }, [])).toEqual({
      hiddenFrom: [AssetSurface.Timeline],
      hiddenFromShown: [],
    });
  });

  // The album already withholds it, so an own bit would be redundant state that has to be kept in step
  // with the album's rule forever.
  it('stores nothing when the album already withholds it', () => {
    expect(toSingleAssetWrite({ ...none, [AssetSurface.Timeline]: true }, [AssetSurface.Timeline])).toEqual({
      hiddenFrom: [],
      hiddenFromShown: [],
    });
  });

  it('records an override when a place the album withholds is turned off', () => {
    expect(toSingleAssetWrite(none, [AssetSurface.Timeline])).toEqual({
      hiddenFrom: [],
      hiddenFromShown: [AssetSurface.Timeline],
    });
  });

  // The round trip that matters: what this writes has to read back as the same switches, or toggling a
  // place twice would not return to where it started.
  it('round-trips: the write reproduces the switches it came from', () => {
    const inherited = [AssetSurface.Timeline, AssetSurface.Search];
    const selected = { ...none, [AssetSurface.Timeline]: true, [AssetSurface.Map]: true };

    const written = toSingleAssetWrite(selected, inherited);
    const readBack = Object.fromEntries(
      hideFromPlaces.map((place) => [
        place,
        written.hiddenFrom.includes(place) || (inherited.includes(place) && !written.hiddenFromShown.includes(place)),
      ]),
    );

    expect(readBack).toEqual(selected);
  });
});
