# Overhead Allocation — specification for review

Draft, 27 Aug 2026. **Nothing in section 4 onward is built.** Sections 1–3 describe
what is already live so the changes have a baseline to be measured against.

Mark this up. The open decisions in §7 are the ones only you can make, and each
one is flagged with what it costs to get wrong.

---

## 1. What is live today

Overhead figures moved out of TypeScript constants into Supabase this morning
(`sql/overhead_reference.sql`). Three tables, one resolver function:

- `overhead_items` — rent, indirect payroll, other expenses, **banded by effective date**
- `overhead_line_shares` — percent of each item charged to a production line
- `overhead_settings` — currently one row, `quote_lead_days = 60`
- `overhead_for_line(line_key, asof)` — resolves what was true on a date

Both calculators read it through `GET /api/overhead?line=…`, and both fall back to
the built-in constants if the database is unreachable. A job that has already saved
its own overhead rows keeps them; these are defaults for new work only.

Rates step up on their own — every published lease band through 2030 is loaded, and
the as-of date defaults to `current_date + quote_lead_days`, i.e. the date the job is
expected to *run*, not the day it was quoted.

**Current shares (live now, and wrong — see §3):**

| | Suite 300 | Suite 400 | Suite 500/600 |
|---|---|---|---|
| bottle | 100% | 0% | 50% |
| gummy | 0% | 100% | 50% |

---

## 2. The facility

| Suite | Sq ft | Office/spec | Warehouse | Manufacturing | Packaging |
|---|---|---|---|---|---|
| 300 | 10,720 | 2,680 | 3,752 | 0 | 4,288 |
| 400 | 3,072 | 614 | 0 | 2,458 | 0 |
| 500/600 | 8,879 | 3,552 | 5,327 | 0 | 0 |
| **Total** | **22,671** | **6,846** | **9,079** | **2,458** | **4,288** |

Cost per square foot is effectively uniform across the estate — $1.8752 (Suite 300),
$1.8784 (Suites 400 and 500/600). **Square feet are dollars**, so floor area can be
used as the allocation unit without distortion.

Total: **$42,550/month** (base rent + CAM, current bands).

By function:

| | Sq ft | Share | $/month |
|---|---|---|---|
| Warehouse | 9,079 | 40.0% | $17,042 |
| Office / specialized | 6,846 | 30.2% | $12,851 |
| Packaging | 4,288 | 18.9% | $8,041 |
| Manufacturing | 2,458 | 10.8% | $4,617 |

**Production floor is under a third of the rent.** How the other 70% is allocated
matters more than any argument about the production split.

---

## 3. Why the current shares are wrong

Three separate faults, discovered in order:

1. **Suite 300 at 100% to bottling.** Suite 300 is only 40% packaging. Charging CP
   100% means CP pays for 3,752 sq ft of warehouse and 2,680 sq ft of office.
2. **Gummy pays 0% of Suite 300** while being charged 25% of the Production Manager
   and Quality Manager — who work in that building. Internally inconsistent.
3. **Suite 300 is the whole Contract Packaging department's space**, not bottling's.
   Bottles, blisters, sachets, pouches and kitting all run there. Five more
   calculators are coming and none of them are represented.

And a fourth, which is structural rather than a wrong number:

4. **The model divides by calendar days.** `monthly ÷ 21 × job days` assumes the
   plant does one thing at a time. It does not — see §5.

---

## 4. Proposed structure: two pools, two drivers

Stop allocating suite by suite. Split the estate by function into two pools that
absorb cost by different mechanisms.

```
PRODUCTION POOL      packaging 4,288 + manufacturing 2,458   $12,658 / mo
                     → absorbed per RUN-DAY (see §5)

FACILITY POOL        warehouse 9,079 + office 6,846          $29,893 / mo
                     → absorbed by a non-time driver (see §6)
```

The reason for the split is that **purchased-bulk resale consumes warehouse and
office heavily but almost no production days.** Under a purely time-based model a
resale order absorbs nearly nothing, and CP plus gummy end up carrying the whole
facility. If resale is a large part of the business, that is a significant
mis-pricing hiding in plain sight.

---

## 5. Production pool — absorbed per run-day

### The capacity facts

From `Packaging Yields v2.1`, last 12 months (Sep 25 – Aug 26), counting distinct
date + line + sales order:

- **67.2 run-days per month**
- **3.28 parallel runs per day** on average; median 3, max 6
- **21.6 people on the floor per day**, averaging ~5 hours each per job row

Against your machine counts:

| Line | Machines | Run-days/mo | Capacity (×21) | Utilisation |
|---|---|---|---|---|
| Bottles | 2 | 40.2 | 42 | **96%** |
| Blisters | 2 | 15.0 | 42 | 36% |
| Pouches | 1 | 7.3 | 21 | 35% |
| Sachets | 4 | 4.7 | 84 | **6%** |
| **All** | **9** | **67.2** | **189** | **36%** |

Bottling is the binding constraint. Equipment overall is only a third used, so
**crew is the real limit, not machines.**

### The divisor

```
current model      ÷ 21 calendar days      $383 / day          3.2× too high
actual run rate    ÷ 67.2 run-days         $120 / run-day      full recovery
theoretical cap    ÷ 189 machine-days       $43 / machine-day   64% unabsorbed
```

**Recommendation: actual run rate (~67), configurable.** Dividing by theoretical
capacity is the stricter accounting position and gives more competitive prices, but
it leaves ~$5,100/month of packaging floor deliberately unrecovered. That is a real
decision, not a rounding choice — see §7.

### A refinement worth considering later

A single blended $120/run-day means bottle jobs subsidise the four sachet machines
sitting at 6%. If the sachet footprint is material, split the packaging pool by line
type and divide each by its own run rate. Start blended; revisit with floor-area
figures per machine.

### Kitting

Kitting is secondary packaging attached to primary jobs, not a job type. It
correctly has no line of its own. It belongs where it already is — the Kitting
column in each calculator's labour matrix. Two consequences:

- Kitting-only days may not be logged at all, so real floor occupancy may exceed
  67.2 run-days and $120 may be an over-estimate.
- If kitters are not counted in the 21.6 people/day, the labour picture is
  incomplete.

---

## 6. Facility pool — needs a driver

$29,893/month, 70% of the rent, consumed by every department including ones with no
production days. Candidate drivers, best first:

| Driver | For | Against |
|---|---|---|
| **Gross margin $** | Every department has it; already derivable from Won workflows by quote type; self-updating | Not causal — a high-margin, low-effort line over-absorbs |
| Revenue | Same availability, simpler | Worse than margin: resale is a thin markup on purchased goods and would absorb far more than it causes |
| Pallet-positions / storage-days | Genuinely causal for the warehouse half | Requires data you may not track |
| Direct labour hours | Good for office and supervision | Useless for warehouse — resale has near-zero labour and real storage |

**Recommendation:** gross margin dollars for both halves initially. Refine the
warehouse half to storage-days if Fishbowl can produce them — it is 40% of the
estate and the biggest single prize for accuracy.

---

## 7. Open decisions

Each of these changes quoted prices. None can be inferred from data I have.

1. **Divisor basis for the production pool** — actual run rate (full recovery,
   ~$120/run-day) or theoretical capacity (~$43/machine-day, ~$5,100/mo
   unabsorbed)? *Affects every CP quote by roughly 3×.*

2. **Suite 400 parallelism.** How many simultaneous cook batches? I have no
   equivalent yield data for manufacturing. *Currently assumed 1.*

3. **Facility-pool driver.** Margin, revenue, or something else? *Affects 70% of
   the rent.*

4. **Does purchased-bulk resale get quoted through this app at all?** If it
   bypasses the calculators, the overhead it should carry is landing nowhere, and
   that is a separate problem from allocation.

5. **Is 21.6 people/day the whole packaging headcount or just machine crews?**
   Determines whether kitting labour is already captured.

6. **What is in "Office / Specialized"?** If part of the 6,846 sq ft is QC lab, it
   arguably belongs with lab testing rather than general office. Suite 500/600
   holding 3,552 sq ft of it is a lot for pure admin.

7. **Finished Product spans two pools.** An FP job makes bulk in Suite 400 and
   packages it in Suite 300. The model has a single `jobDays`, so charging both
   double-counts. Pragmatic fix: a blended share. Correct fix: let a job report
   days per pool — the FP calculator will know both numbers anyway. *Decide before
   the FP calculator is built, not after.*

---

## 8. Implementation, once §7 is settled

Ordered so nothing is built twice:

1. **Re-key departments.** `bottle` → `contract_packaging`, `gummy` →
   `gummy_manufacturing`, add `bulk_resale` and `finished_product`. Two UPDATE
   statements and one string per board. **Do this before five more calculators
   copy the current keys** — it is the same duplication that caused this morning's
   incident.
2. **Add the pool layer** to `overhead_items` (a `pool` column: production /
   facility) and the per-pool divisor to `overhead_settings`.
3. **Change the allocation function** from `÷ working_days` to `÷ pool capacity`.
4. **Facility-pool absorption** — new mechanism, not a variation of the existing one.
5. **Recovery dashboard.** Monthly: charged vs actual plant cost, per pool, with
   idle capacity shown explicitly rather than hidden inside a percentage.

---

## 9. Data quality notes

From `Packaging Yields v2.1` — worth fixing at source, none affect the conclusions
above (all excluded from the analysis):

- **Row 2994, 31 Mar 2026, Blisters: `Hours = 1050`,** should be 10.5. A dropped
  decimal. Inflates March man-hours from 2,456 to 15,969.
- **Row 465 dated 1953-04-06** (Nadovim, Bottles) — probably 2023.
- Four rows with 0 people / 0 hours: one Bottles Oct-25, three Pouches Jan-26.
- Two unusually high crews: 30 on Sachets 17 Jun 2025, 26 on Bottles 22 Jun 2026.
  Both have sane hours; may be genuine all-hands days.

Total Man Hours reconciles to People × Hours on all 3,403 rows — the formula column
is trustworthy throughout.
