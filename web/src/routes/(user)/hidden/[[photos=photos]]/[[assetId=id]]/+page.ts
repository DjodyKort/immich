import { getAllAlbums } from '@immich/sdk';
import { authenticate } from '$lib/utils/auth';
import { getFormatter } from '$lib/utils/i18n';
import type { PageLoad } from './$types';

export const load = (async ({ url }) => {
  await authenticate(url);
  const $t = await getFormatter();

  // Scoped to owned albums, same as the locked folder's album section: an album someone else
  // hid is theirs to manage, not something to surface here.
  const hiddenAlbums = await getAllAlbums({ isOwned: true, hidden: true });

  return {
    hiddenAlbums,
    meta: {
      title: $t('hidden'),
    },
  };
}) satisfies PageLoad;
