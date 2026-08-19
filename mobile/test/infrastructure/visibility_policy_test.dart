import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/asset/base_asset.model.dart';
import 'package:immich_mobile/infrastructure/utils/visibility_policy.dart';

void main() {
  group('hiddenFrom bit assignment', () {
    // These literals are the whole point of the test. The mask is written into
    // remote_asset_entity.hidden_from, so an app update that renumbered a bit would silently
    // reinterpret every row already on the device -- an asset hidden from Search would come back as
    // hidden from the timeline instead. Spelling the numbers out here means that change cannot land
    // quietly. They are also deliberately NOT the server's numbers: sync carries surface names, and
    // VisibilityPolicy.maskFor is the only translation between the two vocabularies.
    test('pins each surface to its literal bit', () {
      expect(VisibilityPolicy.surfaceBit, {
        AssetSurface.timeline: 1,
        AssetSurface.search: 2,
        AssetSurface.map: 4,
        AssetSurface.people: 8,
        AssetSurface.memories: 16,
        AssetSurface.folders: 32,
      });
    });

    test('covers every surface, so no surface silently fails to be hidden', () {
      expect(VisibilityPolicy.surfaceBit.keys, containsAll(AssetSurface.values));
    });

    test('assigns a distinct single bit to each surface', () {
      final bits = VisibilityPolicy.surfaceBit.values.toList();
      expect(bits.toSet(), hasLength(bits.length));
      for (final bit in bits) {
        expect(bit & (bit - 1), 0, reason: '$bit is not a single bit');
      }
    });
  });

  group('maskFor', () {
    test('is null for an empty set, so "hidden from nothing" has one spelling', () {
      expect(VisibilityPolicy.maskFor(const []), isNull);
    });

    test('ors the bits of the surfaces given', () {
      expect(VisibilityPolicy.maskFor([AssetSurface.timeline, AssetSurface.memories]), 1 | 16);
    });

    test('is idempotent for a repeated surface', () {
      expect(
        VisibilityPolicy.maskFor([AssetSurface.people, AssetSurface.people]),
        VisibilityPolicy.maskFor([AssetSurface.people]),
      );
    });
  });

  group('namesFor', () {
    test('is the inverse of maskFor', () {
      for (final surfaces in [
        [AssetSurface.timeline],
        [AssetSurface.search],
        [AssetSurface.map],
        [AssetSurface.people],
        [AssetSurface.memories],
        [AssetSurface.folders],
        [AssetSurface.timeline, AssetSurface.people],
        AssetSurface.values,
      ]) {
        expect(VisibilityPolicy.namesFor(VisibilityPolicy.maskFor(surfaces)), unorderedEquals(surfaces));
      }
    });

    test('reports nothing for null or zero', () {
      expect(VisibilityPolicy.namesFor(null), isEmpty);
      expect(VisibilityPolicy.namesFor(0), isEmpty);
    });

    test('ignores a bit it does not know, rather than throwing', () {
      // A newer build of the app writes a bit, the user downgrades. Reading must still work.
      expect(VisibilityPolicy.namesFor(1 | 1 << 20), [AssetSurface.timeline]);
    });
  });
}
