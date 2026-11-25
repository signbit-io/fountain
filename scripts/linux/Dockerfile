# The Linux build environment for Fountain (AppImage + .deb), used by scripts/build-linux.sh.
#
# Ubuntu 22.04 on purpose: an AppImage runs on distributions with the same or a NEWER glibc than the
# one it was built against, so building on an older base reaches more desktops (22.04 has glibc 2.35).
# The packages are the ones Tauri 2 lists for Debian/Ubuntu (tauri.app, "Prerequisites"), plus xdg-utils:
# the AppImage step copies /usr/bin/xdg-open in for the opener plugin and fails without it.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends \
      build-essential curl wget file ca-certificates git xz-utils \
      libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

# Node 22, the same major as the Windows and Android builds.
ARG NODE_VERSION=22.15.0
RUN curl -fsSL https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz \
      | tar -xJ -C /usr/local --strip-components=1

# Rust, pinned to the release the Windows build used.
ARG RUST_VERSION=1.96.1
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain ${RUST_VERSION}

# Tauri's AppImage step runs linuxdeploy, itself an AppImage; containers have no FUSE, so it unpacks
# and runs instead.
ENV APPIMAGE_EXTRACT_AND_RUN=1
WORKDIR /src
