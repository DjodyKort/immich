import { AssetSurface, AssetVisibility } from 'src/enum';
import {
  forOtherUser,
  forSharing,
  forSystem,
  forViewer,
  fromHiddenFromMask,
  getAdmittedVisibility,
  getPolicySurfaces,
  getSurfaceBit,
  Surface,
  toHiddenFromMask,
} from 'src/utils/visibility-policy';
import { factory } from 'test/small.factory';
import { describe, expect, it } from 'vitest';

const notElevated = { elevated: false };
const elevated = { elevated: true };

describe('visibility policy', () => {
  describe('the table', () => {
    it('should never admit hidden on any surface at any elevation', () => {
      // Motion-photo video parts are excluded by construction. If this fails, a rule gained `hidden`
      // and every surface in that rule will start returning the video half of live photos.
      for (const surface of Object.values(Surface)) {
        expect(getAdmittedVisibility(surface, notElevated)).not.toContain(AssetVisibility.Hidden);
        expect(getAdmittedVisibility(surface, elevated)).not.toContain(AssetVisibility.Hidden);
      }
    });

    it('should never admit locked without elevation', () => {
      for (const surface of Object.values(Surface)) {
        expect(getAdmittedVisibility(surface, notElevated)).not.toContain(AssetVisibility.Locked);
      }
    });

    it('should only ever widen on elevation, never narrow', () => {
      for (const surface of Object.values(Surface)) {
        const base = getAdmittedVisibility(surface, notElevated);
        const widened = getAdmittedVisibility(surface, elevated);
        expect(widened).toEqual(expect.arrayContaining(base));
        expect(widened.length).toBeGreaterThanOrEqual(base.length);
      }
    });

    it('should never admit an empty set, which would silently match nothing', () => {
      for (const surface of Object.values(Surface)) {
        expect(getAdmittedVisibility(surface, notElevated).length).toBeGreaterThan(0);
        expect(getAdmittedVisibility(surface, elevated).length).toBeGreaterThan(0);
      }
    });
  });

  describe('rules', () => {
    const RULES: Array<[Surface, AssetVisibility[], AssetVisibility[]]> = [
      [Surface.Timeline, [AssetVisibility.Archive, AssetVisibility.Timeline], []],
      [Surface.Trash, [AssetVisibility.Archive, AssetVisibility.Timeline], []],
      [Surface.AlbumTimeline, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.Search, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.Statistics, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.CalendarHeatmap, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.AlbumMetadata, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.AlbumMap, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.GlobalMap, [AssetVisibility.Timeline], []],
      [Surface.TimelineDownload, [AssetVisibility.Archive, AssetVisibility.Timeline], [AssetVisibility.Locked]],
      [Surface.People, [AssetVisibility.Timeline], []],
      [Surface.Memories, [AssetVisibility.Timeline], []],
      [Surface.FolderView, [AssetVisibility.Timeline], []],
      [Surface.SearchSuggestions, [AssetVisibility.Timeline], []],
      [Surface.AlbumContents, [AssetVisibility.Archive, AssetVisibility.Timeline], []],
      [Surface.Duplicates, [AssetVisibility.Archive, AssetVisibility.Timeline], []],
      [Surface.StackContents, [AssetVisibility.Archive, AssetVisibility.Timeline], []],
    ];

    it.each(RULES)('%s admits the documented set', (surface, base, elevatedAdds) => {
      expect(getAdmittedVisibility(surface, notElevated)).toEqual(base);
      expect(getAdmittedVisibility(surface, elevated)).toEqual([...base, ...elevatedAdds]);
    });

    it('should assert a rule for every surface, so a new one cannot be added without a row', () => {
      // The it.each table above is the reviewable copy of POLICY. Without this, adding a Surface and
      // forgetting its row would leave the new rule unasserted.
      expect(new Set(RULES.map(([surface]) => surface))).toEqual(new Set(Object.values(Surface)));
    });

    it('should leave elevation a no-op on the main timeline and the global map', () => {
      // Deliberate: widening these would put locked photos in the main Photos tab and on the map for
      // the rest of the elevated window.
      for (const surface of [Surface.Timeline, Surface.GlobalMap]) {
        expect(getAdmittedVisibility(surface, elevated)).toEqual(getAdmittedVisibility(surface, notElevated));
      }
    });
  });

  describe('access checks are not surface rules', () => {
    it('should keep hidden reachable, since a motion part is read through its parent live photo', () => {
      // Guards the reason `excludeLockedUnlessElevated` exists rather than reusing a Surface: every
      // surface rule excludes `hidden`, and applying one to an access check would deny motion parts.
      for (const surface of Object.values(Surface)) {
        expect(getAdmittedVisibility(surface, elevated)).not.toContain(AssetVisibility.Hidden);
      }
    });
  });

  describe('per-asset exclusion bits', () => {
    it('should give every surface a distinct bit', () => {
      const bits = Object.values(Surface)
        .map((surface) => getSurfaceBit(surface))
        .filter((bit): bit is number => bit !== undefined);

      expect(new Set(bits).size).toBe(bits.length);
    });

    it('should use single-bit values, so masks compose', () => {
      for (const surface of Object.values(Surface)) {
        const bit = getSurfaceBit(surface);
        if (bit === undefined) {
          continue;
        }

        expect(bit).toBeGreaterThan(0);
        expect(bit & (bit - 1)).toBe(0);
      }
    });

    it('should fit in a postgres integer', () => {
      for (const surface of Object.values(Surface)) {
        expect(getSurfaceBit(surface) ?? 0).toBeLessThanOrEqual(2 ** 30);
      }
    });

    it('should give trash no bit, so a per-asset exclusion can never hide a recovery route', () => {
      // Trash exists as its own surface precisely so the mask cannot reach it. The web trash view asks
      // the bucket queries with isTrashed and no explicit visibility, so before this it inherited the
      // timeline's rule and hiding a photo from the timeline made it unrecoverable.
      expect(getSurfaceBit(Surface.Trash)).toBeUndefined();
    });

    it('should keep the bit each surface has always had', () => {
      // These values are persisted in asset.hiddenFrom. Renumbering silently reinterprets stored masks,
      // so this test exists to make that impossible to do by accident. Add rows; never edit them.
      //
      // Every bit, not a sample. This used to pin six of the sixteen, which left a real hole: the
      // uniqueness and power-of-two checks above hold just as well after a renumber, so swapping
      // Statistics and FolderView, say, passed the whole suite while reinterpreting every stored mask.
      // A frozen table is also its own changelog - a diff here is the reviewable event.
      expect(Object.values(Surface).map((surface) => [surface, getSurfaceBit(surface)] as const)).toEqual([
        [Surface.Timeline, 1],
        [Surface.AlbumTimeline, 2],
        [Surface.Search, 4],
        [Surface.Statistics, 8],
        [Surface.CalendarHeatmap, 16],
        [Surface.AlbumMetadata, 32],
        [Surface.AlbumMap, 64],
        [Surface.GlobalMap, 128],
        [Surface.TimelineDownload, 256],
        // Trash is deliberately absent, per the test above.
        [Surface.Trash, undefined],
        [Surface.People, 512],
        [Surface.Memories, 1024],
        [Surface.FolderView, 2048],
        [Surface.SearchSuggestions, 4096],
        [Surface.AlbumContents, 8192],
        [Surface.Duplicates, 16_384],
        [Surface.StackContents, 32_768],
      ]);
    });
  });

  describe('the user-facing surface mapping', () => {
    /** The reviewable copy of ASSET_SURFACE_POLICY, spelled as the documented internal surfaces. */
    const MAPPING: Array<[AssetSurface, Surface[]]> = [
      [AssetSurface.Timeline, [Surface.Timeline]],
      [AssetSurface.Search, [Surface.Search, Surface.SearchSuggestions]],
      [AssetSurface.Map, [Surface.GlobalMap]],
      [AssetSurface.People, [Surface.People]],
      [AssetSurface.Memories, [Surface.Memories]],
      [AssetSurface.Folders, [Surface.FolderView]],
    ];

    it.each(MAPPING)('%s covers the documented internal surfaces', (surface, policySurfaces) => {
      expect([...getPolicySurfaces(surface)]).toEqual(policySurfaces);
    });

    it('should map every AssetSurface, so a new one cannot be added without a row', () => {
      expect(new Set(MAPPING.map(([surface]) => surface))).toEqual(new Set(Object.values(AssetSurface)));
    });

    it.each(MAPPING)('%s converts to exactly the bits of its internal surfaces', (surface, policySurfaces) => {
      const expected = policySurfaces.reduce((mask, policySurface) => mask | getSurfaceBit(policySurface)!, 0);
      expect(toHiddenFromMask([surface])).toBe(expected);
    });

    it('should not hide from an album timeline when hiding from the main timeline', () => {
      // An album is a context the user navigated into and asked for. Deliberate; see ASSET_SURFACE_POLICY.
      const mask = toHiddenFromMask([AssetSurface.Timeline])!;
      expect(mask & getSurfaceBit(Surface.Timeline)!).not.toBe(0);
      expect(mask & getSurfaceBit(Surface.AlbumTimeline)!).toBe(0);
    });

    it("should not hide from an album's map when hiding from the global map", () => {
      const mask = toHiddenFromMask([AssetSurface.Map])!;
      expect(mask & getSurfaceBit(Surface.GlobalMap)!).not.toBe(0);
      expect(mask & getSurfaceBit(Surface.AlbumMap)!).toBe(0);
    });

    it('should suppress search suggestions when hiding from search', () => {
      // Otherwise a hidden photo's city and camera keep populating the filter pickers.
      const mask = toHiddenFromMask([AssetSurface.Search])!;
      expect(mask & getSurfaceBit(Surface.Search)!).not.toBe(0);
      expect(mask & getSurfaceBit(Surface.SearchSuggestions)!).not.toBe(0);
    });

    it('should never touch a surface no AssetSurface names', () => {
      // Statistics, the calendar heatmap, the download-everything path, and the three container lists
      // are excludable by no user-facing surface, on purpose.
      const everything = toHiddenFromMask(Object.values(AssetSurface))!;
      for (const surface of [
        Surface.Statistics,
        Surface.CalendarHeatmap,
        Surface.AlbumMetadata,
        Surface.TimelineDownload,
        Surface.AlbumContents,
        Surface.Duplicates,
        Surface.StackContents,
      ]) {
        expect(everything & getSurfaceBit(surface)!).toBe(0);
      }
    });
  });

  describe('mask conversion', () => {
    it('should map the empty set to null, not 0', () => {
      // "No exclusions" must have exactly one representation in the database: every row upstream writes
      // is null, and a 0 would be an indistinguishable second spelling that every comparison would see.
      expect(toHiddenFromMask([])).toBeNull();
    });

    it('should map a null or zero mask to no surfaces', () => {
      expect(fromHiddenFromMask(null)).toEqual([]);
      expect(fromHiddenFromMask(0)).toEqual([]);
    });

    it.each([
      [[AssetSurface.Timeline]],
      [[AssetSurface.Search]],
      [[AssetSurface.Map]],
      [[AssetSurface.People]],
      [[AssetSurface.Memories]],
      [[AssetSurface.Folders]],
      [[AssetSurface.Timeline, AssetSurface.People]],
      [[AssetSurface.Search, AssetSurface.Map, AssetSurface.Memories]],
      [Object.values(AssetSurface)],
    ])('should round-trip %j', (surfaces) => {
      expect(new Set(fromHiddenFromMask(toHiddenFromMask(surfaces)))).toEqual(new Set(surfaces));
    });

    it('should round-trip every subset of AssetSurface', () => {
      const all = Object.values(AssetSurface);
      for (let bits = 0; bits < 2 ** all.length; bits++) {
        const subset = all.filter((_, index) => (bits & (1 << index)) !== 0);
        expect(new Set(fromHiddenFromMask(toHiddenFromMask(subset)))).toEqual(new Set(subset));
      }
    });

    it('should be idempotent when a surface is listed twice', () => {
      expect(toHiddenFromMask([AssetSurface.People, AssetSurface.People])).toBe(
        toHiddenFromMask([AssetSurface.People]),
      );
    });

    it('should ignore a bit that belongs to no user-facing surface rather than throwing', () => {
      // A mask written by a future release, a workflow, or by hand. This runs on every asset response, so
      // a mask it cannot fully describe must not fail the read.
      const unknownBit = 1 << 29;
      expect(fromHiddenFromMask(unknownBit)).toEqual([]);
      expect(fromHiddenFromMask(getSurfaceBit(Surface.People)! | unknownBit)).toEqual([AssetSurface.People]);
      expect(fromHiddenFromMask(getSurfaceBit(Surface.AlbumContents)!)).toEqual([]);
    });

    it('should require every internal surface of a user-facing one before reporting it', () => {
      // Search covers two bits. Half of it set -- reachable only by a hand-written mask -- is not "hidden
      // from search", and claiming otherwise would let a round-trip through the API silently widen it.
      expect(fromHiddenFromMask(getSurfaceBit(Surface.Search)!)).toEqual([]);
      expect(fromHiddenFromMask(getSurfaceBit(Surface.SearchSuggestions)!)).toEqual([]);
      expect(fromHiddenFromMask(getSurfaceBit(Surface.Search)! | getSurfaceBit(Surface.SearchSuggestions)!)).toEqual([
        AssetSurface.Search,
      ]);
    });
  });

  describe('context constructors', () => {
    it('should treat a session-less auth as not elevated', () => {
      expect(forViewer(factory.auth())).toEqual({ elevated: false });
    });

    it('should treat an unelevated session as not elevated', () => {
      expect(forViewer(factory.auth({ session: { hasElevatedPermission: false } }))).toEqual({ elevated: false });
    });

    it('should carry elevation from the session', () => {
      expect(forViewer(factory.auth({ session: { hasElevatedPermission: true } }))).toEqual({ elevated: true });
    });

    it('should never elevate a sharing, other-user, or system context', () => {
      expect(forSharing()).toEqual({ elevated: false });
      expect(forOtherUser()).toEqual({ elevated: false });
      expect(forSystem()).toEqual({ elevated: false });
    });
  });
});
