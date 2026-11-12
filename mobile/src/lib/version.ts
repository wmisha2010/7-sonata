// Single source of truth for the mobile app version.
//
// Everything else follows this file: the footer in the player imports it
// directly, and `npm run version:sync` (also run by `build:web`) rewrites
// mobile/package.json and mobile/android/app/build.gradle.
export const APP_VERSION = "1.8.8"
