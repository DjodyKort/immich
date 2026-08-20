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

  // A selection is edited as per-place intentions, not as a set of places: the modal cannot know what a
  // multi-selection is currently hidden from, so a complete set would flatten assets that disagree and
  // discard exclusions nobody was shown. Switches cannot express "leave alone", hence the three-way
  // controls, and their absence here is the assertion that the bulk path is not the single-asset one.
  it('edits a multi-selection per place rather than as a set, and starts with nothing to apply', () => {
    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1', 'asset-2', 'asset-3'] } });

    expect(screen.getByText(/Every place starts unchanged/)).toBeInTheDocument();
    expect(screen.getByText(/applied to the 3 items/)).toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('keeps the switches, and no bulk notice, for a single asset', () => {
    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1'] } });

    expect(screen.queryByText(/Every place starts unchanged/)).not.toBeInTheDocument();
    expect(screen.queryAllByRole('switch')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Save' })).not.toBeDisabled();
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

  // The bulk payload rule is not exercised from here. Its controls are a headless `Select` whose trigger
  // exposes no role this environment can find, and the rule worth pinning is the intent-to-payload
  // mapping rather than the clicking -- so it is tested directly in `$lib/utils/hidden-from.spec.ts`,
  // which is also what stops `hiddenFrom` (the replacing field) ever being sent alongside the adjusting
  // ones. What is asserted here is that the bulk path is wired to a different control set at all, and
  // that it refuses to send a request with nothing set.
  it('does not send anything for a selection until a place is set', async () => {
    render(AssetHiddenFromModal, { props: { onClose, assetIds: ['asset-1', 'asset-2'] } });

    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(sdkMock.updateAssets).not.toHaveBeenCalled();
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
