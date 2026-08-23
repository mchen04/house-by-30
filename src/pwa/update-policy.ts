export const UPDATE_CHECK_COOLDOWN_MS = 30_000;
export const UPDATE_CHECK_INTERVAL_MS = 60 * 60 * 1_000;
export const UPDATE_RELOAD_GUARD_MS = 30_000;

export function canApplyPwaUpdate(input: {
  bufferedEdit: boolean;
  durabilityGap: boolean;
  visible: boolean;
}): boolean {
  return input.visible && !input.bufferedEdit && !input.durabilityGap;
}

export function reloadGuardAllows(
  priorReload: string | null,
  now: number,
): boolean {
  if (!priorReload) return true;
  const prior = Number(priorReload);
  return !Number.isFinite(prior) || now - prior >= UPDATE_RELOAD_GUARD_MS;
}
