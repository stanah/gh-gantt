/**
 * Parse a hex color string to RGB components.
 * Supports #RGB and #RRGGBB formats.
 */
function parseHex(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.match(/^#?([\da-f]{3}|[\da-f]{6})$/i);
  if (!m) return null;
  const h = m[1];
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
    };
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

/**
 * Calculate relative luminance per WCAG 2.0.
 * Returns a value between 0 (black) and 1 (white).
 */
function relativeLuminance(r: number, g: number, b: number): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG 2.0 contrast ratio between two relative luminance values. */
function contrastRatio(l1: number, l2: number): number {
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

const LIGHT_TEXT = "#fff";
const DARK_TEXT = "#1E293B";
const LIGHT_LUM = 1.0;
const DARK_LUM = relativeLuminance(0x1e, 0x29, 0x3b);

/**
 * Determine whether text on a given background color should be light or dark.
 * Computes WCAG contrast ratio against both candidate text colors and returns
 * the one with the higher ratio.
 * Returns "#fff" for dark backgrounds, "#1E293B" for light backgrounds.
 */
export function contrastTextColor(bgHex: string): string {
  const rgb = parseHex(bgHex);
  if (!rgb) return DARK_TEXT;
  const bgLum = relativeLuminance(rgb.r, rgb.g, rgb.b);
  const lightRatio = contrastRatio(LIGHT_LUM, bgLum);
  const darkRatio = contrastRatio(DARK_LUM, bgLum);
  return lightRatio >= darkRatio ? LIGHT_TEXT : DARK_TEXT;
}
