import material from './material.json' with { type: 'json' };

export const DEFAULT_APPEARANCE = Object.freeze({ materialVersion: 2, surface: 'white', font: 'system', fontSize: 16, lineHeight: 1.8, ratio: 50, milk: material.milk, softLight: material.softLight });

export function frostValue(value) {
  return Number.isFinite(value) ? Math.min(100, Math.max(35, value)) : 65;
}

export function glassAlpha(frost) {
  const amount = 1 - (1 - (frostValue(frost) - 35) / 65) ** material.frostCurve;
  return Math.round(material.nativeGlassAlphaMin + (material.nativeGlassAlphaMax - material.nativeGlassAlphaMin) * amount);
}

export function cleanAppearance(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) input = {};
  const bounded = (value, low, high, fallback) => Number.isFinite(value) ? Math.min(high, Math.max(low, value)) : fallback;
  const current = input.materialVersion === 2;
  return { materialVersion: 2, surface: input.surface === 'glass' ? 'glass' : 'white', font: input.font === 'serif' ? 'serif' : 'system',
    fontSize: bounded(input.fontSize, 12, 24, 16), lineHeight: [1.5, 1.8, 2.1].includes(input.lineHeight) ? input.lineHeight : 1.8,
    ratio: bounded(input.ratio, 35, 65, 50), milk: current ? bounded(input.milk, 0, 80, material.milk) : material.milk,
    softLight: current ? bounded(input.softLight, 0, 80, material.softLight) : material.softLight };
}

export function glassStyle(input) {
  const value = cleanAppearance(input);
  return { '--glass-base': value.milk / 100, '--glass-light': value.softLight / 100,
    '--glass-reader': material.readerWhite / 100, '--glass-popup': .9, '--glass-blur': `${material.popoverBlurPx}px` };
}

