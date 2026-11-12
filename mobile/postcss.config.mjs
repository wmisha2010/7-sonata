// The mobile app builds its CSS with @tailwindcss/vite (see vite.config.ts),
// so no PostCSS plugins are needed here. This file exists so Vite stops
// walking up and picking the desktop project's postcss.config.mjs
// (@tailwindcss/postcss), which is not installed in mobile/node_modules and
// makes `vite build` fail with "Invalid PostCSS Plugin".
export default { plugins: {} }
