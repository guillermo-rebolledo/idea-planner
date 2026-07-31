/**
 * The formatting the repo already used, now enforced.
 *
 * Tailwind class sorting reads the v4 CSS entry point (there is no
 * tailwind.config.js in Tailwind v4).
 *
 * @type {import('prettier').Config}
 */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'none',
  plugins: ['prettier-plugin-tailwindcss'],
  tailwindStylesheet: './app/src/renderer/src/styles.css'
}
