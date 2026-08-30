import 'package:immich_mobile/domain/models/album/album.model.dart';

/// Why an album cannot receive a move.
enum MoveBlocker { self, descendant, currentParent, lockMismatch, notOwned, tooDeep }

/// Mirrors `ALBUM_MAX_DEPTH` in `server/src/utils/album.util.ts`.
const int kAlbumMaxDepth = 10;

class AlbumTreeNode {
  final RemoteAlbum album;
  final List<AlbumTreeNode> children;

  /// 0 for a root. Drives indentation and the breadcrumb.
  final int depth;

  const AlbumTreeNode({required this.album, required this.children, required this.depth});
}

class MoveTarget {
  final RemoteAlbum album;
  final int depth;

  /// Null when the move is allowed.
  final MoveBlocker? blocker;

  const MoveTarget({required this.album, required this.depth, this.blocker});

  bool get isAllowed => blocker == null;
}

/// Arrange a flat album list into the tree its [RemoteAlbum.parentId]s describe.
///
/// The list this receives is already filtered by what the viewer may see -- a locked album is absent
/// until the session is elevated, and one shared with someone else never appears -- and sync can
/// deliver a child before its parent. So a child whose parent is missing is normal rather than
/// exceptional, and it is **promoted to a root** instead of being dropped. Dropping it would make an
/// album the user owns vanish from their own list because of something about its parent.
///
/// Back-edges are pruned while walking, so the result is acyclic by construction. The server refuses
/// to create a cycle, but a corrupt or half-synced row must not leave a structure that loops in the
/// first widget to walk it.
List<AlbumTreeNode> buildAlbumTree(List<RemoteAlbum> albums) {
  final childrenOf = <String, List<RemoteAlbum>>{};
  final byId = {for (final album in albums) album.id: album};

  final roots = <RemoteAlbum>[];
  for (final album in albums) {
    final parentId = album.parentId;
    if (parentId != null && parentId != album.id && byId.containsKey(parentId)) {
      childrenOf.putIfAbsent(parentId, () => []).add(album);
    } else {
      roots.add(album);
    }
  }

  final placed = <String>{};

  List<AlbumTreeNode> build(List<RemoteAlbum> level, int depth) {
    final nodes = <AlbumTreeNode>[];
    for (final album in level) {
      if (!placed.add(album.id)) {
        continue;
      }
      nodes.add(
        AlbumTreeNode(album: album, children: build(childrenOf[album.id] ?? const [], depth + 1), depth: depth),
      );
    }
    return nodes;
  }

  final tree = build(roots, 0);

  // Anything unreachable from a root can only be part of a cycle. Promote it so it stays findable.
  for (final album in albums) {
    if (!placed.contains(album.id)) {
      tree.addAll(build([album], 0));
    }
  }

  return tree;
}

/// The chain from the root down to [albumId], inclusive.
///
/// Stops at the first ancestor absent from [albums] rather than inventing a link to an album the
/// viewer cannot open.
List<RemoteAlbum> albumBreadcrumb(List<RemoteAlbum> albums, String albumId) {
  final byId = {for (final album in albums) album.id: album};
  final chain = <RemoteAlbum>[];
  final seen = <String>{};

  var current = byId[albumId];
  while (current != null && seen.add(current.id)) {
    chain.insert(0, current);
    final parentId = current.parentId;
    current = parentId == null ? null : byId[parentId];
  }

  return chain;
}

/// Flatten a tree to a list, parents immediately before their children, skipping collapsed subtrees.
List<AlbumTreeNode> flattenAlbumTree(List<AlbumTreeNode> nodes, bool Function(String albumId) isExpanded) {
  final ordered = <AlbumTreeNode>[];

  void visit(List<AlbumTreeNode> level) {
    for (final node in level) {
      ordered.add(node);
      if (node.children.isNotEmpty && isExpanded(node.album.id)) {
        visit(node.children);
      }
    }
  }

  visit(nodes);
  return ordered;
}

/// Every album, in tree order, annotated with why it cannot receive [moving] -- or nothing, if it can.
///
/// Blocked targets are returned rather than filtered out, because the picker shows them disabled with
/// the reason. Hiding them is the mistake the locked-album selector already made once: an unfiltered
/// list that offered destinations which could only fail, with nothing saying why.
///
/// The rules mirror the server's, including the deliberate asymmetry: a **locked** album may move into
/// a normal one, because every listing already withholds locked albums from an unelevated session,
/// while a normal album may not move into a locked one.
List<MoveTarget> albumMoveTargets(List<RemoteAlbum> albums, RemoteAlbum moving, String currentUserId) {
  final tree = buildAlbumTree(albums);

  AlbumTreeNode? findMoving(List<AlbumTreeNode> nodes) {
    for (final node in nodes) {
      if (node.album.id == moving.id) {
        return node;
      }
      final found = findMoving(node.children);
      if (found != null) {
        return found;
      }
    }
    return null;
  }

  final movingNode = findMoving(tree);

  final descendantIds = <String>{};
  void collect(List<AlbumTreeNode> nodes) {
    for (final node in nodes) {
      descendantIds.add(node.album.id);
      collect(node.children);
    }
  }

  int heightOf(AlbumTreeNode node) =>
      node.children.isEmpty ? 0 : 1 + node.children.map(heightOf).reduce((a, b) => a > b ? a : b);

  var movingHeight = 0;
  if (movingNode != null) {
    collect(movingNode.children);
    movingHeight = heightOf(movingNode);
  }

  MoveBlocker? blockerFor(AlbumTreeNode target) {
    if (target.album.id == moving.id) {
      return MoveBlocker.self;
    }
    if (descendantIds.contains(target.album.id)) {
      return MoveBlocker.descendant;
    }
    if (target.album.id == moving.parentId) {
      return MoveBlocker.currentParent;
    }
    if (target.album.ownerId != currentUserId) {
      return MoveBlocker.notOwned;
    }
    if (!moving.isLocked && target.album.isLocked) {
      return MoveBlocker.lockMismatch;
    }
    if (target.depth + 1 + movingHeight + 1 > kAlbumMaxDepth) {
      return MoveBlocker.tooDeep;
    }
    return null;
  }

  final targets = <MoveTarget>[];
  void visit(List<AlbumTreeNode> nodes) {
    final sorted = [...nodes]..sort((a, b) => a.album.name.toLowerCase().compareTo(b.album.name.toLowerCase()));
    for (final node in sorted) {
      targets.add(MoveTarget(album: node.album, depth: node.depth, blocker: blockerFor(node)));
      visit(node.children);
    }
  }

  visit(tree);
  return targets;
}
