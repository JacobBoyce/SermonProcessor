#!/bin/sh
# Cloudflare Pages build command: writes web/version.json so the site can show
# which commit is live. Cloudflare sets CF_PAGES_COMMIT_SHA and CF_PAGES_BRANCH.
set -e
cd "$(dirname "$0")/.."   # run from the repo root wherever it is called from
SHA="${CF_PAGES_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}"
BRANCH="${CF_PAGES_BRANCH:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)}"
REPO="${GITHUB_REPO:-JacobBoyce/SermonProcessor}"
BUILT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"sha":"%s","branch":"%s","repo":"%s","built":"%s"}\n' "$SHA" "$BRANCH" "$REPO" "$BUILT" > web/version.json
echo "Stamped web/version.json: $SHA ($BRANCH) at $BUILT"
# The web app shows the default Gemini instructions (greyed out) from this copy.
cp prompts/instructions.txt web/instructions.txt
echo "Copied prompts/instructions.txt to web/"
