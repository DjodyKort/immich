import { AssetSurface, AssetVisibility } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { assetFactory } from '@test-data/factories/asset-factory';
import DetailPanelHiddenFrom from './DetailPanelHiddenFrom.svelte';

describe('DetailPanelHiddenFrom component', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  // The inner span only: `Badge` wraps its content in one of its own, so a bare `span` query returns
  // each label twice.
  const badges = () =>
    [...screen.getByTestId('detail-panel-hidden-from').querySelectorAll('span.px-2')].map((el) => el.textContent);

  it('labels each excluded place', () => {
    const asset = assetFactory.build({ hiddenFrom: [AssetSurface.Timeline, AssetSurface.Map] });
    render(DetailPanelHiddenFrom, { props: { asset, isOwner: true } });

    expect(badges()).toEqual(['Main timeline', 'Map']);
  });

  // The same switch the hide-from modal calls "Locked folder" for a locked asset. For an asset in the
  // locked folder the timeline bit governs that grid, not the main timeline, so naming it "Main
  // timeline" here while the modal names it "Locked folder" describes one state two ways. Reads the
  // label from the shared table for exactly this reason.
  it('names the timeline row after the locked folder for a locked asset', () => {
    const asset = assetFactory.build({
      visibility: AssetVisibility.Locked,
      hiddenFrom: [AssetSurface.Timeline],
    });
    render(DetailPanelHiddenFrom, { props: { asset, isOwner: true } });

    expect(badges()).toEqual(['Locked folder']);
  });

  it('renders nothing for a non-owner', () => {
    const asset = assetFactory.build({ hiddenFrom: [AssetSurface.Timeline] });
    render(DetailPanelHiddenFrom, { props: { asset, isOwner: false } });

    expect(screen.queryByTestId('detail-panel-hidden-from')).toBeNull();
  });
});
