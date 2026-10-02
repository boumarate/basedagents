#!/usr/bin/env bash
# Publish one npm workspace unless its package.json version is already on the
# registry. Used by .github/workflows/publish.yml (trusted publishing: no
# token — the job's OIDC identity is the credential), and safe to run by hand
# from a logged-in shell:  scripts/publish-if-unpublished.sh packages/sdk
set -euo pipefail

workspace="${1:?usage: publish-if-unpublished.sh <workspace dir>}"
name=$(node -p "require('./${workspace}/package.json').name")
version=$(node -p "require('./${workspace}/package.json').version")

if npm view "${name}@${version}" version >/dev/null 2>&1; then
  echo "${name}@${version} is already published — nothing to do"
  exit 0
fi

echo "publishing ${name}@${version}"
# prepublishOnly builds the workspace; --provenance is implied by trusted
# publishing and harmless with a token.
npm publish --workspace="${workspace}"

# The registry answers "Your package is being processed and may take a few
# minutes to become available" — a `npm view` straight after publish 404s
# even though the publish succeeded. Poll before declaring failure.
for attempt in $(seq 1 20); do
  if npm view "${name}@${version}" version >/dev/null 2>&1; then
    echo "${name}@${version} is live on the registry"
    exit 0
  fi
  echo "waiting for ${name}@${version} to appear on the registry (${attempt}/20)"
  sleep 15
done
echo "${name}@${version} was published but is not visible after 5 minutes" >&2
exit 1
