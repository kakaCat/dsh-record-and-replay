# Build the bundled context: docker build -f docker/Dockerfile docker
FROM debian:bookworm-slim

SHELL ["/bin/bash", "-o", "pipefail", "-c"]
ARG DEBIAN_FRONTEND=noninteractive

# Retry transient mirror/proxy failures, and cache the small bootstrap separately
# from the much larger browser/desktop layer.
RUN apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access update \
    && apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access install -y --no-install-recommends \
        ca-certificates curl gnupg \
    && rm -rf /var/lib/apt/lists/*

# Google does not publish Chrome for Linux ARM64; use Debian Chromium there.
# Both browser packages are root-owned and use Cua's isolated-profile launch.
ARG TARGETARCH
RUN install -d -m 0755 /etc/apt/keyrings \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        curl --retry 5 --retry-all-errors -fsSL https://dl.google.com/linux/linux_signing_key.pub \
            | gpg --dearmor -o /etc/apt/keyrings/google-chrome.gpg \
        && chmod 0644 /etc/apt/keyrings/google-chrome.gpg \
        && echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
            > /etc/apt/sources.list.d/google-chrome.list; \
       fi \
    && for source in /etc/apt/sources.list /etc/apt/sources.list.d/*.sources /etc/apt/sources.list.d/*.list; do \
        if [ -f "$source" ]; then sed -i 's|http://deb.debian.org|https://deb.debian.org|g; s|http://security.debian.org|https://security.debian.org|g' "$source"; fi; \
       done \
    && apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access update \
    && apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access install -y --no-install-recommends \
        at-spi2-core \
        dbus \
        dbus-x11 \
        ffmpeg \
        fonts-dejavu-core \
        fonts-liberation \
        fonts-noto-cjk \
        fonts-noto-color-emoji \
        libatk-bridge2.0-0 \
        libatspi2.0-0 \
        openbox \
        procps \
        python3 \
        tar \
        x11-utils \
        xauth \
        xvfb \
    && if [ "$TARGETARCH" = "amd64" ]; then \
        apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access install -y --no-install-recommends google-chrome-stable; \
       elif [ "$TARGETARCH" = "arm64" ]; then \
        apt-get -o Acquire::Retries=10 -o Acquire::Queue-Mode=access install -y --no-install-recommends chromium; \
       else \
        echo "Unsupported Docker TARGETARCH: $TARGETARCH" >&2; exit 2; \
       fi \
    && rm -rf /var/lib/apt/lists/*

# Keep the payload outside the mutable home volume so it cannot hide the CLI.
ARG CUA_DRIVER_RS_VERSION=0.38.0
RUN export CUA_DRIVER_RS_VERSION="${CUA_DRIVER_RS_VERSION}" \
        CUA_DRIVER_RS_HOME=/opt/cua-driver \
        CUA_DRIVER_RS_NO_MODIFY_PATH=1 \
        CUA_DRIVER_RS_TELEMETRY_ENABLED=0; \
    curl --retry 5 --retry-all-errors -fsSL https://cua.ai/driver/install.sh \
        | bash -s -- --bin-dir /usr/local/bin --no-modify-path

# The runtime user owns only mutable state and output locations.
RUN groupadd --gid 1000 cua \
    && useradd --uid 1000 --gid cua --home-dir /var/lib/cua --create-home --shell /bin/bash cua \
    && mkdir -p /out /var/lib/cua/.cua-driver \
    && chown -R cua:cua /var/lib/cua /out

COPY entrypoint.sh /usr/local/bin/dsh-record-replay-entrypoint
RUN chmod 0755 /usr/local/bin/dsh-record-replay-entrypoint

ENV HOME=/var/lib/cua \
    DISPLAY=:99 \
    CUA_DRIVER_RS_UPDATE_CHECK=false \
    CUA_DRIVER_RS_HOME=/var/lib/cua/.cua-driver \
    XDG_RUNTIME_DIR=/tmp/runtime-cua

USER cua
WORKDIR /var/lib/cua
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/local/bin/dsh-record-replay-entrypoint"]
CMD ["sleep", "infinity"]
