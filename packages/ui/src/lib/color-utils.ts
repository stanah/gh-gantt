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

/**
 * Determine whether text on a given background color should be light or dark.
 * Uses WCAG relative luminance with a threshold of 0.179.
 * Returns "#fff" for dark backgrounds, "#1E293B" for light backgrounds.
 */
export function contrastTextColor(bgHex: string): string {
  const rgb = parseHex(bgHex);
  if (!rgb) return "#1E293B";
  const lum = relativeLuminance(rgb.r, rgb.g, rgb.b);
  return lum > 0.36 ? "#1E293B" : "#fff";
}
