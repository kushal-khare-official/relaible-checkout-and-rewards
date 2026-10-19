# Reliable Checkout & Rewards

An ecommerce checkout backend: carts, checkout, orders, and a reward that unlocks an `x%` coupon after every `n`-th placed order. It is built to stay correct when requests are retried, raced, or interleaved with price and stock changes.

- **Stack:** TypeScript (Node 22), Fastify 5, Zod, PostgreSQL 16, Kysely, Vitest + Testcontainers.
- **Design rationale, invariants and concurrency strategy:** [`DECISIONS.md`](DECISIONS.md).
- **API contract:** interactive at `/docs` when running; static at [`docs/openapi.json`](docs/openapi.json).
- **Demo client:** `/` (a single static page that drives the API and logs every response).

## Quick start (Docker)

```bash
docker compose up --build
```

| URL                          | What                                                                               |
| ---------------------------- | ---------------------------------------------------------------------------------- |
| http://localhost:3000/       | Demo page: catalogue, cart, checkout (with "retry same request"), race demo, admin |
| http://localhost:3000/docs   | Swagger UI                                                                         |
| http://localhost:3000/health | Liveness                                                                           |

On boot the API applies migrations and seeds six products, including `sneaker-ltd` with only **3** units. If ports 5432/3000 are taken, override them: `DB_PORT=55432 API_PORT=3100 docker compose up --build`.

To exercise the API from a terminal while it runs (needs `curl` and `node`):

```bash
bash scripts/demo.sh            # BASE_URL=http://localhost:3100 bash scripts/demo.sh
```

The script walks through:

- validation errors;
- idempotent replay and one checkout per cart;
- price drift and acknowledgement;
- reaching a milestone and generating a coupon;
- a two-cart race for the coupon and a ten-buyer race for three sneakers;
- the report.

## Local development

```bash
docker compose up -d db          # or any Postgres 16 reachable via DATABASE_URL
npm ci
npm run dev                      # http://localhost:3000, defaults match the compose database
```

| Script                                       | Purpose                                               |
| -------------------------------------------- | ----------------------------------------------------- |
| `npm run dev`                                | Run with reload (tsx)                                 |
| `npm run build && npm start`                 | Compile to `dist/` and run                            |
| `npm test`                                   | Unit + integration tests (see below)                  |
| `npm run typecheck` / `npm run format:check` | Static checks                                         |
| `npm run openapi`                            | Regenerate `docs/openapi.json` from the route schemas |

### Configuration

| Variable                  | Default                                                | Meaning                                            |
| ------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| `REWARD_EVERY_N_ORDERS`   | `5`                                                    | `n`: every n-th placed order unlocks one coupon    |
| `REWARD_DISCOUNT_PERCENT` | `10`                                                   | `x`: whole percent, 1–100 (stored as basis points) |
| `DATABASE_URL`            | `postgres://postgres:postgres@localhost:5432/checkout` | Postgres connection                                |
| `DB_POOL_MAX`             | `20`                                                   | Connection pool size                               |
| `PORT` / `HOST`           | `3000` / `0.0.0.0`                                     | Listen address                                     |
| `SEED_ON_START`           | `true`                                                 | Insert demo products if missing (never overwrites) |
| `LOG_LEVEL`               | `info`                                                 | Pino log level                                     |

Invalid configuration (for example `REWARD_DISCOUNT_PERCENT=150`) stops the process at boot.

## Tests

```bash
npm test                                               # starts a throwaway postgres:16 via Testcontainers (needs Docker)
TEST_DATABASE_URL=postgres://postgres@localhost:5432/scratch npm test   # or use an existing, disposable database (it is truncated)
```

The integration tests run against real Postgres, because the guarantees live in row locks and constraints. Requests are fired concurrently, and a test hook holds product locks for 25 ms so they genuinely overlap. To show the tests catch real mistakes, I broke the code on purpose:

- removing the row lock and stock guard makes the oversell tests fail;
- skipping the idempotency claim makes the retry tests fail;
- removing both the coupon compare-and-set and its unique constraints makes the coupon race test fail.

The details are in DECISIONS.md.

| Risk                                     | Test (in `test/integration/`)                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Overselling under concurrent checkouts   | `checkout-concurrency`: 10 buyers / 3 units, all-or-nothing orders, opposite lock orders without deadlock, shoppers not blocked by checkouts of the same item |
| Cart edit lost during checkout           | `checkout-concurrency`: edit races checkout; the edit is in the order or refused                                                                              |
| Duplicate orders or charges from retries | `idempotency`: same-key storm, different keys on one cart, key reuse, declined payment leaves the key reusable                                                |
| Coupon double-spend / loss               | `coupons`: 5-way redemption race, failed checkouts keep the coupon, a waiting checkout inherits it when the holder's payment fails                            |
| Wrong milestone rewards                  | `coupons`: gating, backlog oldest-first, 8 concurrent generators mint 1 coupon                                                                                |
| Price and stock drift                    | `cart-pricing`: unacknowledged price refused (increase and decrease), snapshot survives catalogue edits, restock deltas under concurrent sales                |
| Report drift or side effects             | `report`: reconciles with `/admin/orders` and `/admin/coupons`, identical on repeat and mutates nothing, consistent during concurrent checkouts               |
| Rounding                                 | `test/unit/pricing.test.ts`                                                                                                                                   |

## API

Conventions:

- **Money** is an integer number of **paise** (`*Paise` fields, INR). There are no floats anywhere money is computed.
- **Errors** are `application/problem+json` (RFC 9457) with a stable `code`, plus structured members such as `shortages`, `changes` and `orderId`.
- **Admin operations** live under `/admin/*`. There is no authentication in this exercise, but that prefix is the boundary where it would go.
- **Checkout** requires an `Idempotency-Key` header. Generate one per checkout attempt, for example a UUID, and reuse it when retrying that attempt.

| Method & path                              | Purpose                                                                   | Success |
| ------------------------------------------ | ------------------------------------------------------------------------- | ------- |
| `GET /products`                            | Catalogue with current price and stock                                    | 200     |
| `GET /products/{productId}`                | One product                                                               | 200     |
| `POST /carts`                              | Create an empty cart                                                      | 201     |
| `GET /carts/{cartId}[?couponCode=]`        | View cart: live prices, totals, issues, optional read-only coupon preview | 200     |
| `POST /carts/{cartId}/items`               | Add units of a product (adds to an existing line)                         | 200     |
| `PUT /carts/{cartId}/items/{productId}`    | Set a line's quantity (upsert; idempotent)                                | 200     |
| `DELETE /carts/{cartId}/items/{productId}` | Remove a line (idempotent)                                                | 200     |
| `POST /carts/{cartId}/acknowledge-prices`  | Accept current prices after a price change                                | 200     |
| `POST /carts/{cartId}/checkout`            | Place the order, optional coupon                                          | 201     |
| `GET /orders/{orderId}`                    | Order with line and pricing snapshot                                      | 200     |
| `POST /admin/coupons`                      | Generate the coupon for the oldest unrewarded milestone                   | 201     |
| `GET /admin/coupons[?status=]`             | List coupons                                                              | 200     |
| `GET /admin/orders[?limit&offset]`         | List placed orders                                                        | 200     |
| `GET /admin/report`                        | Sales and rewards summary (read-only)                                     | 200     |
| `PATCH /admin/products/{productId}`        | Change price and/or adjust stock by a signed delta                        | 200     |

### Cart

**`POST /carts`** returns 201 with a cart view (below).

**`GET /carts/{cartId}`** returns 200. It is side-effect free and read from one snapshot:

```json
{
  "id": "4d1c…",
  "status": "OPEN",
  "orderId": null,
  "currency": "INR",
  "items": [
    {
      "productId": "mug",
      "name": "Ceramic Mug",
      "quantity": 2,
      "unitPricePaise": 31900,
      "acknowledgedUnitPricePaise": 29900,
      "priceChanged": true,
      "lineTotalPaise": 63800,
      "availableStock": 50,
      "sufficientStock": true
    }
  ],
  "itemCount": 2,
  "subtotalPaise": 63800,
  "issues": [
    {
      "code": "PRICE_CHANGED",
      "productId": "mug",
      "acknowledgedUnitPricePaise": 29900,
      "currentUnitPricePaise": 31900
    }
  ],
  "checkoutReady": false,
  "couponPreview": {
    "code": "SAVE10-7KQ2M9XD",
    "status": "APPLICABLE",
    "discountPercent": 10,
    "discountPaise": 6380,
    "estimatedTotalPaise": 57420
  },
  "createdAt": "…",
  "updatedAt": "…"
}
```

- `couponPreview` appears only when `?couponCode=` is given. Its `status` is `APPLICABLE`, `NOT_FOUND` or `ALREADY_REDEEMED`. Nothing is reserved.
- `issues` lists exactly what checkout would currently reject (`PRICE_CHANGED`, `INSUFFICIENT_INVENTORY`).

**`POST /carts/{cartId}/items`** takes `{"productId": "tee", "quantity": 2}`. **`PUT /carts/{cartId}/items/{productId}`** takes `{"quantity": 5}`. Both return 200 with the cart.

- Quantity must be a whole number from 1 to 100; to remove a line, use DELETE.
- Adding or changing a line acknowledges that line's current price.
- The stock check here is advisory. Nothing is reserved; checkout re-checks under lock.

| Status | `code`                    | When                                                                                    |
| ------ | ------------------------- | --------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`       | Bad JSON, quantity not an integer in 1–100, malformed ids (`errors[]` lists each field) |
| 404    | `CART_NOT_FOUND`          | Unknown cart                                                                            |
| 409    | `CART_NOT_OPEN`           | Cart already checked out (includes `orderId`)                                           |
| 409    | `INSUFFICIENT_INVENTORY`  | Requested quantity exceeds current stock (`shortages[]`)                                |
| 422    | `PRODUCT_NOT_FOUND`       | Unknown product                                                                         |
| 422    | `QUANTITY_LIMIT_EXCEEDED` | POST would push the line above 100                                                      |

**`DELETE /carts/{cartId}/items/{productId}`** returns 200 with the cart, even if the line was already gone. It fails with 404 `CART_NOT_FOUND` or 409 `CART_NOT_OPEN`.

**`POST /carts/{cartId}/acknowledge-prices`** sets every line's acknowledged price to the current price and returns 200 with the cart. Show that response to the customer: it is what they confirm by checking out. It fails with 404 or 409 `CART_NOT_OPEN`.

### Checkout

**`POST /carts/{cartId}/checkout`** takes the header `Idempotency-Key: <1-255 chars>` and an optional body `{"couponCode": "save10-7kq2m9xd"}` (codes are case-insensitive). It returns **201** with the order:

```json
{
  "id": "9b2e…",
  "cartId": "4d1c…",
  "status": "PLACED",
  "currency": "INR",
  "items": [
    {
      "productId": "cap",
      "productName": "Baseball Cap",
      "unitPricePaise": 34950,
      "quantity": 3,
      "lineTotalPaise": 104850
    }
  ],
  "subtotalPaise": 104850,
  "coupon": { "code": "SAVE10-7KQ2M9XD", "discountBps": 1000, "discountPercent": 10 },
  "discountPaise": 10485,
  "totalPaise": 94365,
  "paymentReference": "fakepay_9b2e…",
  "placedAt": "…"
}
```

Retries are safe:

- **Same key and same request:** you get the original 201 again, with `Idempotent-Replayed: true`. No new order is created and nothing is charged.
- **A concurrent duplicate:** it waits for the first request, then replays it.
- **A failed attempt** (any 4xx below, or a 503) consumes nothing. Stock, coupon and key are untouched, so you can fix the cause and retry with the same key.

Checks run in this order; the first failure is returned:

| Status | `code`                     | When                                                                                               |
| ------ | -------------------------- | -------------------------------------------------------------------------------------------------- |
| 400    | `VALIDATION_FAILED`        | Malformed cart id or body                                                                          |
| 400    | `IDEMPOTENCY_KEY_REQUIRED` | Header missing or longer than 255 characters                                                       |
| 422    | `IDEMPOTENCY_KEY_REUSED`   | Key already used for a different cart or coupon                                                    |
| 404    | `CART_NOT_FOUND`           | Unknown cart                                                                                       |
| 409    | `CART_ALREADY_CHECKED_OUT` | Cart already has an order (includes `orderId`; fetch it with `GET /orders/{orderId}`)              |
| 422    | `CART_EMPTY`               | No items                                                                                           |
| 409    | `INSUFFICIENT_INVENTORY`   | Any line exceeds stock (`shortages[]` lists every short line); nothing is partially fulfilled      |
| 409    | `PRICE_CHANGED`            | Any current price differs from the acknowledged one (`changes[]`); acknowledge, then retry         |
| 422    | `COUPON_NOT_FOUND`         | Unknown code                                                                                       |
| 409    | `COUPON_ALREADY_REDEEMED`  | Code already used (including by a concurrent checkout that won)                                    |
| 402    | `PAYMENT_DECLINED`         | Fake gateway declined (tests only); includes `reason`                                              |
| 503    | `LOCK_TIMEOUT`             | Waited more than 5 s for a busy cart, product or coupon; `Retry-After: 1`; retry with the same key |

**`GET /orders/{orderId}`** returns 200 with the order above, or 404 `ORDER_NOT_FOUND`. Orders are immutable snapshots: later catalogue changes never alter them.

### Admin

**`POST /admin/coupons`** has no body and returns 201:

```json
{
  "code": "SAVE10-7KQ2M9XD",
  "status": "AVAILABLE",
  "discountBps": 1000,
  "discountPercent": 10,
  "milestoneIndex": 2,
  "milestoneOrderCount": 10,
  "redeemedOrderId": null,
  "createdAt": "…",
  "redeemedAt": null
}
```

- It rewards the **oldest** milestone that has no coupon yet, one coupon per call.
- When none is eligible it returns 409 `NO_ELIGIBLE_MILESTONE` with `placedOrders`, `nextMilestoneAt` and `ordersRemaining`.
- Concurrent calls cannot mint two coupons for the same milestone.

**`GET /admin/coupons?status=AVAILABLE|REDEEMED`** returns 200 `{ "items": [coupon…] }`, ordered by milestone.

**`GET /admin/orders?limit=100&offset=0`** returns 200 `{ "items": [order…], "total": 42, "limit": 100, "offset": 0 }`, oldest first.

**`GET /admin/report`** returns 200 (read-only, computed from one consistent snapshot):

```json
{
  "currency": "INR",
  "totalOrders": 6,
  "grossRevenuePaise": 2541449,
  "totalDiscountsPaise": 3190,
  "netRevenuePaise": 2538259,
  "products": [
    { "productId": "cap", "name": "Baseball Cap", "quantitySold": 3, "grossRevenuePaise": 104850 }
  ],
  "coupons": { "generated": 1, "available": 0, "redeemed": 1 },
  "rewards": {
    "everyNOrders": 2,
    "discountPercent": 10,
    "rewardedMilestones": 1,
    "nextMilestoneAt": 4,
    "eligibleUnrewardedMilestones": 2
  }
}
```

It satisfies these identities:

- `gross = Σ order subtotals`, `discounts = Σ order discounts`, `net = gross − discounts = Σ order totals`;
- `Σ products[].grossRevenuePaise = gross`;
- `generated = available + redeemed`, and `redeemed` = number of orders with a coupon.

**`PATCH /admin/products/{productId}`** takes `{"pricePaise": 31900}` and/or `{"stockAdjustment": 10}`, where the stock adjustment is a signed delta. It returns 200 with the product.

- A delta composes safely with concurrent sales; an absolute "set stock" would not.
- It fails with 400 if neither field is given, 404 `PRODUCT_NOT_FOUND`, or 409 `STOCK_WOULD_BE_NEGATIVE` (includes the current `stock`).

### Error format

```json
{
  "type": "/problems/insufficient-inventory",
  "title": "Insufficient inventory",
  "status": 409,
  "detail": "Not enough stock for: sneaker-ltd",
  "code": "INSUFFICIENT_INVENTORY",
  "instance": "/carts/4d1c…/checkout",
  "shortages": [{ "productId": "sneaker-ltd", "requested": 2, "available": 1 }]
}
```

Status semantics:

- **400:** the request is malformed.
- **404:** the resource in the URL does not exist.
- **409:** the request is valid but conflicts with current state; it may succeed after that state changes.
- **422:** the request is well-formed but references something invalid (unknown product or coupon in the body, empty cart, key reuse).
- **402:** payment declined.
- **503:** transient contention; retry.
- **500:** unexpected; the body never contains internals.

## Project layout

```
src/
  app.ts                  Fastify wiring, error handler, swagger, static demo
  server.ts               boot: config -> pool -> migrate -> seed -> listen
  config.ts               validated env (n, x, ...)
  db/                     Kysely types, pool (safe BIGINT parsing), migrations (schema + invariant constraints), seed, lock helpers
  domain/                 pure: money, pricing, coupon codes, error catalogue
  http/                   problem+json mapping, shared schemas
  payments/gateway.ts     PaymentGateway interface + FakePaymentGateway
  modules/
    products/ carts/      catalogue, cart service (row-locked mutations), schemas, routes
    checkout/             checkout transaction, idempotency keys
    orders/               order views
    admin/                coupon generation, report, product adjustments, routes
public/index.html         demo page
scripts/                  demo.sh (curl walkthrough), export-openapi.ts
test/unit, test/integration, test/setup
```

## Status and time spent

All required behaviour is implemented and tested. The deliberately deferred items are listed in [DECISIONS.md](DECISIONS.md#implemented-vs-deferred).

Time spent: about 2 hours.
