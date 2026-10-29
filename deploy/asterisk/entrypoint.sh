#!/bin/sh
# Starts Asterisk in the foreground and, beside it, writes the lines'
# registration state every 30 seconds for the voice app to read.
set -eu

mkdir -p /var/run/asterisk/nexus
chown -R asterisk:asterisk /var/run/asterisk

(
  while sleep 30; do
    if asterisk -rx "pjsip show registrations" > /var/run/asterisk/nexus/registrations.tmp 2>/dev/null; then
      mv /var/run/asterisk/nexus/registrations.tmp /var/run/asterisk/nexus/registrations.txt
    fi
  done
) &

exec asterisk -f -U asterisk -G asterisk -vvv
