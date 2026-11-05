# Test fixture only. Docker is not required by Nexo users.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && ! command -v node \
    && useradd --create-home --uid 10001 nexo
COPY --chown=nexo:nexo plugins/nexo /app
RUN chmod +x /app/bootstrap/nexo /app/bootstrap/nexo-linux-amd64 \
    && mkdir -p /home/nexo/.claude/plugins/data/nexo-nexo-marketplace \
    && chown -R nexo:nexo /home/nexo/.claude
USER nexo
WORKDIR /home/nexo
ENV CLAUDE_PLUGIN_ROOT=/app
ENV CLAUDE_PLUGIN_DATA=/home/nexo/.claude/plugins/data/nexo-nexo-marketplace
ENTRYPOINT ["/app/bootstrap/nexo"]
