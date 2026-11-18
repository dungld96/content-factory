#!/bin/sh
# SeaweedFS (S3 API) for asset bytes: local development, CI and staging (M4a, ADR-0006).
# Writes the S3 identity config from the environment, then runs a single-node server.
# Identities: an admin key (bucket setup only) and the application key (read/write/list).
# SeaweedFS's simple identities cannot deny delete to a writer; the application never deletes
# and writes are conditional (If-None-Match: *), see packages/storage.
set -eu
: "${STORAGE_ADMIN_ACCESS_KEY_ID:?}" "${STORAGE_ADMIN_SECRET_ACCESS_KEY:?}"
: "${S3_ACCESS_KEY_ID:?}" "${S3_SECRET_ACCESS_KEY:?}"
umask 077
cat > /tmp/s3.json <<JSON
{
  "identities": [
    {
      "name": "acf-storage-admin",
      "credentials": [{ "accessKey": "${STORAGE_ADMIN_ACCESS_KEY_ID}", "secretKey": "${STORAGE_ADMIN_SECRET_ACCESS_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List"]
    },
    {
      "name": "acf-app",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY_ID}", "secretKey": "${S3_SECRET_ACCESS_KEY}" }],
      "actions": ["Read", "Write", "List"]
    }
  ]
}
JSON
exec weed server -dir=/data -volume.max=0 -master.volumeSizeLimitMB=1024 \
  -s3 -s3.port=8333 -s3.config=/tmp/s3.json
