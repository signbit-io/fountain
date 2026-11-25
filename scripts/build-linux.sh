#!/usr/bin/env bash
# Build Fountain for Linux (AppImage + .deb) in Docker, from a release TAG's tree rather than the working
# copy, so the binaries are exactly what the public repo holds at that tag.
#
#   bash scripts/build-linux.sh v0.6.5
#
# Output in dist-linux/<tag>/: fountain-x86_64.AppImage, fountain-amd64.deb and SHA256SUMS, named like the
# release's fountain.exe and fountain.apk.
#
# The .deb's PACKAGE name is set to `signbit-fountain` here (from 0.6.6; user, 2026-11-12). Tauri derives it
# from productName and splits "SignBit" into `sign-bit-fountain`, which is what 0.6.5 shipped as. Not plain
# `fountain`: a package name shares one namespace with every distro package, and the brand prefix keeps it
# unique and findable with `apt search signbit`. There is no config field for it, so the built package is
# unpacked, its control file's `Package:` line changed, and it is packed again. tauri.conf.json's
# bundle.linux.deb conflicts/replaces `sign-bit-fountain`, so installing 0.6.6 over 0.6.5 swaps the old
# package out instead of failing on the files both own. Needs Docker running. The image (scripts/linux/Dockerfile) is
# built once and cached; Cargo's registry is kept in a named volume so a rebuild doesn't download it again.
set -euo pipefail
TAG="${1:?usage: bash scripts/build-linux.sh <tag>, e.g. v0.6.5}"
cd "$(dirname "$0")/.."
git rev-parse -q --verify "refs/tags/$TAG" >/dev/null || { echo "no tag $TAG"; exit 1; }

OUT="dist-linux/$TAG"
mkdir -p "$OUT"
# Docker on Windows wants C:/... for a bind mount; elsewhere the plain path is fine.
HOST_OUT="$(cygpath -m "$PWD/$OUT" 2>/dev/null || echo "$PWD/$OUT")"
IMAGE=fountain-linux-build

docker build -t "$IMAGE" scripts/linux
git archive --format=tar "$TAG" | MSYS_NO_PATHCONV=1 docker run -i --rm \
  -v fountain-cargo-registry:/usr/local/cargo/registry \
  -v "$HOST_OUT:/out" \
  "$IMAGE" bash -euo pipefail -c '
    tar -x -C /src
    npm ci --no-audit --no-fund
    npx tauri build --bundles appimage,deb
    b=src-tauri/target/release/bundle
    cp $b/appimage/*.AppImage /out/fountain-x86_64.AppImage
    rm -rf /tmp/debroot && dpkg-deb -R $b/deb/*.deb /tmp/debroot
    sed -i "s/^Package: .*/Package: signbit-fountain/" /tmp/debroot/DEBIAN/control
    grep -q "^Package: signbit-fountain$" /tmp/debroot/DEBIAN/control
    dpkg-deb --root-owner-group --build /tmp/debroot /out/fountain-amd64.deb
    dpkg-deb -f /out/fountain-amd64.deb Package Version Conflicts Replaces
    cd /out && sha256sum fountain-x86_64.AppImage fountain-amd64.deb > SHA256SUMS && cat SHA256SUMS'
echo "built $TAG into $OUT"
