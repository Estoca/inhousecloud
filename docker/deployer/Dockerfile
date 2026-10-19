# The image deploy jobs run in (runner label harness-deploy, docs/gitops-flow.md): the
# Docker CLI with Compose and Buildx, git, curl, python3 and the harness scripts, with
# harness-app on the PATH. install.sh assembles the build context in
# <install-dir>/deployer/ (this file plus scripts/ and templates/ of the harness) and
# builds it as <project>-deployer:local when the ci profile is on. Jobs get the Docker
# socket, the harness network and the install directory from the runner config.
FROM alpine:3.22
RUN apk add --no-cache bash python3 curl git ca-certificates coreutils tar \
      docker-cli docker-cli-compose docker-cli-buildx
COPY harness /opt/harness
RUN chmod 755 /opt/harness/scripts/*.sh \
 && ln -s /opt/harness/scripts/harness-app.sh /usr/local/bin/harness-app
ENV HARNESS_ENDPOINTS=internal
