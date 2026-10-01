FROM postgres:17-alpine
ARG MC_VERSION=RELEASE.2025-08-13T08-35-41Z
ARG MC_SHA256=01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891
RUN apk add --no-cache restic curl ca-certificates \
  && curl -fsSL "https://github.com/minio/mc/releases/download/${MC_VERSION}/mc.linux-amd64.${MC_VERSION}" -o /usr/local/bin/mc \
  && echo "${MC_SHA256}  /usr/local/bin/mc" | sha256sum -c - \
  && chmod 0755 /usr/local/bin/mc
COPY backup.sh restore.sh backup-loop.sh /ops/
RUN chmod 0755 /ops/*.sh
ENTRYPOINT ["/ops/backup-loop.sh"]
