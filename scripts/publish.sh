#!/usr/bin/env bash
# Publishes the five @plannotator/byoa-* packages in dependency order.
# pnpm (not npm) must do the publish: it swaps publishConfig.exports to dist/
# and turns workspace:* into the real version. pnpm runs through npx, so it
# need not be installed. A version already on npm is skipped, so a run that
# stopped part way can be run again.
#   scripts/publish.sh
set -euo pipefail
cd "$(dirname "$0")/.."

pnpm() { npx --yes pnpm@10.34.3 "$@"; }

echo "node $(node -v), npm user: $(npm whoami)"
for dir in packages/protocol packages/server packages/connector-core connectors/pi connectors/opencode; do
	pkg=$(node -p "require('./$dir/package.json').name")
	version=$(node -p "require('./$dir/package.json').version")
	if npm view "$pkg@$version" version >/dev/null 2>&1; then
		echo "$pkg@$version is already on npm; skipping"
		continue
	fi
	read -r -p "npm one-time code for $pkg@$version (Enter if your account has none): " otp
	pnpm --filter "$pkg" publish --no-git-checks ${otp:+--otp=$otp}
done
echo "Published. Check: npm view @plannotator/byoa-server"
