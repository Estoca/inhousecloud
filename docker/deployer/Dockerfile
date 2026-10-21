# The image deploy jobs run in (runner label ihc-deploy, docs/gitops-flow.md): the
# Docker CLI with Compose and Buildx, git, curl, python3 and the cloud scripts, with
# ihc-app on the PATH. install.sh assembles the build context in
# <install-dir>/deployer/ (this file plus scripts/ and templates/ of the cloud) and
# builds it as <project>-deployer:local on every foundation run. Jobs get the Docker
# socket, the ihc network and the install directory from the runner config.
FROM alpine:3.22
RUN apk add --no-cache bash python3 curl git ca-certificates coreutils tar \
      docker-cli docker-cli-compose docker-cli-buildx
COPY ihc /opt/ihc
RUN chmod 755 /opt/ihc/scripts/*.sh \
 && ln -s /opt/ihc/scripts/ihc-app.sh /usr/local/bin/ihc-app
ENV IHC_ENDPOINTS=internal
