import { render } from '@testing-library/svelte';
import AlbumLockedIcon from '$lib/components/album-page/AlbumLockedIcon.svelte';
import { albumFactory } from '@test-data/factories/album-factory';

describe('AlbumLockedIcon component', () => {
  it('renders nothing for an ordinary album', () => {
    const component = render(AlbumLockedIcon, { album: albumFactory.build({ isLocked: false }) });
    expect(component.queryByTestId('album-locked-icon')).toBeNull();
  });

  // `isLocked` is the only input, deliberately. Every other locked-album marker in the web app swaps
  // the album's cover for a padlock only while the session is unelevated, so entering a PIN made
  // locked albums look exactly like ordinary ones - in the one state where you can act on them. This
  // component has no way to observe elevation, so it cannot regress back to that.
  it('marks a locked album regardless of session elevation', () => {
    const component = render(AlbumLockedIcon, { album: albumFactory.build({ isLocked: true }) });
    expect(component.getByTestId('album-locked-icon').title).toBe('locked_album');
  });
});
