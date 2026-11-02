#!/usr/bin/env bash
# Capture what an Aeon user really sees: install the pack from GitHub into a fresh Aeon main, read the live vault.
# Usage: scripts/aeon_capture.sh <out.json> [vault]
set -euo pipefail
OUT="$1"
VAULT="${2:-0xf9322f1546de5a121cdc09522e70af79e30e4097}"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

git clone -q --depth 1 https://github.com/aeonfun/aeon.git "$WORK/aeon"
cd "$WORK/aeon"
AEON_SHA=$(git rev-parse --short HEAD)
INSTALL=$(bin/install-skill-pack vaubandev/vauban --path aeon 2>&1)
STATUS=$(node skills/vauban-vault/status.mjs "$VAULT")
LISTED=$(grep -c '"repo": "vaubandev/vauban"' catalog/skill-packs.json)

INSTALL="$INSTALL" STATUS="$STATUS" node -e '
const pick = (s, re) => s.split("\n").filter((l) => re.test(l)).map((l) => l.trimEnd());
const out = {
  aeonMain: process.argv[1], vault: process.argv[2], listed: process.argv[3] === "1",
  install: pick(process.env.INSTALL, /security scan|added to aeon.yml|Done:/),
  status: pick(process.env.STATUS, /^# Vauban vault|^Block |^- (Owner|Agent|Frozen|Revision|Gate delay)/),
};
require("fs").writeFileSync(process.argv[4], JSON.stringify(out, null, 2) + "\n");
console.log(JSON.stringify(out, null, 2));
' "$AEON_SHA" "$VAULT" "$LISTED" "$OUT"
