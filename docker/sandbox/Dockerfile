FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash \
        ca-certificates \
        curl \
        git \
        maven \
        openjdk-17-jdk \
        openssh-client \
        python3 \
        python3-pip \
        ripgrep \
    && rm -rf /var/lib/apt/lists/*

RUN corepack enable

COPY docker/sandbox/entrypoint.sh /usr/local/bin/mini-agent-sandbox-entrypoint
RUN chmod +x /usr/local/bin/mini-agent-sandbox-entrypoint

WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/mini-agent-sandbox-entrypoint"]
