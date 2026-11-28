#!/bin/sh
# Build configured packages on the release Mac. The origin verifies each file before publishing the signed manifest.
set -eu
cd "$(dirname "$0")/.."
[ "$(uname -s)" = Darwin ] || { echo 'Build all three configured installers on the release Mac.' >&2; exit 1; }
npm test
npm run build:configured -- --mac --arm64
npm run build:configured -- --mac --x64
npm run build:configured -- --win --x64
codesign --verify --deep --strict 'dist/mac-arm64/Veyro Mail.app'
codesign --verify --deep --strict 'dist/mac/Veyro Mail.app'
npm run release:sign
release_token=${VEYRO_RELEASE_TOKEN_FILE:-"$HOME/Library/Application Support/Veyro Release/desktop-publisher-token"}
python3 ../origin/transfer/signed_transfer.py publish "$release_token" dist
