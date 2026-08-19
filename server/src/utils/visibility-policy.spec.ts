import { AssetVisibility } from 'src/enum';
import {
  forOtherUser,
  forSharing,
  forSystem,
  forViewer,
  getAdmittedVisibility,
  getSurfaceBit,
  Surface,
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

    it('should keep the bit each surface has always had', () => {
      // These values are persisted in asset.hiddenFrom. Renumbering silently reinterprets stored masks,
      // so this test exists to make that impossible to do by accident. Add rows; never edit them.
      expect(getSurfaceBit(Surface.Timeline)).toBe(1);
      expect(getSurfaceBit(Surface.AlbumTimeline)).toBe(2);
      expect(getSurfaceBit(Surface.Search)).toBe(4);
      expect(getSurfaceBit(Surface.People)).toBe(512);
      expect(getSurfaceBit(Surface.Memories)).toBe(1024);
      expect(getSurfaceBit(Surface.StackContents)).toBe(32_768);
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
