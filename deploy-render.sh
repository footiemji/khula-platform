#!/usr/bin/env bash
# Gets this project onto GitHub and prints the exact Render dashboard steps
# to finish deployment. Run from inside the khula-platform/ folder.
#
# Usage:
#   chmod +x deploy-render.sh
#   ./deploy-render.sh
#
# Requires: git, and either the GitHub CLI (`gh`) or a GitHub account you'll
# create the repo on manually (the script tells you which path it's using).

set -e

REPO_NAME="khula-platform"

echo "== Khula Financial Services — Render deploy prep =="
echo

if [ ! -f "package.json" ]; then
  echo "Run this script from inside the khula-platform/ folder (where package.json lives)."
  exit 1
fi

if [ ! -d ".git" ]; then
  echo "-> Initializing git repo..."
  git init -q
fi

git add .
git commit -q -m "Khula Financial Services MVP" 2>/dev/null || echo "-> Nothing new to commit."

if command -v gh >/dev/null 2>&1; then
  echo "-> GitHub CLI found. Creating and pushing to a private repo..."
  gh repo create "$REPO_NAME" --private --source=. --remote=origin --push
  REPO_URL=$(gh repo view --json url -q .url)
  echo
  echo "Pushed to: $REPO_URL"
else
  echo "-> GitHub CLI (gh) not found. Manual step required:"
  echo "   1. Go to https://github.com/new and create a repo named '$REPO_NAME' (private is fine)."
  echo "   2. Then run:"
  echo "        git remote add origin https://github.com/YOUR_USERNAME/$REPO_NAME.git"
  echo "        git branch -M main"
  echo "        git push -u origin main"
fi

echo
echo "== Next: finish the deploy on Render (about 5 minutes) =="
echo "1. Go to https://dashboard.render.com and sign up (no card needed for the free plan)."
echo "2. Click 'New' > 'Blueprint', and select the repo you just pushed."
echo "   Render will detect render.yaml in this repo automatically and configure the service."
echo "3. Before clicking Deploy, generate your admin password hash locally:"
echo "     npm run seed:admin -- \"YourStrongPassword123!\""
echo "   Copy the printed hash into the ADMIN_PASSWORD_HASH field in Render's env var editor."
echo "4. Click Deploy. Render will build the Docker image and give you a live URL, e.g.:"
echo "     https://khula-financial-services.onrender.com"
echo "5. Open that URL — your borrower chat widget is live. Admin console is at /admin.html."
echo
echo "Note: on the free plan, the app sleeps after 15 min idle (next visit takes ~1 min to wake"
echo "up) and application data resets on restart/redeploy — fine for tonight's demo. See"
echo "docs/DEPLOY.md for how to move to Railway or a VPS once you're ready to keep real data."
