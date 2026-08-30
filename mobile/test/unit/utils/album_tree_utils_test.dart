import 'package:flutter_test/flutter_test.dart';
import 'package:immich_mobile/domain/models/album/album.model.dart';
import 'package:immich_mobile/utils/album_tree.utils.dart';

import '../factories/remote_album_factory.dart';

void main() {
  const me = 'me';

  RemoteAlbum album(String id, {String? parentId, bool isLocked = false, String owner = me}) =>
      RemoteAlbumFactory.create(id: id, name: id, parentId: parentId, isLocked: isLocked, ownerId: owner);

  List<String> collect(List<AlbumTreeNode> nodes) => [
    for (final node in nodes) ...[node.album.id, ...collect(node.children)],
  ];

  group('buildAlbumTree', () {
    test('nests children under their parent', () {
      final tree = buildAlbumTree([album('parent'), album('child', parentId: 'parent')]);

      expect(tree.map((n) => n.album.id), ['parent']);
      expect(tree.first.children.map((n) => n.album.id), ['child']);
      expect(tree.first.depth, 0);
      expect(tree.first.children.first.depth, 1);
    });

    /// The rule that matters. Sync can deliver a child before its parent, and the list is already
    /// filtered by what the viewer may see -- so a missing parent is normal, and dropping the child
    /// would make an album disappear from its owner's own list.
    test('promotes a child whose parent is not in the list', () {
      final tree = buildAlbumTree([album('orphan', parentId: 'not-synced-yet')]);

      expect(tree.map((n) => n.album.id), ['orphan']);
      expect(tree.first.depth, 0);
    });

    test('keeps every album, whatever the shape', () {
      final albums = [
        album('a'),
        album('b', parentId: 'a'),
        album('c', parentId: 'b'),
        album('d', parentId: 'missing'),
        album('e'),
      ];

      expect(collect(buildAlbumTree(albums))..sort(), ['a', 'b', 'c', 'd', 'e']);
    });

    /// Unreachable through the API -- the server refuses cycles -- but a corrupt or half-synced row
    /// must not produce a structure that loops in the first widget to walk it.
    test('does not loop on a cycle, and still shows both albums', () {
      expect(collect(buildAlbumTree([album('x', parentId: 'y'), album('y', parentId: 'x')]))..sort(), ['x', 'y']);
    });

    test('ignores an album that is its own parent', () {
      expect(collect(buildAlbumTree([album('self', parentId: 'self')])), ['self']);
    });
  });

  group('albumBreadcrumb', () {
    test('returns the chain from the root down', () {
      final albums = [album('root'), album('mid', parentId: 'root'), album('leaf', parentId: 'mid')];

      expect(albumBreadcrumb(albums, 'leaf').map((a) => a.id), ['root', 'mid', 'leaf']);
    });

    test('stops at the first ancestor the viewer cannot see', () {
      expect(albumBreadcrumb([album('visible', parentId: 'hidden')], 'visible').map((a) => a.id), ['visible']);
    });

    test('is empty for an album that is not in the list', () {
      expect(albumBreadcrumb([album('a')], 'missing'), isEmpty);
    });
  });

  group('flattenAlbumTree', () {
    test('places a parent immediately before its children', () {
      final tree = buildAlbumTree([album('p'), album('c1', parentId: 'p'), album('c2', parentId: 'p'), album('z')]);

      expect(flattenAlbumTree(tree, (_) => true).map((n) => n.album.id), ['p', 'c1', 'c2', 'z']);
    });

    test('omits the children of a collapsed folder', () {
      final tree = buildAlbumTree([album('p'), album('c', parentId: 'p')]);

      expect(flattenAlbumTree(tree, (_) => false).map((n) => n.album.id), ['p']);
    });
  });

  group('albumMoveTargets', () {
    MoveBlocker? blockerOf(List<MoveTarget> targets, String id) => targets.firstWhere((t) => t.album.id == id).blocker;

    test('returns every album, blocked ones included', () {
      final albums = [album('a'), album('b'), album('c', parentId: 'a')];

      expect(albumMoveTargets(albums, albums.first, me).map((t) => t.album.id).toList()..sort(), ['a', 'b', 'c']);
    });

    test('blocks the album itself and its own descendants', () {
      final albums = [
        album('root'),
        album('child', parentId: 'root'),
        album('grandchild', parentId: 'child'),
        album('elsewhere'),
      ];

      final targets = albumMoveTargets(albums, albums.first, me);

      expect(blockerOf(targets, 'root'), MoveBlocker.self);
      expect(blockerOf(targets, 'child'), MoveBlocker.descendant);
      expect(blockerOf(targets, 'grandchild'), MoveBlocker.descendant);
      expect(blockerOf(targets, 'elsewhere'), isNull);
    });

    test('blocks the album it already sits in', () {
      final albums = [album('parent'), album('child', parentId: 'parent')];

      expect(blockerOf(albumMoveTargets(albums, albums[1], me), 'parent'), MoveBlocker.currentParent);
    });

    test("blocks another user's album", () {
      final albums = [album('mine'), album('theirs', owner: 'someone-else')];

      expect(blockerOf(albumMoveTargets(albums, albums.first, me), 'theirs'), MoveBlocker.notOwned);
    });

    /// The asymmetry: locked into normal is fine, normal into locked is not.
    test('blocks a normal album moving into a locked one, but not the reverse', () {
      final normal = album('normal');
      final locked = album('locked', isLocked: true);

      expect(blockerOf(albumMoveTargets([normal, locked], normal, me), 'locked'), MoveBlocker.lockMismatch);
      expect(blockerOf(albumMoveTargets([normal, locked], locked, me), 'normal'), isNull);
    });

    /// Both sides of the boundary, so an off-by-one in either direction fails.
    test("counts the moving album's own subtree towards the depth cap", () {
      final chain = [
        for (var i = 0; i < kAlbumMaxDepth - 1; i++) album('level$i', parentId: i == 0 ? null : 'level${i - 1}'),
      ];
      final mover = album('mover');
      final moverChild = album('moverChild', parentId: 'mover');

      final targets = albumMoveTargets([...chain, mover, moverChild], mover, me);

      expect(blockerOf(targets, 'level${kAlbumMaxDepth - 2}'), MoveBlocker.tooDeep);
      expect(blockerOf(targets, 'level${kAlbumMaxDepth - 3}'), isNull);
    });
  });
}
