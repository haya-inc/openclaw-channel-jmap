#!/usr/bin/env bash
set -euo pipefail

readonly LAB_REALM="example.test"
readonly LAB_USERNAME="compat"
readonly LAB_PASSWORD="compat-password"
readonly ADMIN_USERNAME="admin"
readonly ADMIN_PASSWORD="admin-password"

mkdir -p \
  /var/lib/imap \
  /var/lib/imap/socket \
  /var/spool/imap \
  /run/cyrus
chown -R cyrus:mail /var/lib/imap /var/spool/imap /run/cyrus
chmod 0750 /var/lib/imap /var/spool/imap

/usr/cyrus/bin/mkimap /etc/imapd.conf
chown -R cyrus:mail /var/lib/imap /var/spool/imap

printf '%s' "${LAB_PASSWORD}" \
  | saslpasswd2 -p -c -u "${LAB_REALM}" "${LAB_USERNAME}"
printf '%s' "${ADMIN_PASSWORD}" \
  | saslpasswd2 -p -c -u "${LAB_REALM}" "${ADMIN_USERNAME}"
chown root:mail /etc/sasldb2
chmod 0640 /etc/sasldb2

/usr/local/bin/cyrus-lab-smtp-sink &

exec /usr/cyrus/bin/master \
  -D \
  -C /etc/imapd.conf \
  -M /etc/cyrus.conf
