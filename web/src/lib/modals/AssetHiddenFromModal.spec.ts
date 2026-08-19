import { AssetSurface } from '@immich/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { init, register, waitLocale } from 'svelte-i18n';
import { getAnimateMock } from '$lib/__mocks__/animate.mock';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { getVisualViewportMock } from '$lib/__mocks__/visual-viewport.mock';
import AssetHiddenFromModal from './AssetHiddenFromModal.svelte';

describe('AssetHiddenFromModal component', () => {
  const onClose = vi.fn();

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.stubGlobal('visualViewport', getVisualViewportMock());
    vi.resetAllMocks();
    Element.prototype.animate = getAnimateMock();
  });

  afterAll(async () => {
    await waitFor(() => {
      expect(document.body.style.pointerEvents).not.toBe('none');
    });
  });

  const getSwitch = (name: string | RegExp) => screen.getByRole('switch', { name });

  it('prefills the switches from a single asset hiddenFrom', () => {
    render(AssetHiddenFromModal, {
      props: { onClose, assetIds: ['asset-1'], hiddenFrom: [AssetSurface.Timeline, AssetSurface.Map] },
    });

    expect(getSwitch('Main timeline')).toBeChecked();
    expect(getSwitch('Map')).toBeChecked();
    expect(getSwitch('Search')).not.toBeChecked();
    expect(getSwitch('People')).not.toBeChecked();
  });

  it('warns that a multi-selection is replaced wholesale, and starts blank', () => {
    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1', 'asset-2', 'asset-3'] } });

    expect(screen.getByText(/replacing whatever each one is hidden from now/)).toBeInTheDocument();
    expect(screen.getByText(/applies exactly this set to all 3 items/)).toBeInTheDocument();
    expect(getSwitch('Main timeline')).not.toBeChecked();
  });

  it('does not warn for a single asset', () => {
    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1'] } });

    expect(screen.queryByText(/replacing whatever each one is hidden from now/)).not.toBeInTheDocument();
  });

  it('sends the chosen surfaces for a single asset', async () => {
    sdkMock.updateAsset.mockResolvedValueOnce({ id: 'asset-1' } as never);

    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1'], hiddenFrom: [AssetSurface.Timeline] } });

    await userEvent.click(getSwitch('Memories'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({
        id: 'asset-1',
        updateAssetDto: { hiddenFrom: [AssetSurface.Timeline, AssetSurface.Memories] },
      }),
    );
    expect(sdkMock.updateAssets).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(true);
  });

  it('sends a bulk update for a multi-selection', async () => {
    sdkMock.updateAssets.mockResolvedValueOnce(undefined as never);

    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1', 'asset-2'] } });

    await userEvent.click(getSwitch('Search'));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateAssets).toHaveBeenCalledWith({
        assetBulkUpdateDto: { ids: ['asset-1', 'asset-2'], hiddenFrom: [AssetSurface.Search] },
      }),
    );
    expect(sdkMock.updateAsset).not.toHaveBeenCalled();
  });

  it('clears everything and saves an empty set', async () => {
    sdkMock.updateAsset.mockResolvedValueOnce({ id: 'asset-1' } as never);

    render(AssetHiddenFromModal, {
      props: { onClose, assetIds: ['asset-1'], hiddenFrom: [AssetSurface.Timeline, AssetSurface.Folders] },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));

    expect(getSwitch('Main timeline')).not.toBeChecked();
    expect(getSwitch('Folders')).not.toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateAsset).toHaveBeenCalledWith({ id: 'asset-1', updateAssetDto: { hiddenFrom: [] } }),
    );
  });
});
