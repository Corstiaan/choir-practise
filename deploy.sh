#!/usr/bin/env bash
# Upload site/ to the web host.   Usage:  bash deploy.sh
#
# Files are copied over what is there. Nothing on the server is deleted, so a
# server-side .htaccess / .htpasswd survives, and so do files that were removed
# locally (delete those by hand).
set -euo pipefail

HOST="${DEPLOY_HOST:-corstiaannl@corstk.ssh.transip.me}"
DEST="${DEPLOY_DEST:-/data/sites/web/corstiaannl/subdomains/pitch/practice_fw}"
KEY="${DEPLOY_KEY:-$HOME/.ssh/id_rsa_deploy}"
URL="${DEPLOY_URL:-https://pitch.corstiaan.nl/practice_fw/}"

cd "$(dirname "$0")"
[ -f site/index.html ] || { echo "site/index.html not found" >&2; exit 1; }

SSH=(ssh -i "$KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o LogLevel=ERROR "$HOST")

count=$(find site -type f ! -name '.htaccess*' ! -name '.htpasswd' | wc -l)
echo "Uploading $count files to $HOST:$DEST"

tar -C site --exclude='.htaccess*' --exclude='.htpasswd' -czf - . \
  | "${SSH[@]}" "mkdir -p '$DEST' && tar -C '$DEST' -xzf - --no-same-owner --no-same-permissions"

echo "Done: $URL"
