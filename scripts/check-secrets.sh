#!/usr/bin/env bash
# Fails if a live Stripe key, or a realistic test key / webhook secret, is committed.
set -euo pipefail
cd "$(dirname "$0")/.."
fail=0
if grep -R -E -n '(sk|rk)_live_[A-Za-z0-9]' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .; then
  echo "error: live Stripe key pattern found" >&2
  fail=1
fi
if grep -R -E -n '(sk|rk)_test_[A-Za-z0-9]{24,}' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .; then
  echo "error: realistic Stripe test key pattern found" >&2
  fail=1
fi
if grep -R -E -n 'whsec_[A-Za-z0-9]{24,}' --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.git .; then
  echo "error: realistic webhook secret pattern found" >&2
  fail=1
fi
exit "$fail"
