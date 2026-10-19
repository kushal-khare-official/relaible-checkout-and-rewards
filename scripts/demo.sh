#!/usr/bin/env bash
# Executable walkthrough of the API's important behaviours against a running server.
#   docker compose up --build        (or npm run dev)
#   bash scripts/demo.sh             (BASE_URL defaults to http://localhost:3000)
# Uses curl and node (for JSON field extraction). Works best on a fresh database with the
# default reward rule (every 5th order, 10%).
# Portable: only POSIX/BSD-compatible tool flags, so it runs on macOS's default bash 3.2 too.
set -euo pipefail
BASE_URL=${BASE_URL:-http://localhost:3000}
JSON='content-type: application/json'

for tool in curl node; do
  command -v "$tool" >/dev/null || { echo "demo.sh needs '$tool' on PATH" >&2; exit 1; }
done
if ! curl -sf "$BASE_URL/health" >/dev/null; then
  echo "API not reachable at $BASE_URL (start it with: docker compose up --build)" >&2
  exit 1
fi

field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let j;try{j=JSON.parse(s)}catch{console.error("expected JSON, got: "+JSON.stringify(s.slice(0,200)));process.exit(1)}const v=process.argv[1].split(".").reduce((o,k)=>o?.[k],j);console.log(typeof v==="object"?JSON.stringify(v):v)})' "$1"; }
say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
call() { # method path [body] [extra curl args...] -> prints body, then the HTTP status on its own last line
  local method=$1 path=$2 body=${3:-}; shift 3 || shift $#
  if [[ -n "$body" ]]; then curl -s -X "$method" "$BASE_URL$path" -H "$JSON" -d "$body" -w '\n%{http_code}' "$@"
  else curl -s -X "$method" "$BASE_URL$path" -w '\n%{http_code}' "$@"; fi
}
# sed '$d' drops the status line; unlike `head -n -1` it works with BSD (macOS) tools.
show() { local out; out=$(cat); echo "HTTP $(tail -n1 <<<"$out")  $(sed '$d' <<<"$out" | head -c 400)"; }
body() { sed '$d'; }

say "Catalogue"
call GET /products | body | field items | head -c 600; echo

say "Create a cart, add 2 stickers and 3 caps (PUT sets an absolute quantity)"
CART=$(call POST /carts | body | field id)
call POST "/carts/$CART/items" '{"productId":"sticker","quantity":2}' >/dev/null
call PUT "/carts/$CART/items/cap" '{"quantity":3}' | show

say "Invalid input is rejected with distinguishable codes"
call POST "/carts/$CART/items" '{"productId":"tee","quantity":0}' | show
call POST "/carts/$CART/items" '{"productId":"nope","quantity":1}' | show
call POST "/carts/$CART/items" '{"productId":"sneaker-ltd","quantity":99}' | show

say "Checkout without an Idempotency-Key is refused"
call POST "/carts/$CART/checkout" "" | show

KEY="demo-$(date +%s)-$$-$RANDOM"
say "Checkout with Idempotency-Key $KEY"
call POST "/carts/$CART/checkout" "" -H "Idempotency-Key: $KEY" | show
say "Retry with the same key: same order replayed (see Idempotent-Replayed header), nothing charged twice"
curl -s -i -X POST "$BASE_URL/carts/$CART/checkout" -H "Idempotency-Key: $KEY" | grep -iE '^(HTTP|idempotent-replayed)'
say "Retry with a different key: the cart can only be checked out once"
call POST "/carts/$CART/checkout" "" -H "Idempotency-Key: $KEY-other" | show

say "Price drift: an admin raises the mug price after it was added to a cart"
DRIFT=$(call POST /carts | body | field id)
call PUT "/carts/$DRIFT/items/mug" '{"quantity":1}' >/dev/null
call PATCH /admin/products/mug '{"pricePaise":31900}' | show
call POST "/carts/$DRIFT/checkout" "" -H "Idempotency-Key: drift-$KEY" | show
call POST "/carts/$DRIFT/acknowledge-prices" "" | body | field items | head -c 300; echo
call POST "/carts/$DRIFT/checkout" "" -H "Idempotency-Key: drift-$KEY" | show
call PATCH /admin/products/mug '{"pricePaise":29900}' >/dev/null

say "Place orders until a reward milestone is reached, then generate a coupon"
COUPON=""
for _ in $(seq 1 10); do
  RES=$(call POST /admin/coupons "")
  if [[ $(tail -n1 <<<"$RES") == 201 ]]; then COUPON=$(body <<<"$RES" | field code); break; fi
  echo "  $(body <<<"$RES" | field detail)"
  C=$(call POST /carts | body | field id)
  call PUT "/carts/$C/items/tee" '{"quantity":1}' >/dev/null
  call POST "/carts/$C/checkout" "" -H "Idempotency-Key: fill-$C" >/dev/null
done
echo "coupon: $COUPON"

say "Two carts race for the same coupon: exactly one wins"
A=$(call POST /carts | body | field id); B=$(call POST /carts | body | field id)
call PUT "/carts/$A/items/hoodie" '{"quantity":1}' >/dev/null
call PUT "/carts/$B/items/hoodie" '{"quantity":1}' >/dev/null
call POST "/carts/$A/checkout" "{\"couponCode\":\"$COUPON\"}" -H "Idempotency-Key: race-a-$KEY" > /tmp/race-a.$$ &
call POST "/carts/$B/checkout" "{\"couponCode\":\"$COUPON\"}" -H "Idempotency-Key: race-b-$KEY" > /tmp/race-b.$$ &
wait
show < /tmp/race-a.$$; show < /tmp/race-b.$$; rm -f /tmp/race-a.$$ /tmp/race-b.$$

say "Ten buyers race for the limited sneakers (stock 3 on a fresh database)"
CARTS=()
for _ in $(seq 1 10); do
  C=$(call POST /carts | body | field id)
  call PUT "/carts/$C/items/sneaker-ltd" '{"quantity":1}' >/dev/null || true
  CARTS+=("$C")
done
for C in "${CARTS[@]}"; do
  curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE_URL/carts/$C/checkout" -H "Idempotency-Key: sneaker-$C" &
done | sort | uniq -c
wait

say "Admin report (read-only; reconciles with /admin/orders and /admin/coupons)"
call GET /admin/report | body
echo
