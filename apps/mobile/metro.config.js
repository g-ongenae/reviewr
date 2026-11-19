// https://docs.expo.dev/guides/customizing-metro/
const { execFileSync } = require('node:child_process');
const { readBuildVersion } = require('@reviewr/shared');
const { getDefaultConfig } = require('expo/metro-config');

// Which commit is built, and when, read once when Metro starts. Expo compiles EXPO_PUBLIC_ variables into every
// bundle it serves, so a phone that keeps an old bundle keeps showing the old version.
process.env.EXPO_PUBLIC_BUILD_VERSION = JSON.stringify(
  readBuildVersion((args) =>
    execFileSync('git', args, { cwd: __dirname, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }),
  ),
);

module.exports = getDefaultConfig(__dirname);
