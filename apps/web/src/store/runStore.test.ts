import { beforeEach, describe, expect, it } from "vitest";
import { useRunStore } from "./runStore.ts";

beforeEach(() => {
  useRunStore.getState().reset();
});

describe("runStore preview nonces", () => {
  it("bumps the ready nonce only for readiness", () => {
    useRunStore.getState().markPreviewReady();

    const state = useRunStore.getState();
    expect(state.readyNonce).toBe(1);
    expect(state.contentNonce).toBe(0);
  });

  it("bumps the content nonce when files change under a live run", () => {
    useRunStore.getState().markPreviewContentChanged();
    useRunStore.getState().markPreviewContentChanged();

    const state = useRunStore.getState();
    expect(state.contentNonce).toBe(2);
    expect(state.readyNonce).toBe(0);
  });

  it("clears both on reset", () => {
    useRunStore.getState().markPreviewReady();
    useRunStore.getState().markPreviewContentChanged();

    useRunStore.getState().reset();

    const state = useRunStore.getState();
    expect(state.readyNonce).toBe(0);
    expect(state.contentNonce).toBe(0);
    expect(state.state.status).toBe("idle");
  });

  describe("preview health", () => {
    it("records a dev-server error until recovery", () => {
      useRunStore.getState().setPreviewError(500);
      expect(useRunStore.getState().previewError).toBe(500);

      useRunStore.getState().setPreviewError(null);
      expect(useRunStore.getState().previewError).toBeNull();
    });

    /** A restart is a fresh dev server; a stale error must not linger over
     *  the pane while the new one comes up. */
    it("clears the error when the preview becomes ready again", () => {
      useRunStore.getState().setPreviewError(500);

      useRunStore.getState().markPreviewReady();

      expect(useRunStore.getState().previewError).toBeNull();
    });

    it("clears the error on reset", () => {
      useRunStore.getState().setPreviewError(500);

      useRunStore.getState().reset();

      expect(useRunStore.getState().previewError).toBeNull();
    });
  });
});
