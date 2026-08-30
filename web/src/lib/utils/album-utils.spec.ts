import { describe, expect, it } from 'vitest';
import {
  ALBUM_MAX_DEPTH,
  buildAlbumTree,
  flattenAlbumTree,
  getAlbumBreadcrumb,
  getMoveTargets,
} from '$lib/utils/album-utils';
import { albumFactory } from '@test-data/factories/album-factory';

const album = (id: string, parentId: string | null = null, albumName = id) =>
  albumFactory.build({ id, parentId, albumName });

const ids = (albums: { album: { id: string } }[]) => albums.map(({ album }) => album.id);
const noSort = <T>(albums: T[]) => albums;
const allExpanded = () => true;

describe('buildAlbumTree', () => {
  it('nests children under their parent', () => {
    const tree = buildAlbumTree([album('parent'), album('child', 'parent')]);

    const [root] = tree;
    const [child] = root.children;
    expect(ids(tree)).toEqual(['parent']);
    expect(ids(root.children)).toEqual(['child']);
    expect(root.depth).toBe(0);
    expect(child.depth).toBe(1);
  });

  // The case that matters most: the list is already filtered by what the viewer may see, so a missing
  // parent is normal. Dropping the child would make an album the user owns disappear from their own
  // album list because of something about its parent.
  it('promotes a child whose parent is not in the list', () => {
    const tree = buildAlbumTree([album('orphan', 'trashed-or-invisible')]);

    expect(ids(tree)).toEqual(['orphan']);
    expect(tree[0].depth).toBe(0);
  });

  it('keeps every album, whatever the shape', () => {
    const albums = [album('a'), album('b', 'a'), album('c', 'b'), album('d', 'missing'), album('e')];

    const tree = buildAlbumTree(albums);
    const collect = (nodes: ReturnType<typeof buildAlbumTree>): string[] =>
      nodes.flatMap((node) => [node.album.id, ...collect(node.children)]);

    expect(collect(tree).sort()).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  // Unreachable via the API -- the server refuses to create a cycle -- but a corrupt row must not
  // hang the browser or hide an album.
  it('does not loop on a cycle, and still renders both albums', () => {
    const tree = buildAlbumTree([album('x', 'y'), album('y', 'x')]);

    const collect = (nodes: ReturnType<typeof buildAlbumTree>): string[] =>
      nodes.flatMap((node) => [node.album.id, ...collect(node.children)]);
    expect(collect(tree).sort()).toEqual(['x', 'y']);
  });

  it('ignores an album that is its own parent', () => {
    const tree = buildAlbumTree([album('self', 'self')]);

    expect(ids(tree)).toEqual(['self']);
  });
});

describe('getAlbumBreadcrumb', () => {
  it('returns the chain from the root down to the album', () => {
    const albums = [album('root'), album('mid', 'root'), album('leaf', 'mid')];

    expect(getAlbumBreadcrumb(albums, 'leaf').map(({ id }) => id)).toEqual(['root', 'mid', 'leaf']);
  });

  it('is just the album itself at the top level', () => {
    expect(getAlbumBreadcrumb([album('solo')], 'solo').map(({ id }) => id)).toEqual(['solo']);
  });

  // Stops rather than inventing a link to an album the viewer cannot open.
  it('stops at the first ancestor that is not visible', () => {
    const albums = [album('visible', 'hidden-parent')];

    expect(getAlbumBreadcrumb(albums, 'visible').map(({ id }) => id)).toEqual(['visible']);
  });

  it('returns nothing for an album that is not in the list', () => {
    expect(getAlbumBreadcrumb([album('a')], 'missing')).toEqual([]);
  });
});

describe('flattenAlbumTree', () => {
  it('places a parent immediately before its children', () => {
    const tree = buildAlbumTree([album('p'), album('c1', 'p'), album('c2', 'p'), album('other')]);

    const flat = flattenAlbumTree(tree, allExpanded, noSort);

    expect(ids(flat)).toEqual(['p', 'c1', 'c2', 'other']);
  });

  it('omits the children of a collapsed folder', () => {
    const tree = buildAlbumTree([album('p'), album('c', 'p')]);

    const flat = flattenAlbumTree(tree, () => false, noSort);

    expect(ids(flat)).toEqual(['p']);
  });

  // Sorting has to run per level: sorting the flattened list would interleave children with albums
  // they have nothing to do with.
  it('sorts within a level, not across the whole tree', () => {
    const tree = buildAlbumTree([album('b'), album('a'), album('z', 'b')]);

    const byName = (albums: { albumName: string }[]) =>
      [...albums].sort((x, y) => x.albumName.localeCompare(y.albumName));
    const flat = flattenAlbumTree(tree, allExpanded, byName as never);

    expect(ids(flat)).toEqual(['a', 'b', 'z']);
  });
});

describe('getMoveTargets', () => {
  const me = 'me';
  const owned = (id: string, parentId: string | null = null, extra: Record<string, unknown> = {}) =>
    albumFactory.build({
      id,
      parentId,
      albumName: id,
      albumUsers: [{ user: { id: me }, role: 'owner' }],
      ...extra,
    } as never);

  const blockerOf = (targets: ReturnType<typeof getMoveTargets>, id: string) =>
    targets.find((target) => target.album.id === id)?.blocker;

  // Blocked targets are listed, not hidden -- the picker shows them disabled with the reason. Hiding
  // them is how mobile's locked-album selector ended up offering destinations that could only fail.
  it('returns every album, blocked ones included', () => {
    const albums = [owned('a'), owned('b'), owned('c', 'a')];

    const targets = getMoveTargets(albums, albums[0], me);

    expect(targets.map(({ album }) => album.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('blocks the album itself and its own descendants', () => {
    const albums = [owned('root'), owned('child', 'root'), owned('grandchild', 'child'), owned('elsewhere')];

    const targets = getMoveTargets(albums, albums[0], me);

    expect(blockerOf(targets, 'root')).toBe('self');
    expect(blockerOf(targets, 'child')).toBe('descendant');
    expect(blockerOf(targets, 'grandchild')).toBe('descendant');
    expect(blockerOf(targets, 'elsewhere')).toBeUndefined();
  });

  it('blocks the album it already sits in, as a no-op', () => {
    const albums = [owned('parent'), owned('child', 'parent')];

    expect(blockerOf(getMoveTargets(albums, albums[1], me), 'parent')).toBe('currentParent');
  });

  it("blocks another user's album", () => {
    const theirs = albumFactory.build({
      id: 'theirs',
      parentId: null,
      albumUsers: [{ user: { id: 'someone-else' }, role: 'owner' }],
    } as never);
    const albums = [owned('mine'), theirs];

    expect(blockerOf(getMoveTargets(albums, albums[0], me), 'theirs')).toBe('notOwned');
  });

  // The asymmetry: locked into normal is fine, normal into locked is not.
  it('blocks a normal album from moving into a locked one, but not the reverse', () => {
    const normal = owned('normal');
    const locked = owned('locked', null, { isLocked: true });
    const albums = [normal, locked];

    expect(blockerOf(getMoveTargets(albums, normal, me), 'locked')).toBe('lockMismatch');
    expect(blockerOf(getMoveTargets(albums, locked, me), 'normal')).toBeUndefined();
  });

  it('blocks a target that would push the tree past the depth cap', () => {
    const chain = Array.from({ length: ALBUM_MAX_DEPTH }, (_, index) =>
      owned(`level${index}`, index === 0 ? null : `level${index - 1}`),
    );
    const mover = owned('mover');

    const targets = getMoveTargets([...chain, mover], mover, me);

    expect(blockerOf(targets, `level${ALBUM_MAX_DEPTH - 1}`)).toBe('tooDeep');
    expect(blockerOf(targets, 'level0')).toBeUndefined();
  });

  // A move that looks shallow can still overflow, because the subtree travels with it. Both sides of
  // the boundary are asserted, so an off-by-one in either direction fails.
  it("counts the moving album's own subtree towards the cap", () => {
    // level0..level(N-2), so the deepest sits at 0-based depth N-2.
    const chain = Array.from({ length: ALBUM_MAX_DEPTH - 1 }, (_, index) =>
      owned(`level${index}`, index === 0 ? null : `level${index - 1}`),
    );
    const mover = owned('mover');
    const moverChild = owned('moverChild', 'mover');

    const targets = getMoveTargets([...chain, mover, moverChild], mover, me);

    // Landing here would put moverChild one level past the cap.
    expect(blockerOf(targets, `level${ALBUM_MAX_DEPTH - 2}`)).toBe('tooDeep');
    // One level shallower fits exactly.
    expect(blockerOf(targets, `level${ALBUM_MAX_DEPTH - 3}`)).toBeUndefined();
  });
});
