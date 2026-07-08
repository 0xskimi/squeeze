import { WebHaptics } from 'web-haptics';

type HapticPreset = 'success' | 'error' | 'nudge' | 'light' | 'selection' | 'medium';

const prefersReducedMotion = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const haptics = WebHaptics.isSupported ? new WebHaptics() : null;

export function haptic(preset: HapticPreset) {
  if (!haptics || prefersReducedMotion()) return;
  void haptics.trigger(preset);
}
