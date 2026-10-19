# Design Decisions

This document explains what the service guarantees, where each guarantee is enforced, and why it is built this way. It is written so that any invariant can be traced from a rule, to the line of code that enforces it, to the database constraint that backs it up, to the test that tries to break it.

**Contents**

1. [System invariants](#system-invariants)
2. [Ambiguities and the semantics I chose](#ambiguities-and-the-semantics-i-chose)
3. [Material decisions](#material-decisions)
4. [Transaction, concurrency and idempotency strategy](#transaction-concurrency-and-idempotency-strategy)
5. [Money and rounding rules](#money-and-rounding-rules)
6. [Error model](#error-model)
7. [Implemented vs deferred](#implemented-vs-deferred)
8. [Multiple instances and production scale](#multiple-instances-and-production-scale)
9. [How I used AI tools](#how-i-used-ai-tools)
10. [If I had two more hours](#if-i-had-two-more-hours)

---

## System invariants

Every invariant is enforced twice. The application enforces it under locks or compare-and-set updates, and a database constraint backs it up, so a missed check in code becomes a refused write rather than corrupt data.

| #   | Invariant                                                                                                                                                                                 | Enforced in code                                                                                                                                                                       | Backed by the database                                                                                                            | Tested by                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| I1  | Stock never goes below zero; we never sell more than we have.                                                                                                                             | Checkout locks product rows (`FOR NO KEY UPDATE`, in id order), validates every line, then runs a guarded decrement `stock = stock - q WHERE stock >= q` and checks it affected 1 row. | `CHECK (stock >= 0)`                                                                                                              | `checkout-concurrency` (10 buyers / 3 units; all-or-nothing) |
| I2  | A cart produces at most one order, and a checked-out cart has exactly one order.                                                                                                          | Checkout locks the cart row and requires `status = 'OPEN'`.                                                                                                                            | `orders.cart_id UNIQUE`; `CHECK (status='CHECKED_OUT') = (order_id IS NOT NULL)`; deferred two-way FK cart↔order                  | `idempotency` (5 keys, one cart)                             |
| I3  | An order reflects exactly the cart at the moment of checkout; a cart is immutable afterwards.                                                                                             | Every cart mutation and checkout start by locking the cart row; mutations require `OPEN`.                                                                                              | (row lock)                                                                                                                        | `checkout-concurrency` (edit races checkout)                 |
| I4  | One idempotency key produces at most one order, and every retry gets the identical response.                                                                                              | The key is claimed by `INSERT` inside the checkout transaction; the stored response is replayed; a different request under the same key is rejected.                                   | `PRIMARY KEY (scope, key)`                                                                                                        | `idempotency` (retry storm; reuse)                           |
| I5  | A coupon is redeemed by at most one order, and only by an order that was actually placed.                                                                                                 | Compare-and-set `UPDATE coupons … WHERE status='AVAILABLE'` inside the checkout transaction.                                                                                           | `orders.coupon_code UNIQUE`, `coupons.redeemed_order_id UNIQUE`, deferred two-way FK coupon↔order, `CHECK` status↔redeemed fields | `coupons` (5-way race)                                       |
| I6  | A failed checkout has no durable effect: no stock moved, coupon still available, key not consumed.                                                                                        | All work, including the key claim and the payment call, happens in one transaction; any error rolls it back.                                                                           | (atomicity)                                                                                                                       | `coupons`, `idempotency`, `cart-pricing`                     |
| I7  | Coupon k exists only once at least `k·n` orders were placed, and there is at most one coupon per milestone.                                                                               | Generation is serialised by an advisory transaction lock and counts only committed orders.                                                                                             | `UNIQUE (milestone_index)`, `UNIQUE (milestone_order_count)`                                                                      | `coupons` (gating, backlog, 8 concurrent generators)         |
| I8  | Order arithmetic is exact and explainable: `line = unit × qty`, `subtotal = Σ lines`, `discount = floor(subtotal × bps / 10000)`, `total = subtotal − discount ≥ 0`.                      | A single pure function, `priceOrder()`.                                                                                                                                                | `CHECK`s on `order_items` and `orders` (`total = subtotal − discount`, `0 ≤ discount ≤ subtotal`, no discount without a coupon)   | `unit/pricing`, `report`                                     |
| I9  | The report reconciles: `gross − discounts = net = Σ totals`, `Σ product revenue = gross`, `generated = available + redeemed`, `redeemed = discounted orders`. Reading it changes nothing. | One `REPEATABLE READ, READ ONLY` transaction.                                                                                                                                          | (read-only transaction)                                                                                                           | `report` (reconcile, repeat, during concurrent checkouts)    |
| I10 | A customer is only ever charged unit prices they acknowledged.                                                                                                                            | Checkout compares each line's `acknowledged_price_paise` to the locked current price; any difference → 409.                                                                            | (row lock)                                                                                                                        | `cart-pricing`                                               |

**Evidence that the tests can catch a broken implementation.** I broke the code on purpose and ran the suite, without committing the changes:

| Mutation                                                                            | Result                                                                                                                                                          |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Remove the product row lock **and** the `stock >= q` guard (naive read-check-write) | 3 oversell tests fail: more than 3 sneakers sold                                                                                                                |
| Skip the idempotency claim                                                          | Retry-storm test fails (the losers got 409, not replays) and key-reuse test fails. Note the cart lock still prevented a second _order_: two independent layers. |
| Remove the coupon `status = 'AVAILABLE'` predicate                                  | **The race test still passed.** The second redeemer was refused by `orders_coupon_code_key`, and the error mapper turned that into the same 409.                |
| Remove the predicate **and** drop the coupon uniqueness/FK constraints              | Race test fails: 5 orders redeemed one coupon.                                                                                                                  |

The third row was a useful surprise. It confirmed that the database backstop works on its own, and that only removing both layers produces the bug.

---

## Ambiguities and the semantics I chose

| Question the brief leaves open                                  | Choice                                                                                                                                                                                                                                                                          | Short reason                                                                                                                                       |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Who may redeem a generated coupon?                              | Anyone holding the code (a bearer token), once.                                                                                                                                                                                                                                 | The brief has no customer identity; binding to a customer would require inventing accounts.                                                        |
| What counts as "successfully placed"?                           | A committed order. Every placed order counts toward milestones, including orders that used a coupon.                                                                                                                                                                            | This matches the wording, and the report's `totalOrders` can be reconciled directly against milestones.                                            |
| Several milestones unrewarded (e.g. n=5, 12 orders, 0 coupons)? | Each `POST /admin/coupons` rewards the **oldest** unrewarded milestone, one per call (5, then 10, then 409).                                                                                                                                                                    | Nothing is forfeited; each call has a small, predictable effect.                                                                                   |
| Does the coupon expire?                                         | No. It is valid until redeemed.                                                                                                                                                                                                                                                 | Not required; listed as deferred.                                                                                                                  |
| How many coupons per order?                                     | At most one.                                                                                                                                                                                                                                                                    | This keeps the discount deterministic and the arithmetic simple.                                                                                   |
| What is the discount applied to?                                | The order subtotal, once (not per line).                                                                                                                                                                                                                                        | A single rounding step, so totals reconcile exactly.                                                                                               |
| Rounding?                                                       | Floor to whole paise.                                                                                                                                                                                                                                                           | The discount never exceeds the advertised percentage.                                                                                              |
| A 100% coupon?                                                  | Total is 0 and the payment call is skipped (`paymentReference = not-required:zero-total`).                                                                                                                                                                                      | You can't charge zero. The total is still a valid, non-negative order.                                                                             |
| Price changes after add-to-cart?                                | The cart always _shows_ live prices. Checkout refuses (409 `PRICE_CHANGED`) if any line's current price differs, **up or down**, from the price the client acknowledged. The client accepts the new prices with `POST /carts/{id}/acknowledge-prices`, or by touching the line. | Invariant I10: the charge equals what the customer confirmed. Blocking on decreases is slightly unfriendly but keeps the rule simple and testable. |
| Stock changes after add-to-cart?                                | Nothing is reserved. Add/update runs an advisory stock check for fast feedback; checkout re-checks under lock and fails all-or-nothing with every short line listed.                                                                                                            | Abandoned carts must not lock up scarce stock. Partial fulfilment was not asked for.                                                               |
| Inventory vs price, which error wins when both apply?           | Inventory first, then price, then coupon, then payment.                                                                                                                                                                                                                         | Acknowledging a price is pointless if the item can't be bought.                                                                                    |
| Is a failed checkout recorded?                                  | No order row. The client gets a specific error; the idempotency key stays unused.                                                                                                                                                                                               | Orders are facts about sales. An audit log of attempts is deferred.                                                                                |
| Does `n` change mid-life?                                       | `n` is read at boot. The next milestone continues from the last rewarded one (`last.milestone_order_count + n`), and each coupon stores its own milestone and percentage.                                                                                                       | Changing config never rewrites history or alters issued coupons.                                                                                   |
| Who is an administrator?                                        | Anything under `/admin/*`. No auth in this exercise.                                                                                                                                                                                                                            | That prefix is where an auth hook would go.                                                                                                        |
| "Total discounts granted" in the report                         | The sum of discounts actually applied to placed orders, not the face value of unredeemed coupons.                                                                                                                                                                               | An unredeemed coupon has granted nothing yet; it shows up under `coupons.available`.                                                               |

---

## Material decisions

### Decision: PostgreSQL as the source of truth, not an in-memory store

**Context:** Every hard requirement (no oversell, single-use coupons, one order per cart, retries) is a question of what happens when requests overlap.

**Options considered:**

- **In-memory with hand-rolled locks:** zero infrastructure. But Node's single thread makes naive code look correct, and the result doesn't transfer to multiple instances.
- **SQLite:** zero infrastructure, but it serialises all writes, so the concurrency story is trivially "safe" and teaches nothing about the production design.
- **PostgreSQL:** row locks, constraints and transactions that behave the same with one instance or twenty.

**Choice:** PostgreSQL 16 via `docker compose`, accessed with Kysely (a typed SQL builder) over node-pg.

**Why:** The invariants live where the data lives, so they hold across processes. Kysely keeps the SQL that runs visible in the code (`FOR UPDATE`, guarded `UPDATE … RETURNING`), which matters when explaining an invariant line by line. An ORM would hide exactly the parts being evaluated.

**Consequences:** Running the service and its tests needs Docker. Tests use Testcontainers, so `npm test` is still one command. In exchange, the "multiple instances" question has a short answer: nothing changes.

### Decision: Pessimistic row locks in a fixed order, plus guarded updates, at READ COMMITTED

**Context:** Concurrent checkouts compete for stock, the same cart, and the same coupon.

**Options considered:**

- **`SERIALIZABLE` + retry loop:** less reasoning in code, but conflicts surface as opaque `40001` errors that need a retry budget, and a hot item causes retry storms.
- **Optimistic version columns:** fine at low contention, but noisy exactly where it matters: three people fighting for three sneakers.
- **Row locks with a global lock order + compare-and-set updates:** explicit, predictable waiting and no retries.

**Choice:** In one READ COMMITTED transaction, checkout takes locks in a fixed order: idempotency key → cart (`FOR UPDATE`) → products (`FOR NO KEY UPDATE ORDER BY id`) → coupon (compare-and-set `UPDATE … WHERE status='AVAILABLE'`). It validates everything against the locked rows before writing anything. Stock is decremented with a guarded `UPDATE … WHERE stock >= q`, and the row count is asserted.

**Why:** The fixed order means two checkouts can wait on each other but cannot deadlock; a test adds products to carts in opposite orders to prove it. The lock strength is `FOR NO KEY UPDATE`, not `FOR UPDATE`: checkout only changes `stock` (not a key column), and the weaker lock still serialises checkouts. Unlike `FOR UPDATE`, though, it does not conflict with the `KEY SHARE` lock that an add-to-cart takes on the product through its foreign key. A test holds a checkout open for 300 ms and asserts that a shopper adding the same product to another cart is not made to wait. Validating under lock lets the response list _every_ short line, not just the first. The guard and the `CHECK (stock >= 0)` constraint turn an impossible state into a rollback instead of an oversell.

**Consequences:** Checkouts of the same item serialise on its row, which is inherent to selling a scarce item. Throughput for one hot SKU is bounded by the transaction duration. That is why the payment call must not stay inside the transaction for a real gateway (see the payment decision). Lock waits are bounded by a transaction-local `lock_timeout` of 5 s, which surfaces as a retryable 503.

### Decision: Required Idempotency-Key, claimed inside the checkout transaction, plus a one-order-per-cart state machine

**Context:** A client that timed out cannot know whether its checkout happened. A retry must neither create a second order nor charge twice. A retry must also be distinguishable from a genuinely different request.

**Options considered:**

- **Cart state only (natural key):** one order per cart, and a re-checkout returns the existing order. But it cannot tell "retry" from "same cart, different coupon".
- **Optional key:** clients that forget it silently lose retry safety.
- **Separate key table with an `IN_PROGRESS` row committed before the work:** that needs a recovery story for keys stuck in progress after a crash.
- **Required key, claimed in the same transaction as the work:** chosen.

**Choice:**

- **The claim.** `POST /carts/{id}/checkout` requires `Idempotency-Key`. The first statement of the checkout transaction is `INSERT INTO idempotency_keys … ON CONFLICT DO NOTHING`, with a SHA-256 fingerprint of `{cartId, couponCode}`.
- **The response.** The 201 body is written to the same row before commit.
- **Replays.** A repeat with the same key and fingerprint replays the stored response (`Idempotent-Replayed: true`). A different fingerprint gets 422.
- **The second layer.** Independently, the cart moves `OPEN → CHECKED_OUT`, and `orders.cart_id` is `UNIQUE`.

**Why:** Claiming the key inside the work transaction gives the right behaviour for every race without extra states:

- **The same key arrives twice concurrently.** The second `INSERT` blocks on the primary-key index until the first transaction ends.
  - If the first commits, the second sees a conflict and replays.
  - If the first rolls back (stock ran out, payment declined), the second's insert succeeds and it runs for real.
- **A crash mid-checkout.** It rolls back the claim too, so no key is ever stuck in progress.
- **Failures.** They consume nothing, so the client can fix the cause (acknowledge prices, restock) and retry with the same key.

The cart state machine is a second, independent layer: a client that lost its key still cannot place a second order for the same cart.

**Consequences:**

- Failed attempts are not replayed. A retry after a 409 re-evaluates, which is deliberate, because state may have changed.
- Keys are global. Production would scope them per API client and expire them (deferred).
- The fingerprint covers the request's meaning (cart and coupon), not raw bytes, so formatting differences don't trigger false 422s.

### Decision: Price drift is detected against an acknowledged price per line and requires explicit acceptance

**Context:** The brief asks what happens when a price changes after an item was added.

**Options considered:**

- **Lock the price at add time:** friendly to customers, but stale carts become a way to buy at old prices, and the store has no control.
- **Always charge the live price silently:** the customer may pay more than they were shown.
- **Live price, plus refuse a checkout whose price the client never saw:** chosen.

**Choice:**

- Each cart line stores `acknowledged_price_paise`. Adding or changing a line sets it to the current price, and the response shows that price.
- The cart view shows live prices and lists `PRICE_CHANGED` issues.
- Checkout refuses any difference (409 with old and new prices per line).
- `POST /carts/{id}/acknowledge-prices` accepts the current prices.

**Why:** It makes invariant I10 enforceable: the amount charged is always one the customer confirmed. During planning, my first sketch had _viewing_ the cart acknowledge the new price. That would make a `GET` mutate state, which conflicts with the brief's emphasis on side-effect-free reads, so acknowledgement became an explicit `POST`.

**Consequences:**

- Clients need one extra call after a price change.
- A price _decrease_ also blocks until acknowledged. That was a conscious simplicity trade-off; auto-accepting decreases is a one-branch change.
- There is a small window: if the price changes again between the acknowledge call and checkout, checkout refuses again, which is correct.

### Decision: No stock reservation in carts; an advisory check at add time, an authoritative check at checkout

**Context:** The brief says limited inventory must never be oversold. It doesn't say carts hold stock.

**Options considered:**

- **Reserve at add-to-cart with a TTL:** guarantees availability at checkout, but abandoned carts lock up scarce items, and it needs an expiry sweeper.
- **No check until checkout:** carts can hold obviously impossible quantities.
- **Advisory check at add, authoritative at checkout:** chosen.

**Choice:** Add and update reject quantities above current stock (fast feedback), but reserve nothing. Checkout re-validates under row locks and fails all-or-nothing, listing every shortfall.

**Why:** It is the simplest model that cannot oversell. Scarce stock goes to whoever checks out first, which is the usual expectation in ecommerce.

**Consequences:** A cart can be valid when filled and invalid at checkout. The cart view's `issues` and the checkout error say exactly which lines are short.

### Decision: Coupons are single-use bearer codes, one per milestone, generated oldest-first under an advisory lock

**Context:** "Every n-th order makes one coupon available", generated on admin request, at most once per milestone, and safe if two admins click at once.

**Options considered:**

- **Generation:**
  - Rely only on `UNIQUE(milestone_index)` and turn the violation into 409. Correct, but concurrent callers see database errors as their normal path.
  - Lock a singleton counter row. Works, but it adds a hot row that every checkout would also touch if it maintained the counter.
  - A transaction-scoped advisory lock: chosen.
- **Counting:**
  - Maintain an order counter in the checkout transaction: a hot row on every checkout.
  - `COUNT(*)` of committed orders at generation time: chosen.

**Choice:**

- `POST /admin/coupons` takes `pg_advisory_xact_lock`, counts committed orders, finds the last rewarded milestone, and computes `next = last.milestone_order_count + n`.
- If eligible, it inserts one coupon (random 40-bit Crockford code, `SAVE10-XXXXXXXX`) that records its milestone index, order count and basis points.
- `UNIQUE(milestone_index)` is the backstop.
- Redemption is the compare-and-set described above.

**Why:** The advisory lock is cluster-wide and released automatically at commit or rollback, so it is correct with any number of instances and needs no cleanup. Counting only committed orders means a milestone can never be rewarded on the strength of a checkout that later rolls back. Checkouts never touch a shared counter, so they stay independent of each other.

**Consequences:**

- `COUNT(*)` grows linearly with order history; at scale it should become a maintained counter or come from a sequence.
- Generation is not idempotent across admin retries: a retried call may legitimately reward the _next_ eligible milestone. It never rewards the same milestone twice.
- Codes are bearer secrets, so anyone with the code can use it. That is acceptable given there are no customer accounts.

### Decision: Payment is a gateway interface with an in-process fake, called inside the checkout transaction

**Context:** No real payment is required, but "a coupon must not be consumed by a checkout that ultimately fails" needs a realistic failure point after the coupon is claimed.

**Options considered:**

- **No payment step:** checkout success is payment success. Simplest, but then the only failures happen before any claim.
- **A fake gateway inside the transaction:** chosen.
- **Two-phase reservation** (order `PENDING` → reserve stock and coupon → call the gateway outside the transaction → finalise or release, plus an expiry sweeper): the production shape, but its recovery paths can't be finished well in the timebox.

**Choice:** `PaymentGateway.charge()`, implemented by `FakePaymentGateway` (always approves unless a test injects a decline rule). It is called after stock is validated and the coupon is claimed, and before anything is written. A decline returns 402 and rolls back everything. The client's idempotency key is forwarded to the gateway.

**Why:** It gives a real, testable failure _after_ the coupon claim. The tests show that a declined checkout leaves the coupon available, and that a checkout waiting on the same coupon gets it once the holder's payment fails.

**Consequences:** Holding row locks during a call is only acceptable because the fake is instant and in-process. With a real provider (slow, remote, can time out after charging) this must become the two-phase design described in [production scale](#multiple-instances-and-production-scale). The interface already carries the idempotency key that design needs.

### Decision: Orders store full snapshots; nothing about a past order is derived from the live catalogue

**Context:** An order must explain what was bought and how its total was computed, even after product data changes.

**Options considered:**

- **Reference products and recompute:** breaks as soon as a price or name changes.
- **Store the snapshot:** chosen.

**Choice:**

- `order_items` stores product id, **name**, **unit price**, quantity and line total.
- `orders` stores subtotal, coupon code, **basis points**, discount, total, payment reference and the idempotency key.
- `CHECK` constraints enforce `line = unit × qty` and `total = subtotal − discount`.

**Why:** The order can be audited on its own: `discount = floor(subtotal × discount_bps / 10000)` is reproducible from the row. The report sums snapshots, so it never drifts when the catalogue changes. A test changes the price after checkout and confirms `GET /orders/{id}` is byte-identical.

**Consequences:** Some data is duplicated, which is the point. Product renames don't propagate to old orders, and shouldn't.

### Decision: Database constraints as a second line of defence, including deferred two-way foreign keys

**Context:** Application checks can be bypassed by a future code path, a manual SQL fix, or a bug.

**Options considered:**

- **Trust the service layer:** one layer.
- **Constraints for every invariant that fits in a row, or in a pair of rows:** chosen.

**Choice:**

- `CHECK`s on stock, totals, line arithmetic, coupon-field coherence and status ↔ link coherence.
- `UNIQUE` on `orders.cart_id`, `orders.coupon_code`, `coupons.milestone_index` and `coupons.redeemed_order_id`.
- **Deferred** composite foreign keys in both directions between cart and order, and between coupon and order. These make "cart CHECKED_OUT ⇔ its order exists" and "coupon REDEEMED ⇔ the order that used it" facts the database checks at `COMMIT`.

**Why:** The mutation run above showed the value: with the coupon compare-and-set removed, the constraint alone still prevented a double redemption, and the error mapper turned it into the same 409 the client would normally see.

**Consequences:** The schema is denser than a CRUD app's. Deferred constraints only raise at commit, which is acceptable for a backstop that should never fire.

### Decision: The report is one read-only, repeatable-read snapshot

**Context:** The report must reconcile with orders and coupons, and repeated requests must not mutate state, including while checkouts are happening.

**Options considered:**

- **Several independent queries at READ COMMITTED:** an order committing between the "orders" and "coupons" queries could make redeemed coupons ≠ discounted orders for that one response.
- **Maintained aggregate tables:** fast, but every checkout then writes to shared hot rows, and reconciliation depends on the aggregates being correct.
- **A single snapshot:** chosen.

**Choice:** All aggregates run in one `REPEATABLE READ, READ ONLY` transaction over the order snapshots.

**Why:** Every report is internally consistent by construction (a test checks the identities for reports fired _during_ concurrent checkouts). `READ ONLY` makes "doesn't mutate" something the database enforces, not just a convention.

**Consequences:** Full scans grow with history. At scale, run it on a replica or maintain rollups (see below).

### Decision: Admin stock changes are signed deltas, never absolute values

**Context:** Restocks happen while customers are buying.

**Options considered:**

- **Absolute "set stock to 20":** last writer wins, which silently resurrects units sold a moment earlier.
- **Absolute with expected-value compare-and-set:** correct, but the admin must re-read first.
- **Signed delta:** chosen.

**Choice:** `PATCH /admin/products/{id}` takes `stockAdjustment` (for example `+10` or `-2`) and applies it as one guarded `UPDATE … SET stock = stock + d WHERE stock + d >= 0`. It returns 409 if the result would be negative.

**Why:** Deltas compose with concurrent decrements. A test fires 3 checkouts and a `+10` together and asserts the final stock is exactly `3 + 10 − 3`.

**Consequences:** Admin tooling thinks in adjustments (receive 10, write off 2), which is also how stock ledgers usually work.

### Decision: RFC 9457 problem details with a stable machine-readable code

**Context:** Errors must be distinguishable and useful to an API client.

**Options considered:**

- **A custom `{error: {code, message}}` envelope:** non-standard.
- **Problem details plus a `code` extension:** chosen.

**Choice:** Every error is `application/problem+json` with `type`, `title`, `status`, `detail`, `instance`, a stable `code`, and structured members (`shortages[]`, `changes[]`, `orderId`, `nextMilestoneAt`, `errors[]` for validation).

**Why:** Clients switch on `code` rather than parsing prose. The extras let a client act without another round trip: show which lines are short, show old vs new prices, or link to the existing order.

**Consequences:** The full catalogue is in [Error model](#error-model) and in the OpenAPI document. Every route declares its error statuses.

---

## Transaction, concurrency and idempotency strategy

### Checkout, step by step (`src/modules/checkout/service.ts`)

```
BEGIN (READ COMMITTED); lock_timeout = 5s (transaction-local)
 1. INSERT idempotency key ........ waits if the same key is in flight; replay or 422 if already used
 2. SELECT cart FOR UPDATE ........ 404 / 409 CART_ALREADY_CHECKED_OUT / 422 CART_EMPTY
 3. SELECT products FOR NO KEY UPDATE ORDER BY id
 4. validate all lines ............ 409 INSUFFICIENT_INVENTORY (all shortages) / 409 PRICE_CHANGED (all changes)
 5. UPDATE coupon SET REDEEMED WHERE status='AVAILABLE' ... 422 COUPON_NOT_FOUND / 409 COUPON_ALREADY_REDEEMED
 6. priceOrder() .................. pure, deterministic
 7. payment.charge() .............. 402 PAYMENT_DECLINED
 8. UPDATE products SET stock = stock - q WHERE stock >= q   (assert 1 row each)
    INSERT order, order_items (snapshots); UPDATE cart -> CHECKED_OUT; store response on key
COMMIT (deferred FKs checked here)          any error before this line => ROLLBACK, no effects
```

**Lock order and deadlocks.** Every transaction that takes more than one lock takes them in the order key → cart → products by id → coupon. Cart mutations lock the cart, then take only a `KEY SHARE` lock on the product (implicitly, through the foreign key). That lock is compatible with checkout's `FOR NO KEY UPDATE`, so browsing never waits on buying. Admin product updates lock one product row. Coupon generation takes an advisory lock and inserts; it never locks rows that checkout holds. No transaction waits for something "earlier" in the order while holding something "later", so a wait-for cycle cannot form. The opposite-order test exercises exactly this.

### What happens when requests collide

| Scenario                                                                        | Outcome                                                                                                                                                       | Why                                                                            |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 10 checkouts for the last 3 units                                               | 3 × 201, 7 × 409 `INSUFFICIENT_INVENTORY`                                                                                                                     | Product row lock; validation under lock; guarded decrement; `CHECK stock >= 0` |
| Two checkouts of one cart with different keys                                   | One 201; the other waits on the cart lock, then sees `CHECKED_OUT` → 409 with `orderId`                                                                       | Cart row lock; `orders.cart_id UNIQUE`                                         |
| The same key sent twice at once                                                 | One runs; the other waits on the key's index entry, then replays the 201                                                                                      | Key claimed inside the transaction                                             |
| A retry with the same key after the first attempt failed (409/402/503)          | Runs fresh, because the first attempt left nothing behind                                                                                                     | The claim rolled back with the failure                                         |
| The same key with a different cart or coupon                                    | 422 `IDEMPOTENCY_KEY_REUSED`                                                                                                                                  | Request fingerprint                                                            |
| Client times out, server still working, client retries                          | The retry waits for the original, then replays it. If the original takes more than 5 s: 503, and a later retry replays                                        | `lock_timeout` bounds the wait                                                 |
| Two carts, one coupon                                                           | One 201; the other blocks on the coupon row, then updates 0 rows → 409 `COUPON_ALREADY_REDEEMED`                                                              | Compare-and-set on `status`; `UNIQUE(coupon_code)` backstop                    |
| Coupon holder's payment is declined while another checkout waits for the coupon | The waiter gets the coupon                                                                                                                                    | Rollback restores `AVAILABLE` and releases the row lock                        |
| Cart edited while it is being checked out                                       | Edit first → it is in the order. Checkout first → the edit gets 409 `CART_NOT_OPEN`. Never lost                                                               | Both paths lock the cart row first                                             |
| Admin changes a price during a checkout                                         | Before checkout locks the product → checkout sees the new price → 409 `PRICE_CHANGED`. After → the admin update waits; the order keeps the acknowledged price | Product row lock                                                               |
| Admin restocks during checkouts                                                 | Final stock = initial + delta − sold                                                                                                                          | Delta update on the same locked row                                            |
| Two admins generate a coupon at one eligible milestone                          | One 201, one 409 `NO_ELIGIBLE_MILESTONE`                                                                                                                      | Advisory transaction lock; `UNIQUE(milestone_index)`                           |
| Generate while the milestone-reaching checkout is still in flight               | 409 now, 201 once that order commits                                                                                                                          | Only committed orders count                                                    |
| Report requested during checkouts                                               | Each report is internally consistent                                                                                                                          | One `REPEATABLE READ` snapshot                                                 |
| Process killed mid-checkout                                                     | Postgres aborts the transaction; no stock, coupon, order or key change                                                                                        | Atomicity                                                                      |

---

## Money and rounding rules

- **Representation.** All money is an integer number of **paise** (INR minor units): `BIGINT` in Postgres and safe integers in TypeScript. The node-pg parsers for `BIGINT` and `NUMERIC` convert to numbers but **throw** rather than round if a value is ever outside the safe-integer range. Floats never hold money; the demo page's formatter uses integer arithmetic too.
- **Percentages.** Stored as integer **basis points** (10% = 1000 bps). Config takes a whole percent, 1–100.
- **Formulas.** `lineTotal = unitPrice × quantity`; `subtotal = Σ lineTotal`; `discount = floor(subtotal × bps / 10000)`, computed in `BigInt`; `total = subtotal − discount`.
- **Discount scope.** Applied **once, at order level**. Per-line discounting would round each line separately, and the lines would no longer sum to the order discount.
- **Rounding direction.** **Floor**, so the discount never exceeds the advertised rate. 10% of ₹49.99 is ₹4.99, not ₹5.00. The rule is deterministic: the same inputs always give the same paise, in any line order.
- **No negative totals.** `bps ≤ 10000` (validated at boot and by a `CHECK`), so `total ≥ 0`. The code asserts it anyway, and a `CHECK` enforces `0 ≤ discount ≤ subtotal`.
- **Bounds.** Unit price ≤ ₹1 crore and quantity ≤ 100 per line, which keeps every intermediate value far below 2⁵³.

---

## Error model

The status code says what kind of problem it is; `code` says exactly which one.

| Status | Meaning                                                                                  | Codes                                                                                                                                                                 |
| ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | The request is malformed                                                                 | `VALIDATION_FAILED` (with `errors[]`: location, path, message), `IDEMPOTENCY_KEY_REQUIRED`                                                                            |
| 402    | Payment declined                                                                         | `PAYMENT_DECLINED`                                                                                                                                                    |
| 404    | The resource in the **URL** does not exist                                               | `CART_NOT_FOUND`, `ORDER_NOT_FOUND`, `PRODUCT_NOT_FOUND` (GET), `ROUTE_NOT_FOUND`                                                                                     |
| 409    | Valid request that conflicts with **current state**; may succeed after the state changes | `INSUFFICIENT_INVENTORY`, `PRICE_CHANGED`, `COUPON_ALREADY_REDEEMED`, `CART_ALREADY_CHECKED_OUT`, `CART_NOT_OPEN`, `NO_ELIGIBLE_MILESTONE`, `STOCK_WOULD_BE_NEGATIVE` |
| 422    | Well-formed, but semantically invalid as sent; it won't succeed by retrying              | `PRODUCT_NOT_FOUND` (in body), `COUPON_NOT_FOUND`, `CART_EMPTY`, `QUANTITY_LIMIT_EXCEEDED`, `IDEMPOTENCY_KEY_REUSED`                                                  |
| 503    | Transient contention; retry with the same key (`Retry-After: 1`)                         | `LOCK_TIMEOUT` (also covers deadlock or serialisation failures, should they ever occur)                                                                               |
| 500    | Unexpected; logged server-side, no internals in the body                                 | `INTERNAL`                                                                                                                                                            |

Choices worth noting:

- **An unknown product in the body is 422, but 404 at `GET /products/{id}`.** The URL is fine in the first case; the payload is wrong.
- **Constraint violations are mapped.** If a backstop constraint fires (`orders_cart_id_key`, `orders_coupon_code_key`), the client still gets the domain 409, not a 500.
- **Every error carries the detail needed to recover.** Shortages, price changes, the existing order id, and orders remaining until the next coupon.

---

## Implemented vs deferred

**Implemented**

- Every required endpoint: cart create, view, add, update and remove; checkout with optional coupon; order retrieval; coupon generation; report.
- Plus: price acknowledgement, a read-only coupon preview, admin coupon and order listings, and admin price and stock adjustment.
- All invariants above, each with a database backstop. Six seeded products, one of them scarce.
- 41 tests (9 unit, 32 integration on real Postgres): concurrent and repeated-request scenarios for oversell, retries, coupon races, generation races, cart edits racing checkout, restocks racing sales, and report consistency. Mutation-checked as described above.
- OpenAPI (`/docs`, `docs/openapi.json`), a curl walkthrough (`scripts/demo.sh`), a demo page, and Docker Compose.

**Deliberately deferred**

- **Authentication and authorisation.** `/admin/*` is the boundary.
- **Idempotency-key retention and scoping.** Keys are kept forever and are global. Production: scope them per client or API key, expire them after about 24 h with a sweeper, and partition by `created_at`.
- **Idempotent coupon generation.** A retried `POST /admin/coupons` may reward the _next_ eligible milestone. It can never double-reward one milestone, but an `Idempotency-Key` on that endpoint (reusing the same helper) would make admin retries exact.
- **Real payment provider and its reservation saga.** See below.
- **Cart expiry and abandonment cleanup; coupon expiry; per-customer coupons.**
- **Changing `n` or `x` at runtime.** Config is read at boot. The model already supports it: coupons snapshot their percentage, and milestones continue from the last rewarded one.
- **Audit log of failed checkout attempts.**
- **Cancellations and refunds.** These need a rule for whether a cancelled order "un-counts" toward milestones and how the report shows refunds.
- **Cursor pagination** (offset is used), rate limiting, metrics and tracing, multi-currency.

---

## Multiple instances and production scale

**Running several instances requires no change for correctness.** The service keeps no in-process state, takes no in-memory locks and has no caches; all coordination happens in Postgres:

- row locks;
- a transaction-scoped advisory lock;
- unique constraints;
- the idempotency table.

Run N stateless replicas behind a load balancer. What would change with scale:

1. **Connections.** N instances × pool size must fit within `max_connections`. Put PgBouncer in **transaction** pooling mode in front. This design is compatible with it: the advisory lock is transaction-scoped and `lock_timeout` is set with `set_config(…, true)` (transaction-local). Session state is never relied on.
2. **Real payments.** The charge must leave the database transaction:
   - Transaction 1 creates the order as `PENDING_PAYMENT`, decrements stock, and moves the coupon to `RESERVED` with an expiry, then commits.
   - The PSP is called outside any transaction, with the idempotency key.
   - Transaction 2 marks the order `PLACED` (or `FAILED` and releases stock and coupon).
   - A sweeper releases expired reservations, and a reconciliation job compares orders with PSP records.
   - State changes are published through an **outbox** table so notifications are never lost or duplicated.

   Milestones and the report would count only `PLACED` orders.

3. **Hot items.** Every checkout of one SKU serialises on its row. For flash sales:
   - split stock into N bucket rows and decrement any bucket with `FOR UPDATE SKIP LOCKED`; or
   - put purchases for that SKU through a queue; or
   - issue short-lived reservation tokens.

   Metrics on lock-wait time and 409/503 rates would show when this is needed.

4. **Idempotency table.** Add TTL expiry, partition by day, and scope keys per client.
5. **Milestone counting.** Replace `COUNT(*)` with a per-order sequence number, or a counter maintained by an outbox consumer, so generation stays O(1).
6. **Reporting.** Serve it from a read replica (accepting replica lag), or from rollup tables maintained from the outbox and periodically reconciled against the snapshots.
7. **Operations.** Structured logs already carry request ids. Next would be metrics and traces around checkout, alerts on the backstop constraints (they should never fire), and auth on `/admin`.

---

## How I used AI tools

> **Note to self, remove before submitting:** Claude Code drafted this section from what actually happened in the session. Edit it into your own words, and add anything you reviewed or changed yourself afterwards.

I used **Claude Code** (an agentic coding assistant) throughout: to plan, to implement, to write tests, and to draft this document. I reviewed and ran everything it produced.

- **Planning by interrogation, not generation.** Before any code, I had the assistant read the brief and ask me structured questions about stack, persistence, payment modelling, coupon semantics, price drift, stock holds, idempotency, cart semantics, rounding, concurrency mechanism, error format, test infrastructure, admin scope and configuration: about twenty decisions over five rounds. I accepted most of its recommended options. I **overrode two**:
  - I asked for a small demo frontend; it had recommended backend-only.
  - I asked for the read-only coupon preview; it had recommended deferring it.
- **A correction to the AI's own proposal.** One option the assistant offered for price drift had "viewing the cart acknowledges the new price". That is a `GET` with a side effect, and it was flagged and replaced with an explicit `POST /carts/{id}/acknowledge-prices` before implementation. This is now invariant I10.
- **Validating generated tests, not just generated code.** Running the suite caught two errors in AI-written tests:
  - **A hand-computed expectation was wrong.** The report test expected a 17,226-paise discount. The correct floor of 15% × 114,848 is 17,227: the code was right and the expectation was not.
  - **A setup step was invalid.** It tried to fill a cart with stock that was already gone, and the add-to-cart soft check correctly refused it.

  Both were fixed in the tests, not by bending the code.

- **Checking that the tests can fail.** I had the assistant break the implementation deliberately: remove row locks, skip the idempotency claim, drop the coupon compare-and-set. The point was to confirm the concurrency tests catch it. One result was unexpected: removing the coupon compare-and-set alone did _not_ fail the race test, because a unique constraint still blocked the double redemption. Rather than accept a green run, we also dropped the constraint, confirmed the test then fails, and documented both layers (see [System invariants](#system-invariants)).
- **Reviewing the docs against the code found a real issue.** While drafting this document, the assistant wrote that "cart mutations read products without locking". Checking that claim showed it was incomplete: inserting a cart line takes a `KEY SHARE` lock on the product through the foreign key, and checkout's `FOR UPDATE` conflicts with it. So adding an item to _any_ cart waited for every in-flight checkout of that product. We first wrote a test that reproduced the wait (and failed), then changed the lock to `FOR NO KEY UPDATE` and re-ran the oversell mutation check to confirm protection was unchanged.
- **What I would watch for.** AI-generated concurrency code tends to _look_ right; the evidence that it is right comes from the overlapping-request tests and the mutation runs, not from reading it.

---

## If I had two more hours

1. **The real-payment shape.** Implement `PENDING_PAYMENT` with stock and coupon reservations, the expiry sweeper, and tests for a crash between "charged" and "committed". This is the biggest gap between the current design and production.
2. **Property-based testing of reconciliation.** Generate random interleavings of carts, checkouts, coupon generations, restocks and price changes (fast-check), then assert all of I1–I10 and the report identities after each run.
3. **Load test on the hot SKU** (k6 or autocannon). Measure lock-wait distribution and the 503 rate, tune `lock_timeout`, and decide whether stock buckets are needed.
4. **Idempotency hygiene.** Per-client key scoping, TTL cleanup, and an `Idempotency-Key` on coupon generation.
5. **Cancellation and refund semantics,** and their effect on milestones and the report.

**Time spent:** _TODO (fill in your own figure)_.
