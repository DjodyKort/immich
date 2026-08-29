import { PersistedLocalStorage } from '$lib/utils/persisted';

// The saved default, per browser. Deliberately local storage rather than a server-side user
// preference: the hover overlay is a web-only behaviour, so putting it on the account would mean a
// DTO change, a migration and a regenerated Dart client for something no other client can honour.
const showByDefault = new PersistedLocalStorage<boolean>('face-overlay-on-hover', true);

/**
 * Whether hovering a face -- or a person in the detail panel -- draws the bounding box overlay on
 * the photo: the dimmed backdrop, the outline, and the name label.
 *
 * Two layers, because turning it off is usually a mood rather than a decision. The saved default is
 * the one App Settings edits and the one a new tab starts from. The session override is what the
 * asset viewer's menu flips, and it lives in module state on purpose, so it lasts as long as the tab
 * and no longer.
 */
class FaceOverlayManager {
  // `undefined` means "no opinion this session, follow the saved default".
  #sessionOverride = $state<boolean | undefined>();

  /** What the overlay should actually do right now. This is the one every consumer reads. */
  get isEnabled() {
    return this.#sessionOverride ?? showByDefault.current;
  }

  get showByDefault() {
    return showByDefault.current;
  }

  /**
   * Changing the default clears any session override. Without that, editing the switch in App
   * Settings would appear to do nothing in a tab that had already toggled the menu item, which reads
   * as a broken setting rather than as precedence.
   */
  set showByDefault(value: boolean) {
    showByDefault.current = value;
    this.#sessionOverride = undefined;
  }

  /** Flips from whatever is in effect, so the first click always visibly changes something. */
  toggle() {
    this.#sessionOverride = !this.isEnabled;
  }

  clearSessionOverride() {
    this.#sessionOverride = undefined;
  }
}

export const faceOverlayManager = new FaceOverlayManager();
