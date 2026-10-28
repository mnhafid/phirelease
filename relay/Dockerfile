# Alert relay: Windows bot --dumbpipe (iroh)--> this container --> Telegram.
FROM node:22-slim

ARG DUMBPIPE_VERSION=v0.40.1
ARG TARGETARCH
RUN set -e; \
    case "$TARGETARCH" in arm64) arch=aarch64 ;; *) arch=x86_64 ;; esac; \
    cd /tmp; \
    node -e "fetch(process.argv[1]).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer() }).then(b => require('fs').writeFileSync('dp.tgz', Buffer.from(b)))" \
      "https://github.com/n0-computer/dumbpipe/releases/download/${DUMBPIPE_VERSION}/dumbpipe-${DUMBPIPE_VERSION}-linux-${arch}.tar.gz"; \
    tar xzf dp.tgz; \
    install -m 755 "$(find /tmp -name dumbpipe -type f | head -1)" /usr/local/bin/dumbpipe; \
    rm -rf /tmp/*

COPY telegram-relay.js /app/telegram-relay.js

# Two processes: if either dies, exit so Docker's restart policy restarts both.
CMD ["bash", "-c", "dumbpipe listen-tcp --host 127.0.0.1:7879 & node /app/telegram-relay.js & wait -n; exit 1"]
