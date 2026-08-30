<script lang="ts">
  import { getMoveTargets, type MoveTarget, type MoveTargetBlocker } from '$lib/utils/album-utils';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { type AlbumResponseDto } from '@immich/sdk';
  import { Button, Modal, ModalBody, ModalFooter, Text } from '@immich/ui';
  import { mdiFolderOutline, mdiFolderHomeOutline, mdiLockOutline } from '@mdi/js';
  import { Icon } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
    albums: AlbumResponseDto[];
    onClose: (parentId?: string | null) => void;
  };

  let { album, albums, onClose }: Props = $props();

  const targets = $derived(getMoveTargets(albums, album, authManager.user.id));

  // Every blocker gets a sentence. A disabled row with no reason is worse than no row at all: the user
  // sees their own album greyed out and has to guess, which is exactly the complaint the unfiltered
  // locked-album selector produced on mobile.
  const reasonFor = (blocker: MoveTargetBlocker) =>
    ({
      self: $t('album_move_blocked_self'),
      descendant: $t('album_move_blocked_descendant'),
      currentParent: $t('album_move_blocked_current_parent'),
      lockMismatch: $t('album_move_blocked_lock_mismatch'),
      notOwned: $t('album_move_blocked_not_owned'),
      tooDeep: $t('album_move_blocked_too_deep'),
    })[blocker];

  const choose = (target: MoveTarget) => {
    if (target.blocker) {
      return;
    }
    onClose(target.album.id);
  };
</script>

<Modal title={$t('album_move_to')} {onClose} size="small">
  <ModalBody>
    <div class="flex max-h-100 flex-col overflow-y-auto">
      <button
        type="button"
        class="flex items-center gap-3 rounded-lg px-3 py-2 text-start hover:bg-gray-100 disabled:opacity-50 dark:hover:bg-gray-800"
        disabled={album.parentId === null}
        onclick={() => onClose(null)}
      >
        <Icon icon={mdiFolderHomeOutline} size="1.25rem" />
        <span class="grow">{$t('album_move_to_top_level')}</span>
        {#if album.parentId === null}
          <Text size="tiny" color="muted">{$t('album_move_blocked_current_parent')}</Text>
        {/if}
      </button>

      {#each targets as target (target.album.id)}
        <button
          type="button"
          class="flex items-center gap-3 rounded-lg px-3 py-2 text-start hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:bg-gray-800"
          style="padding-inline-start: {0.75 + target.depth * 1.25}rem"
          disabled={!!target.blocker}
          onclick={() => choose(target)}
        >
          <Icon icon={target.album.isLocked ? mdiLockOutline : mdiFolderOutline} size="1.25rem" />
          <span class="grow truncate">{target.album.albumName}</span>
          {#if target.blocker}
            <Text size="tiny" color="muted">{reasonFor(target.blocker)}</Text>
          {/if}
        </button>
      {/each}
    </div>
  </ModalBody>
  <ModalFooter>
    <Button shape="round" color="secondary" fullWidth onclick={() => onClose()}>{$t('cancel')}</Button>
  </ModalFooter>
</Modal>
