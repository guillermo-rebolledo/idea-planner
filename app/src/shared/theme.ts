/**
 * The one piece of the visual identity that cannot live in the stylesheet.
 *
 * The window exists before the Renderer has painted anything, and a window
 * that starts white in a dark theme flashes on every launch and every theme
 * change. Main paints it with the theme's own page colour instead, which is
 * why the value is stated here rather than in `styles.css` — and why
 * `theme.test.ts` fails if the two ever stop agreeing.
 */
export const WINDOW_BACKGROUND = {
  light: '#f4f4f6',
  dark: '#0e0f11'
} as const

export type ResolvedTheme = keyof typeof WINDOW_BACKGROUND
