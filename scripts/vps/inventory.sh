#!/bin/sh
# Read-only. Execute remotely only after explicit SSH authorization and host-key verification.
set -eu
id
uname -sm
getconf _NPROCESSORS_ONLN
free -m
df -h /home/showwork
for executable in git node npm ffmpeg ffprobe; do
  command -v "$executable" || true
done
systemctl is-active fail2ban || true
systemctl is-active showwork-publishing || true
# Provider region and firewall policy require separately approved inspection.
# Never dump the environment, connection strings, secret files or service Environment properties.
