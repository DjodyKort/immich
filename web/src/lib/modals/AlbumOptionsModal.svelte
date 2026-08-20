<script lang="ts">
  import AlbumSharedLink from '$lib/components/album-page/AlbumSharedLink.svelte';
  import HeaderActionButton from '$lib/components/HeaderActionButton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    getAlbumActions,
    handleRemoveUserFromAlbum,
    handleSetAlbumLocked,
    handleUpdateAlbum,
    handleUpdateUserAlbumRole,
  } from '$lib/services/album.service';
  import {
    AlbumUserRole,
    AssetOrder,
    getAlbumInfo,
    getAllSharedLinks,
    type AlbumResponseDto,
    type SharedLinkResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { Field, HStack, Modal, ModalBody, Select, Stack, Switch, Text, type SelectOption } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    album: AlbumResponseDto;
    readOnly?: boolean;
    onClose: () => void;
  };

  let { album, readOnly = false, onClose }: Props = $props();

  const handleRoleSelect = async (user: UserResponseDto, role: AlbumUserRole | 'none') => {
    if (role === 'none') {
      await handleRemoveUserFromAlbum(album, user);
      return;
    }

    await handleUpdateUserAlbumRole({ albumId: album.id, userId: user.id, role });
  };

  const refreshAlbum = async () => {
    album = await getAlbumInfo({ id: album.id });
  };

  const onAlbumUserDelete = async ({ userId }: { userId: string }) => {
    album.albumUsers = album.albumUsers.filter(({ user: { id } }) => id !== userId);
    await refreshAlbum();
  };

  const onSharedLinkCreate = (sharedLink: SharedLinkResponseDto) => {
    sharedLinks.push(sharedLink);
  };

  const onSharedLinkDelete = (sharedLink: SharedLinkResponseDto) => {
    sharedLinks = sharedLinks.filter(({ id }) => sharedLink.id !== id);
  };

  const { AddUsers, CreateSharedLink } = $derived(getAlbumActions($t, album));

  let sharedLinks: SharedLinkResponseDto[] = $state([]);

  /**
   * Whether anyone but the owner can reach this album, which is what stops it being locked. `albumUsers`
   * always contains the owner, so more than one entry means it is shared with a person; a shared link is
   * the other way in. The server refuses either, so both are checked here to explain it in place.
   */
  const isShared = $derived(album.albumUsers.length > 1 || sharedLinks.length > 0);

  onMount(async () => {
    sharedLinks = await getAllSharedLinks({ albumId: album.id });
  });
</script>

<OnEvents
  {onAlbumUserDelete}
  onAlbumShare={refreshAlbum}
  {onSharedLinkCreate}
  {onSharedLinkDelete}
  onAlbumUpdate={(newAlbum) => (album = newAlbum)}
/>

<Modal title={readOnly ? $t('album') : $t('options')} {onClose} size="small">
  <ModalBody>
    <Stack gap={6}>
      <div>
        <Text size="medium" fontWeight="semi-bold">{$t('settings')}</Text>
        <div class="mt-2 grid gap-y-3 ps-2">
          {#if album.order}
            <Field label={$t('display_order')} disabled={readOnly}>
              <Select
                value={album.order}
                options={[
                  { label: $t('newest_first'), value: AssetOrder.Desc },
                  { label: $t('oldest_first'), value: AssetOrder.Asc },
                ]}
                onChange={(value) => handleUpdateAlbum(album, { order: value })}
              />
            </Field>
          {/if}
          <Field label={$t('comments_and_likes')} description={$t('let_others_respond')} disabled={readOnly}>
            <Switch
              checked={album.isActivityEnabled}
              onCheckedChange={(checked) => handleUpdateAlbum(album, { isActivityEnabled: checked })}
            />
          </Field>
          <Field label={$t('hide_album')} description={$t('hide_album_description')} disabled={readOnly}>
            <Switch
              checked={album.isHidden}
              onCheckedChange={(checked) => handleUpdateAlbum(album, { isHidden: checked })}
            />
          </Field>
          <!--
            Locking is not hiding: it moves the album *and every photo in it* behind the PIN, so unlike the
            switch above it confirms first and names what will happen. Disabled while the album is shared,
            because the server refuses that case and saying so up front beats an error after the click.
          -->
          <Field
            label={$t('lock_album')}
            description={isShared ? $t('lock_album_error_shared') : $t('lock_album_description')}
            disabled={readOnly || isShared}
          >
            <Switch checked={album.isLocked} onCheckedChange={(checked) => handleSetAlbumLocked(album, checked)} />
          </Field>
        </div>
      </div>

      <div>
        <HStack fullWidth class="mb-2 justify-between">
          <Text size="medium" fontWeight="semi-bold">{$t('people')}</Text>
          {#if !readOnly}
            <HeaderActionButton action={AddUsers} />
          {/if}
        </HStack>
        <div class="ps-2">
          {#each album.albumUsers as { user, role } (user.id)}
            <div class="flex items-center justify-between gap-4 py-2">
              <div class="flex flex-row items-center gap-2">
                <div>
                  <UserAvatar {user} size="md" />
                </div>
                <Text size="small">{user.name}</Text>
              </div>
              <Field class="w-32" disabled={readOnly || role === AlbumUserRole.Owner}>
                <Select
                  value={role}
                  options={[
                    { label: $t('role_editor'), value: AlbumUserRole.Editor },
                    { label: $t('role_viewer'), value: AlbumUserRole.Viewer },
                    { label: $t('owner'), value: AlbumUserRole.Owner, disabled: true },
                    { label: $t('remove_user'), value: 'none' },
                  ] as SelectOption<AlbumUserRole | 'none'>[]}
                  onChange={(value) => handleRoleSelect(user, value)}
                />
              </Field>
            </div>
          {/each}
        </div>
      </div>
      {#if !readOnly}
        <div class="mb-4">
          <HStack class="mb-2 justify-between">
            <Text size="medium" fontWeight="semi-bold">{$t('shared_links')}</Text>
            <HeaderActionButton action={CreateSharedLink} />
          </HStack>

          <div class="ps-2">
            <Stack gap={4}>
              {#each sharedLinks as sharedLink (sharedLink.id)}
                <AlbumSharedLink {album} {sharedLink} />
              {/each}
            </Stack>
          </div>
        </div>
      {/if}
    </Stack>
  </ModalBody>
</Modal>
