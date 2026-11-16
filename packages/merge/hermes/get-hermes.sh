#!/usr/bin/env bash
# Builds the Hermes VM (`hermes`) and compiler (`hermesc`) that React Native 0.88 ships, from the official source.
#
# The version, commit and source checksum are in hermes.env. That release only publishes the compiler (npm) and the iOS /
# Android libraries (Maven): there is no standalone Linux VM to download, so it is built here from the tag's source
# tarball, checked against its SHA-256. Intl is on, as React Native builds it for Android and iOS.
#
# Usage: get-hermes.sh [destination]  (default: packages/merge/.hermes)
# Needs cmake (>= 3.21), ninja, a C++ compiler and the ICU headers, 65 or later (Debian / Ubuntu: libicu-dev).
# ICU_ROOT may point to an ICU outside the system paths. Takes a few minutes on 4 cores; the result is about 15 MB.
set -euo pipefail

# shellcheck source=hermes.env
source "$(dirname "$0")/hermes.env"
version=$HERMES_VERSION
commit=$HERMES_COMMIT
sha256=$HERMES_SHA256

destination=${1:-$(cd "$(dirname "$0")/.." && pwd)/.hermes}
bin="$destination/$version/bin"
if [[ -x "$bin/hermes" && -x "$bin/hermesc" ]]; then
  echo "Hermes $version is already in $bin"
  exit 0
fi

work="$destination/$version/work"
mkdir -p "$work"
curl --fail --location --silent --show-error --output "$work/src.tar.gz" \
  "https://github.com/facebook/hermes/archive/$commit.tar.gz"
echo "$sha256  $work/src.tar.gz" | sha256sum --check --strict
rm -rf "$work/src"
mkdir "$work/src"
tar -xzf "$work/src.tar.gz" -C "$work/src" --strip-components=1

cmake -S "$work/src" -B "$work/build" -G Ninja -Wno-dev \
  -DCMAKE_BUILD_TYPE=Release \
  -DHERMES_ENABLE_DEBUGGER=OFF \
  -DHERMES_ENABLE_INTL=ON \
  -DHERMES_ENABLE_TEST_SUITE=OFF \
  ${ICU_ROOT:+-DICU_ROOT="$ICU_ROOT"}
cmake --build "$work/build" --target hermes hermesc

mkdir -p "$bin"
cp "$work/build/bin/hermes" "$work/build/bin/hermesc" "$bin/"
rm -rf "$work"
"$bin/hermes" -version | grep 'Hermes release version'
echo "Hermes $version is in $bin"
