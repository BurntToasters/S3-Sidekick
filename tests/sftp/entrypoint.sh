#!/bin/sh
# Starts the test-only sshd fleet. Host keys are generated per container, so no
# server key is stored in the repository. The runner supplies the test user and
# password through the environment, and installs the client keys afterwards.
set -eu

KEY_DIR=/etc/ssh/e2e
: "${E2E_SFTP_USER:?E2E_SFTP_USER must be set}"
: "${E2E_SFTP_PASSWORD:?E2E_SFTP_PASSWORD must be set}"

mkdir -p "$KEY_DIR" /run/sshd
ssh-keygen -q -t ed25519 -N '' -f "$KEY_DIR/main_ed25519"
ssh-keygen -q -t ecdsa -b 256 -N '' -f "$KEY_DIR/main_ecdsa"
ssh-keygen -q -t ed25519 -N '' -f "$KEY_DIR/alt_ed25519"
ssh-keygen -q -t ed25519 -N '' -f "$KEY_DIR/partial_ed25519"
ssh-keygen -q -t rsa -b 3072 -N '' -f "$KEY_DIR/rsa"

useradd --create-home --shell /bin/sh "$E2E_SFTP_USER"
echo "$E2E_SFTP_USER:$E2E_SFTP_PASSWORD" | chpasswd
install -d -m 700 -o "$E2E_SFTP_USER" -g "$E2E_SFTP_USER" "/home/$E2E_SFTP_USER/.ssh"

for config in main rsa alt partial nolink; do
  /usr/sbin/sshd -t -f "$KEY_DIR/$config.conf"
done

/usr/sbin/sshd -D -e -f "$KEY_DIR/main.conf" &
/usr/sbin/sshd -D -e -f "$KEY_DIR/rsa.conf" &
/usr/sbin/sshd -D -e -f "$KEY_DIR/alt.conf" &
/usr/sbin/sshd -D -e -f "$KEY_DIR/partial.conf" &
/usr/sbin/sshd -D -e -f "$KEY_DIR/nolink.conf" &
wait
