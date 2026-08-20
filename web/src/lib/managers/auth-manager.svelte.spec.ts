import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

describe('AuthManager', () => {
  describe('SessionLocked', () => {
    // The singleton subscribes in its constructor, which has already run by the time this file is
    // imported, so the event is emitted against the live instance rather than a fresh one.
    it('drops elevation as soon as the session is locked', () => {
      authManager.isElevated = true;

      eventManager.emit('SessionLocked');

      expect(authManager.isElevated).toBe(false);
    });

    // The bug this pins: only `SessionDelete` was subscribed, so locking left the flag true until the
    // expiry timer fired or a navigation re-checked - up to a full elevation window of the UI drawing
    // its elevated branch after the user explicitly locked. Locked albums stayed listed and
    // `AlbumCover` kept choosing the real thumbnail over `LockedCover`.
    it('does not wait for the expiry timer to notice', () => {
      vi.useFakeTimers();
      try {
        authManager.isElevated = true;

        eventManager.emit('SessionLocked');
        expect(authManager.isElevated).toBe(false);

        // Nothing pending should be able to flip it back, either.
        vi.runAllTimers();
        expect(authManager.isElevated).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
