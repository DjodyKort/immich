import { beforeEach, describe, expect, it } from 'vitest';
import { faceOverlayManager } from '$lib/stores/face-overlay.svelte';

describe('FaceOverlayManager', () => {
  beforeEach(() => {
    localStorage.clear();
    faceOverlayManager.clearSessionOverride();
    faceOverlayManager.showByDefault = true;
  });

  it('is on out of the box, so nothing changes for anyone who never opens the setting', () => {
    expect(faceOverlayManager.isEnabled).toBe(true);
  });

  it('follows the saved default while no override is set', () => {
    faceOverlayManager.showByDefault = false;
    expect(faceOverlayManager.isEnabled).toBe(false);

    faceOverlayManager.showByDefault = true;
    expect(faceOverlayManager.isEnabled).toBe(true);
  });

  it('persists the default, so a new tab starts from it', () => {
    faceOverlayManager.showByDefault = false;
    expect(localStorage.getItem('face-overlay-on-hover')).toBe('false');
  });

  it('lets the session override win over the saved default', () => {
    expect(faceOverlayManager.showByDefault).toBe(true);

    faceOverlayManager.toggle();

    expect(faceOverlayManager.isEnabled).toBe(false);
    // The point of the override: the setting the user saved is untouched.
    expect(faceOverlayManager.showByDefault).toBe(true);
  });

  it('toggles from what is in effect, not from the default', () => {
    faceOverlayManager.showByDefault = false;

    faceOverlayManager.toggle();

    // A toggle that read the default would have produced false again here, and the first click would
    // have appeared to do nothing.
    expect(faceOverlayManager.isEnabled).toBe(true);
  });

  it('drops the override when the default is changed, so the setting is not silently outranked', () => {
    faceOverlayManager.toggle();
    expect(faceOverlayManager.isEnabled).toBe(false);

    faceOverlayManager.showByDefault = false;
    faceOverlayManager.showByDefault = true;

    expect(faceOverlayManager.isEnabled).toBe(true);
  });
});
