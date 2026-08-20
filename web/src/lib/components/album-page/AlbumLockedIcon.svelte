<!--
  The padlock that marks an album as locked, wherever an album is named.

  It renders regardless of elevation, deliberately. `AlbumCover`, `AlbumListItem` and `RecentAlbums`
  each swap the *thumbnail* for a padlock while the session is unelevated, which marks the album only
  as long as it is inaccessible - the moment you enter your PIN the cover appears and every locked
  album becomes indistinguishable from an ordinary one. That is the state in which confusing the two
  actually costs something, since an unlocked-looking album is the one you might share or add
  ordinary photos to.
-->
<script lang="ts">
  import type { AlbumResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiLock } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    album: Pick<AlbumResponseDto, 'isLocked'>;
    size?: string;
    class?: string;
  }

  let { album, size = '16', class: className }: Props = $props();
</script>

{#if album.isLocked}
  <span title={$t('locked_album')} data-testid="album-locked-icon" class={['shrink-0', className]}>
    <Icon icon={mdiLock} {size} aria-label={$t('locked_album')} />
  </span>
{/if}
