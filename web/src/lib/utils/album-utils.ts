import type { AlbumResponseDto } from '@immich/sdk';
import * as sdk from '@immich/sdk';
import { orderBy } from 'lodash-es';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { goto } from '$app/navigation';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { Route } from '$lib/route';
import {
  AlbumFilter,
  AlbumGroupBy,
  AlbumSortBy,
  SortOrder,
  albumViewSettings,
  locale,
  type AlbumViewSettings,
} from '$lib/stores/preferences.store';
import { handleError } from '$lib/utils/handle-error';

/**
 * -------------------------
 * Albums General Management
 * -------------------------
 */
export const createAlbum = async (name?: string, assetIds?: string[], isLocked?: boolean, parentId?: string) => {
  try {
    const newAlbum: AlbumResponseDto = await sdk.createAlbum({
      createAlbumDto: {
        albumName: name ?? '',
        assetIds,
        isLocked,
        parentId,
      },
    });
    eventManager.emit('AlbumCreate', newAlbum);
    return newAlbum;
  } catch (error) {
    const $t = get(t);
    handleError(error, $t('errors.failed_to_create_album'));
  }
};

export const createAlbumAndRedirect = async (name?: string, assetIds?: string[], parentId?: string) => {
  const newAlbum = await createAlbum(name, assetIds, undefined, parentId);
  if (newAlbum) {
    await goto(Route.viewAlbum(newAlbum));
  }
};

/**
 * -------------
 * Album Sorting
 * -------------
 */
export interface AlbumSortOptionMetadata {
  id: AlbumSortBy;
  defaultOrder: SortOrder;
  columnStyle: string;
}

export const sortOptionsMetadata: AlbumSortOptionMetadata[] = [
  {
    id: AlbumSortBy.Title,
    defaultOrder: SortOrder.Asc,
    columnStyle: 'text-start w-8/12 sm:w-4/12 md:w-4/12 xl:w-[30%] 2xl:w-[40%]',
  },
  {
    id: AlbumSortBy.ItemCount,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center w-4/12 m:w-2/12 md:w-2/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.DateModified,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden sm:block w-3/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.DateCreated,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden sm:block w-3/12 xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.MostRecentPhoto,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden xl:block xl:w-[15%] 2xl:w-[12%]',
  },
  {
    id: AlbumSortBy.OldestPhoto,
    defaultOrder: SortOrder.Desc,
    columnStyle: 'text-center hidden xl:block xl:w-[15%] 2xl:w-[12%]',
  },
];

export const findSortOptionMetadata = (sortBy: string) => {
  // Default is sort by most recent photo
  const defaultSortOption = sortOptionsMetadata[4];
  return sortOptionsMetadata.find(({ id }) => sortBy === id) ?? defaultSortOption;
};

export const findFilterOption = (filter: string) => {
  // Default is All filter
  const defaultFilterOption = AlbumFilter.All;
  return Object.values(AlbumFilter).find((key) => filter === AlbumFilter[key]) ?? defaultFilterOption;
};

/**
 * --------------
 * Album Grouping
 * --------------
 */
export interface AlbumGroup {
  id: string;
  name: string;
  albums: AlbumResponseDto[];
}

export interface AlbumGroupOptionMetadata {
  id: AlbumGroupBy;
  defaultOrder: SortOrder;
  isDisabled: () => boolean;
}

export const groupOptionsMetadata: AlbumGroupOptionMetadata[] = [
  {
    id: AlbumGroupBy.None,
    defaultOrder: SortOrder.Asc,
    isDisabled: () => false,
  },
  {
    id: AlbumGroupBy.Year,
    defaultOrder: SortOrder.Desc,
    isDisabled() {
      const disabledWithSortOptions: string[] = [AlbumSortBy.DateCreated, AlbumSortBy.DateModified];
      return disabledWithSortOptions.includes(get(albumViewSettings).sortBy);
    },
  },
  {
    id: AlbumGroupBy.Owner,
    defaultOrder: SortOrder.Asc,
    isDisabled: () => false,
  },
  {
    id: AlbumGroupBy.Folder,
    defaultOrder: SortOrder.Asc,
    // Never disabled. Unlike Year, which cannot combine with a created/modified sort, folder grouping
    // is orthogonal to every sort: sorting applies within each level of the tree.
    isDisabled: () => false,
  },
];

export const findGroupOptionMetadata = (groupBy: string) => {
  // Default is no grouping
  const defaultGroupOption = groupOptionsMetadata[0];
  return groupOptionsMetadata.find(({ id }) => groupBy === id) ?? defaultGroupOption;
};

export const getSelectedAlbumGroupOption = (settings: AlbumViewSettings) => {
  const defaultGroupOption = AlbumGroupBy.None;
  const albumGroupOption = settings.groupBy ?? defaultGroupOption;

  if (findGroupOptionMetadata(albumGroupOption).isDisabled()) {
    return defaultGroupOption;
  }
  return albumGroupOption;
};

/**
 * ----------------------------
 * Album Groups Collapse/Expand
 * ----------------------------
 */
const getCollapsedAlbumGroups = (settings: AlbumViewSettings) => {
  settings.collapsedGroups ??= {};
  const { collapsedGroups, groupBy } = settings;
  collapsedGroups[groupBy] ??= [];
  return collapsedGroups[groupBy];
};

export const isAlbumGroupCollapsed = (settings: AlbumViewSettings, groupId: string) => {
  if (settings.groupBy === AlbumGroupBy.None) {
    return false;
  }
  return getCollapsedAlbumGroups(settings).includes(groupId);
};

export const toggleAlbumGroupCollapsing = (groupId: string) => {
  const settings = get(albumViewSettings);
  if (settings.groupBy === AlbumGroupBy.None) {
    return;
  }
  const collapsedGroups = getCollapsedAlbumGroups(settings);
  const groupIndex = collapsedGroups.indexOf(groupId);
  if (groupIndex === -1) {
    // Collapse
    collapsedGroups.push(groupId);
  } else {
    // Expand
    collapsedGroups.splice(groupIndex, 1);
  }
  albumViewSettings.set(settings);
};

export const collapseAllAlbumGroups = (groupIds: string[]) => {
  albumViewSettings.update((settings) => {
    const collapsedGroups = getCollapsedAlbumGroups(settings);
    collapsedGroups.length = 0;
    collapsedGroups.push(...groupIds);
    return settings;
  });
};

export const expandAllAlbumGroups = () => {
  collapseAllAlbumGroups([]);
};

interface AlbumSortOption {
  [option: string]: (order: SortOrder, albums: AlbumResponseDto[]) => AlbumResponseDto[];
}

const sortUnknownYearAlbums = (a: AlbumResponseDto, b: AlbumResponseDto) => {
  if (!a.endDate) {
    return 1;
  }
  if (!b.endDate) {
    return -1;
  }
  return 0;
};

export const stringToSortOrder = (order: string) => {
  return order === 'desc' ? SortOrder.Desc : SortOrder.Asc;
};

const sortOptions: AlbumSortOption = {
  /** Sort by album title */
  [AlbumSortBy.Title]: (order, albums) => {
    const sortSign = order === SortOrder.Desc ? -1 : 1;
    return albums.slice().sort((a, b) => a.albumName.localeCompare(b.albumName, get(locale)) * sortSign);
  },

  /** Sort by asset count */
  [AlbumSortBy.ItemCount]: (order, albums) => {
    return orderBy(albums, 'assetCount', [order]);
  },

  /** Sort by last modified */
  [AlbumSortBy.DateModified]: (order, albums) => {
    return orderBy(albums, [({ updatedAt }) => new Date(updatedAt)], [order]);
  },

  /** Sort by creation date */
  [AlbumSortBy.DateCreated]: (order, albums) => {
    return orderBy(albums, [({ createdAt }) => new Date(createdAt)], [order]);
  },

  /** Sort by the most recent photo date */
  [AlbumSortBy.MostRecentPhoto]: (order, albums) => {
    albums = orderBy(albums, [({ endDate }) => (endDate ? new Date(endDate) : '')], [order]);
    return albums.sort(sortUnknownYearAlbums);
  },

  /** Sort by the oldest photo date */
  [AlbumSortBy.OldestPhoto]: (order, albums) => {
    albums = orderBy(albums, [({ startDate }) => (startDate ? new Date(startDate) : '')], [order]);
    return albums.sort(sortUnknownYearAlbums);
  },
};

export const sortAlbums = (albums: AlbumResponseDto[], { sortBy, orderBy }: { sortBy: string; orderBy: string }) => {
  const sort = sortOptions[sortBy] ?? sortOptions[AlbumSortBy.DateModified];
  const order = stringToSortOrder(orderBy);

  return sort(order, albums);
};

/**
 * ----------------
 * Albums as a tree
 * ----------------
 */

export interface AlbumTreeNode {
  album: AlbumResponseDto;
  children: AlbumTreeNode[];
  /** 0 for a root. Used for indentation and for the breadcrumb. */
  depth: number;
}

/**
 * Arrange a flat album list into the tree its `parentId`s describe.
 *
 * The list this receives is already filtered by what the viewer may see -- a locked album is absent
 * for an unelevated session, and an album shared with someone else never appears at all. So a child
 * whose parent is missing is normal rather than exceptional, and it is **promoted to a root** instead
 * of being dropped. Dropping it would make an album the user owns vanish from their own album list
 * because of something about its parent, which is the one outcome this must never produce.
 *
 * The same promotion covers a *trashed* parent: soft delete deliberately leaves `parentId` alone so
 * restoring the parent re-nests its children, and until then those children read as top-level here.
 *
 * A cycle cannot reach this function -- the server refuses to create one -- but a corrupt row should
 * not hang the browser, so nodes are visited once and anything still unplaced is promoted.
 */
export const buildAlbumTree = (albums: AlbumResponseDto[]): AlbumTreeNode[] => {
  const nodes = new Map<string, AlbumTreeNode>();
  for (const album of albums) {
    nodes.set(album.id, { album, children: [], depth: 0 });
  }

  const roots: AlbumTreeNode[] = [];
  for (const node of nodes.values()) {
    const parentId = node.album.parentId;
    const parent = parentId ? nodes.get(parentId) : undefined;
    if (parent && parent !== node) {
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  }

  // Depth is assigned by walking down from the roots rather than by counting parents upwards, so a
  // promoted orphan is depth 0 -- which is what it renders as.
  //
  // The walk also *prunes* any child already placed elsewhere in the tree. Only a corrupt row can
  // produce one, but leaving the back-edge in place would return a structure that terminates here and
  // then loops forever in the first consumer that walks `children` recursively. Pruning makes the
  // returned tree acyclic by construction, which is the guarantee callers actually need.
  const seen = new Set<string>();
  const assignDepth = (node: AlbumTreeNode, depth: number) => {
    node.depth = depth;
    node.children = node.children.filter((child) => !seen.has(child.album.id));
    for (const child of node.children) {
      seen.add(child.album.id);
      assignDepth(child, depth + 1);
    }
  };
  for (const root of roots) {
    seen.add(root.album.id);
    assignDepth(root, 0);
  }

  // Anything unreachable from a root can only be part of a cycle. Promote it so it stays findable,
  // rather than leaving it rendered nowhere.
  for (const node of nodes.values()) {
    if (seen.has(node.album.id)) {
      continue;
    }
    roots.push(node);
    seen.add(node.album.id);
    assignDepth(node, 0);
  }

  return roots;
};

/**
 * The chain of albums from the root down to [albumId], inclusive.
 *
 * Built from the same flat list the tree is, so it stops at the first ancestor the viewer cannot see
 * rather than inventing a link to an album they have no access to.
 */
export const getAlbumBreadcrumb = (albums: AlbumResponseDto[], albumId: string): AlbumResponseDto[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const chain: AlbumResponseDto[] = [];
  const seen = new Set<string>();

  let current = byId.get(albumId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return chain;
};

/**
 * Flatten a tree back to a list, parents immediately before their children.
 *
 * [isExpanded] decides whether a node's children are included at all, so a collapsed folder costs
 * nothing to render. Sorting is applied per level by [sort], because sorting the flattened result
 * would interleave children with unrelated albums.
 */
export const flattenAlbumTree = (
  nodes: AlbumTreeNode[],
  isExpanded: (albumId: string) => boolean,
  sort: (albums: AlbumResponseDto[]) => AlbumResponseDto[],
): AlbumTreeNode[] => {
  const ordered: AlbumTreeNode[] = [];

  const visit = (level: AlbumTreeNode[]) => {
    const byId = new Map(level.map((node) => [node.album.id, node]));
    for (const album of sort(level.map((node) => node.album))) {
      const node = byId.get(album.id);
      if (!node) {
        continue;
      }
      ordered.push(node);
      if (node.children.length > 0 && isExpanded(node.album.id)) {
        visit(node.children);
      }
    }
  };

  visit(nodes);
  return ordered;
};

/** Why an album cannot be the destination of a move. */
export type MoveTargetBlocker = 'self' | 'descendant' | 'currentParent' | 'lockMismatch' | 'notOwned' | 'tooDeep';

export interface MoveTarget {
  album: AlbumResponseDto;
  depth: number;
  /** Undefined when the move is allowed. */
  blocker?: MoveTargetBlocker;
}

/** Mirrors ALBUM_MAX_DEPTH in server/src/utils/album.util.ts. */
export const ALBUM_MAX_DEPTH = 10;

/**
 * Every album, in tree order, annotated with why it cannot receive [moving] -- or nothing, if it can.
 *
 * Blocked targets are returned rather than filtered out, because the picker shows them disabled with
 * the reason attached. Hiding them makes the app look broken in exactly the case the user needs
 * explaining: their own album is missing from the list and nothing says why. It is also the mistake
 * mobile made with the locked-album selector, where an unfiltered list offered destinations that
 * could only fail.
 *
 * The rules match the server's, including the deliberate asymmetry: a **locked** album may move into
 * a normal one, because every listing already withholds locked albums from an unelevated session,
 * while a normal album may not move into a locked one.
 */
export const getMoveTargets = (
  albums: AlbumResponseDto[],
  moving: AlbumResponseDto,
  currentUserId: string,
): MoveTarget[] => {
  const tree = buildAlbumTree(albums);

  const descendantIds = new Set<string>();
  const collectDescendants = (nodes: AlbumTreeNode[]) => {
    for (const node of nodes) {
      descendantIds.add(node.album.id);
      collectDescendants(node.children);
    }
  };
  const findNode = (nodes: AlbumTreeNode[]): AlbumTreeNode | undefined => {
    for (const node of nodes) {
      if (node.album.id === moving.id) {
        return node;
      }
      const found = findNode(node.children);
      if (found) {
        return found;
      }
    }
  };
  const movingNode = findNode(tree);
  if (movingNode) {
    collectDescendants(movingNode.children);
  }

  // How tall the moving album's own subtree is, since it travels with it.
  const heightOf = (node: AlbumTreeNode): number =>
    node.children.length === 0 ? 0 : 1 + Math.max(...node.children.map((child) => heightOf(child)));
  const movingHeight = movingNode ? heightOf(movingNode) : 0;

  const blockerFor = (target: AlbumTreeNode): MoveTargetBlocker | undefined => {
    if (target.album.id === moving.id) {
      return 'self';
    }
    if (descendantIds.has(target.album.id)) {
      return 'descendant';
    }
    if (target.album.id === moving.parentId) {
      return 'currentParent';
    }
    if (target.album.albumUsers[0]?.user.id !== currentUserId) {
      return 'notOwned';
    }
    if (!moving.isLocked && target.album.isLocked) {
      return 'lockMismatch';
    }
    // target.depth is 0-based, so the moved album lands at depth + 1 and its own subtree below that.
    if (target.depth + 1 + movingHeight + 1 > ALBUM_MAX_DEPTH) {
      return 'tooDeep';
    }
  };

  const targets: MoveTarget[] = [];
  const visit = (nodes: AlbumTreeNode[]) => {
    for (const node of orderBy(nodes, [({ album }) => album.albumName.toLowerCase()], ['asc'])) {
      targets.push({ album: node.album, depth: node.depth, blocker: blockerFor(node) });
      visit(node.children);
    }
  };
  visit(tree);

  return targets;
};
