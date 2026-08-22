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
});
