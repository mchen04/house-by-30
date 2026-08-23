import { describe, expect, it } from "vitest";
import {
  canApplyPwaUpdate,
  reloadGuardAllows,
  UPDATE_RELOAD_GUARD_MS,
} from "./update-policy";

describe("automatic PWA updates", () => {
  it("waits for visible, durable work with no open editor", () => {
    expect(
      canApplyPwaUpdate({
        bufferedEdit: false,
        durabilityGap: false,
        visible: true,
      }),
    ).toBe(true);
    expect(
      canApplyPwaUpdate({
        bufferedEdit: true,
        durabilityGap: false,
        visible: true,
      }),
    ).toBe(false);
    expect(
      canApplyPwaUpdate({
        bufferedEdit: false,
        durabilityGap: true,
        visible: true,
      }),
    ).toBe(false);
    expect(
      canApplyPwaUpdate({
        bufferedEdit: false,
        durabilityGap: false,
        visible: false,
      }),
    ).toBe(false);
  });

  it("blocks a same-build reload loop for one guard window", () => {
    expect(reloadGuardAllows(null, 10_000)).toBe(true);
    expect(reloadGuardAllows("invalid", 10_000)).toBe(true);
    expect(reloadGuardAllows("10000", 10_001)).toBe(false);
    expect(reloadGuardAllows("10000", 10_000 + UPDATE_RELOAD_GUARD_MS)).toBe(
      true,
    );
  });
});
