import type {
  AlbumResponseDto,
  AlbumUserRole,
  ApiKeyResponseDto,
  AssetResponseDto,
  AssetSurface,
  IntegrityReport,
  JobCreateDto,
  LibraryResponseDto,
  LoginResponseDto,
  PersonResponseDto,
  QueueResponseDto,
  ReleaseEventV1,
  SharedLinkResponseDto,
  SystemConfigDto,
  TagResponseDto,
  UserAdminResponseDto,
  WorkflowResponseDto,
} from '@immich/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { TreeNode } from '$lib/utils/tree-utils';

export type Events = {
  AppInit: [];
  AppNavigate: [];

  AuthLogin: [LoginResponseDto];
  AuthLogout: [];
  AuthUserLoaded: [UserAdminResponseDto];

  LanguageChange: [{ name: string; code: string; rtl?: boolean }];

  ApiKeyCreate: [ApiKeyResponseDto];
  ApiKeyUpdate: [ApiKeyResponseDto];
  ApiKeyDelete: [ApiKeyResponseDto];

  AssetUpdate: [AssetResponseDto];
  AssetsArchive: [string[]];
  AssetsUnarchive: [TimelineAsset[]];
  AssetsUndoArchive: [TimelineAsset[]];
  AssetsDelete: [string[]];
  AssetEditsApplied: [string];
  AssetsTag: [string[]];
  AssetsHiddenFrom: [{ assetIds: string[]; hiddenFrom: AssetSurface[] }];

  AlbumAddAssets: [{ assetIds: string[]; albumIds: string[] }];
  AlbumCreate: [AlbumResponseDto];
  AlbumUpdate: [AlbumResponseDto];
  /**
   * The album's photos moved on or off a surface -- its `hiddenFrom` rule changed, or it was locked
   * or unlocked. Separate from `AlbumUpdate` because that also fires for renames, and the timeline
   * reload this triggers is a full re-read: worth it for a rule change, wasteful for a title edit.
   */
  AlbumVisibilityChange: [AlbumResponseDto];
  AlbumDelete: [AlbumResponseDto];
  AlbumShare: [];
  AlbumUserUpdate: [{ albumId: string; userId: string; role: AlbumUserRole }];
  AlbumUserDelete: [{ albumId: string; userId: string }];

  PersonUpdate: [PersonResponseDto];
  PersonThumbnailReady: [{ id: string }];
  PersonAssetDelete: [{ id: string; assetId: string }];

  BackupDeleteStatus: [{ filename: string; isDeleting: boolean }];
  BackupDeleted: [{ filename: string }];
  BackupUpload: [{ progress: number; isComplete: boolean }];

  QueueUpdate: [QueueResponseDto];

  SharedLinkCreate: [SharedLinkResponseDto];
  SharedLinkUpdate: [SharedLinkResponseDto];
  SharedLinkDelete: [SharedLinkResponseDto];

  TagCreate: [TagResponseDto];
  TagUpdate: [TagResponseDto];
  TagDelete: [TreeNode];

  UserPinCodeReset: [];

  UserAdminCreate: [UserAdminResponseDto];
  UserAdminUpdate: [UserAdminResponseDto];
  UserAdminRestore: [UserAdminResponseDto];
  // soft deleted
  UserAdminDelete: [UserAdminResponseDto];
  // confirmed permanently deleted from server
  UserAdminDeleted: [{ id: string }];

  SessionLocked: [];
  SessionDelete: [];

  SystemConfigUpdate: [SystemConfigDto];

  IntegrityReportDeleteStatus: [{ type?: IntegrityReport; id?: string; isDeleting: boolean }];
  IntegrityReportDeleted: [{ type?: IntegrityReport; id?: string }];

  JobCreate: [{ dto: JobCreateDto }];

  LibraryCreate: [LibraryResponseDto];
  LibraryUpdate: [LibraryResponseDto];
  LibraryDelete: [{ id: string }];

  WorkflowCreate: [WorkflowResponseDto];
  WorkflowUpdate: [WorkflowResponseDto];
  WorkflowDelete: [WorkflowResponseDto];

  ReleaseEvent: [ReleaseEventV1];

  WebsocketConnect: [];
};

export const eventManager = new BaseEventManager<Events>();
