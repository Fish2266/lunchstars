#!/bin/sh
# Build the game and publish dist/ to the gh-pages branch, which GitHub Pages serves.
# (Pages can't serve the raw source: browsers can't run src/main.ts directly.)
set -e
cd "$(dirname "$0")/.."
REMOTE=$(git remote get-url origin)
npm run build
cd dist
touch .nojekyll
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Deploy $(git -C .. rev-parse --short HEAD)"
git push -q -f "$REMOTE" gh-pages
rm -rf .git
echo "Deployed. It's live at the repo's Pages URL in a minute or so."
