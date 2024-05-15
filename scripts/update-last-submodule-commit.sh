#!/usr/bin/env bash
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)

cd "$SCRIPT_DIR/.."
pwd
git add index.js
git add dist/index.js
git commit --amend --no-edit
git push -f
cd "$SCRIPT_DIR/../.."
pwd
git add railway-pr-deploy
git commit --amend --no-edit
git push -f