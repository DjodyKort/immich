import { getAllAlbums, getAuthStatus } from '@immich/sdk';
import { redirect } from '@sveltejs/kit';
import { Route } from '$lib/route';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);

  const { isElevated, pinCode } = await getAuthStatus();
  if (!isElevated || !pinCode) {
    redirect(307, Route.pinPrompt({ continue: url.pathname + url.search }));
  }

  const $t = await getFormatter();

  // There is no server-side filter for locked albums, so fetch owned albums and filter here.
  // The user is elevated at this point (checked above), so it's safe to reveal locked albums.
  const albums = await getAllAlbums({ isOwned: true });
  const lockedAlbums = albums.filter((album) => album.isLocked);

  return {
    lockedAlbums,
    meta: {
      title: $t('locked_folder'),
    },
  };
}) satisfies PageLoad;
