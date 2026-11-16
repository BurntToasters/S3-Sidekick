# Test-only OpenSSH fleet for the S3 Sidekick SFTP E2E suite. Never ship this image.
# The base image is pinned by digest. openssh-server comes from the Debian archive
# at build time and is not pinned; the runner writes the installed package
# version into test-results/sftp-e2e/report.json. Resolve a new digest with
# `docker pull debian:bookworm-slim` and `docker image inspect`, then update both
# this line and BASE_IMAGE in scripts/e2e-sftp.mjs.
FROM debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends openssh-server procps \
 && rm -rf /var/lib/apt/lists/* \
 && sed -i 's/^\(session[[:space:]]\+[a-z]\+[[:space:]]\+pam_loginuid\.so\)/# \1/' /etc/pam.d/sshd \
 && mkdir -p /etc/ssh/e2e /run/sshd

COPY sshd/ /etc/ssh/e2e/
COPY entrypoint.sh /usr/local/bin/e2e-sftp-entrypoint
RUN chmod 0755 /usr/local/bin/e2e-sftp-entrypoint

# main, rsa, alt, partial, nolink. See sshd/*.conf for what each port exercises.
EXPOSE 12222 12223 12224 12225 12226

ENTRYPOINT ["/usr/local/bin/e2e-sftp-entrypoint"]
