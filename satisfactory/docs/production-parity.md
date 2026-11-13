# Production planner: reference and verification

This is an independent implementation of the production-planning workflow, not a
claim that every Satisfactory Calculator feature has been reproduced. The live
reference could not be exercised from the research environment, so parity is
checked against its public source and explicit numerical fixtures, rather than an
automated comparison with the live website.

## Reference pin

- [SC Production Planner, commit `98e125a8f9c54a25cf9611acf423a12b41361048`](https://github.com/AnthorNet/SC-ProductionPlanner/tree/98e125a8f9c54a25cf9611acf423a12b41361048)
- [Solver source at that commit](https://github.com/AnthorNet/SC-ProductionPlanner/blob/98e125a8f9c54a25cf9611acf423a12b41361048/src/LinearProgram/Solver.js)
- Local recipes: Satisfactory **1.2.5.0**, Steam build **26281294**; the exact
  snapshot and attribution are recorded in [NOTICE](../app/factory/data/NOTICE.md).

No SC website code or artwork is bundled. The LP solver is adapted from this
application's existing network solver. The reference commit's data selection does
not establish which data build the live website currently serves.

## Implemented behavior

- Multiple requested outputs and supplied inputs in items/min or m³/min.
- Complete upstream expansion through simultaneous material-balance constraints,
  including shared intermediates, coproducts and recycling loops.
- Alternate recipes, explicitly enabled resource converters, excluded recipes and
  explicit main-product recipe overrides. Selecting alternates for a requested
  output forces that selected set of primary producers; intermediate alternates
  otherwise compete. Other recipes' byproducts of a forced item become surplus.
- Target production and maximum production. Maximum production first increases
  the common target ratio, then maximizes weighted additional outputs from spare
  capacity. If additional output is unbounded, it falls back to the bounded common
  ratio, matching the reference's fallback.
- Lexicographic objectives: resources → buildings; power → resources → buildings;
  or buildings → resources. Resource weights use the reference's approximate map
  availability weights, including zero cost for water. These weights are not an
  inventory of the user's save or a promise of current map resource limits.
- Global and per-recipe requested clock speeds, selected belt/pipe tiers and
  per-recipe Somersloops **per machine**. Each machine's effective clock respects
  its individual input/output port capacity. Physical machine counts are rounded
  up; the final machine is underclocked and its actual nonlinear power calculated.
- Optional global Somersloop inventory. The model offers unboosted and boosted
  recipe variants, rounds an initial feasible whole-machine allocation and runs
  depth-first branch-and-bound, bounded at 40 nodes / 400 ms. The result accounts
  for entire installed items, including partial machines. A bounded-search warning
  means the returned allocation is feasible but may not be the best possible one.
  Automatic amplified variants run at at most 100% and must fit transport at 100%,
  as in the pinned reference. Without an inventory, per-recipe manual boosts remain.
- Optional global Power Shard allocation across production and modeled extraction.
  A physical pass removes one building at the lowest extra shard cost, with
  extraction first on ties and 50-percentage-point unlock steps. Port capacities
  and requested maximum clocks still apply. Amplified groups remain at or below
  100%; unused shards are reported when further allocation cannot remove a building.
- Recipe-cost settings round solid amounts per cycle and fluid quantities in raw
  litres before converting back to m³. Output and power multipliers are independent.
- Explicit infeasible/unbounded/error states. Calculations run off the UI thread.
  Active recipe networks are re-solved before rendering, and material balances
  are verified; tiny LP artifacts are not silently hidden from the graph.
- A default manifold layout with individual production machines, separate material
  rails, explicit conveyor splitters/mergers and pipeline junctions. Parallel rails
  respect the selected belt/pipe capacity; the model checks each trunk and branch,
  reserving capacity for connected machines running simultaneously. Connections
  between stages, raw-input feeds, final outputs and surplus destinations have
  explicit branching/combining junctions as needed.
- Exact construction quantities for the generated production buildings, modeled
  extractors and manifold junctions, with installed boosts listed separately. The
  construction supplement contains 20 verified build-gun recipes from the same
  pinned snapshot: 11 production machines, five extractors and four junction types.
  The manifold model currently uses the standard splitter, merger and four-way
  pipeline junction; the supplement also retains the verified pipeline T-junction.
- Scalable production templates, numeric build guides, flow graphs, machine lists
  and surplus/startup warnings. The downloadable guide includes each manifold's
  machine settings, trunk/branch wiring, connections between modules, junction
  material bill and startup sequence. Shared requests persist separately from
  the manual layout and original documents.

## Numerical regression fixtures

Unless specified otherwise, use normal recipes, 100% clock, no Somersloops and 1×
recipe/power settings. Resource supplies are available and transport is sufficient.

| Request | Expected result |
| --- | --- |
| 60 Iron Plates/min from raw resources | 90 Iron Ore/min; 3 Smelters + 3 Constructors; 24 MW production power |
| 5 Reinforced Iron Plates/min | 60 Iron Ore/min; 30 Plates/min + 60 Screws/min internally; 8 physical production machines |
| 20 Plates + 15 Rods/min | 45 Iron Ore/min, with shared ingot production |
| Maximize Plates:Rods = 1:1 from 60 supplied Ingots/min | 24 Plates + 24 Rods/min |
| Maximize Plates:Wire = 1:1 from 60 Iron Ore + 30 Copper Ore/min | Common multiplier 40, then 40 Plates + 60 Wire/min after residual allocation |
| Same maximum targets with only Iron Ore capped | 40 Plates + 40 Wire/min; uncapped extra Wire would be unbounded, so ratio fallback is used |
| 50 Cast Screws/min from supplied Ingots | 12.5 Ingots/min; 1 Constructor; no Rod step |
| 20 Plastic/min, Plastic recipe only | 30 m³ Crude Oil/min; 10 m³ Heavy Oil Residue/min surplus |
| 60 Aluminum Ingots/min, authored standard chain | 60 Bauxite, 30 Coal, 30 Raw Quartz and net 60 m³ Water/min; 30 m³ Water/min recycled against gross demand 90 |
| 60 Plastic/min, only Recycled Plastic + Recycled Rubber, supplied Fuel | 60 m³ Fuel/min; 4/3 and 2/3 refinery equivalents respectively; startup stock required |
| 100 Screws/min, supplied Rods, requested 250%, Mk.1 belts | Effective full-machine clock 150%; 2 Constructors at 150% and 100% |
| Iron Plate recipe cost 0.5× | 3 Ingots × 0.5 rounds to 2 per cycle: 20 Ingots/min, not 15; output remains 20 Plates/min |
| 60 Plates/min, automatic Somersloop inventory 1 | 60 Ore/min; 2 Smelters; one normal Constructor + one Constructor with 1 Somersloop |
| 60 Plates/min, automatic inventory 2 | 30 Ore/min; 1 boosted Smelter; one normal + one boosted Constructor |
| 30 Plates/min from 45 supplied Ingots/min, maximum clock 250%, shard budget 1 | 1 Constructor at 150%, using 1 shard; material flows unchanged |
| 30 Plates/min from raw resources, impure Mk.1 miners, maximum clocks 250%, shard budget 1 | The shard goes to extraction on a tie: 1 Miner at 150%; production retains 2 Smelters + 2 Constructors |

`tests/factory-production.test.mjs` and `tests/factory-engine.test.mjs` contain
these and failure-mode checks. Template and graph tests additionally validate all
authored factories at multiple scales. Allocation and construction tests cover
shared shard budgets, transport-limited clocks, verified junction costs and refusal
to turn incomplete manifold counts into an inventory bill. A development sweep also checked every
catalog item produced by a recipe with all alternates/converters enabled: 126
feasible targets, 13 requiring unavailable external materials, and no numerical
solver failures. That sweep is diagnostic evidence, not proof of universal parity.

## Material differences and limits

1. **Input caps follow calculation mode by default.** Target mode supplements
   supplied inputs from production/extraction; maximize mode caps named input
   sources. Either behavior can be selected explicitly. Recovered byproducts can
   be reused. Unnamed raw resources remain available unless the closed resource
   budget is selected. Input rates and resource availability are separate concepts.
2. **Boost allocation is bounded.** Automatic Somersloop mode uses the reference's
   relaxation/greedy/bounded-branch strategy; it does not prove a global optimum
   once the search limit is reached. Numerical tolerances, tie-breaking and runtime
   can yield a different valid allocation from the live reference. Integer
   inventory and material conservation are always checked before returning it.
   Manual per-recipe boosts apply to every machine in that group and do not impose
   a global inventory. Power-Shard allocation is a separate physical-layout pass,
   not part of the recipe-choice LP.
3. **Production and extraction are distinct.** The LP objectives and
   `ProductionPlan.totals` cover production machines. Any extraction estimate is
   a separate estimate from the selected miner/purity settings. Power-grid design,
   generators, pumps, standby draw and extraction alternatives are not jointly
   optimized with production. The power objective uses nominal recipe coefficients;
   final displayed production power uses the actual rounded machine allocation.
4. **Aggregate transport summaries and explicit manifolds have different scope.**
   Aggregate line counts remain lower bounds. The generated manifold instead
   includes individual machines, capacity-checked trunks/branches, parallel rails
   and junctions between stages. Its component bill covers all junctions in that
   generated design, not just the recipe rows. It uses one binary junction per
   added branch and leaves spare ports unused; it does not optimize for minimum
   junction count or claim the same junction choices/counts as Satisfactory
   Calculator. Ordinary splitter demand labels are steady-state requirements,
   not programmable ratios. Fluid junctions do not enforce direction or recycled
   fluid priority. No head-lift, pipe fill/backflow, round-robin timing, train
   schedule or game-tick simulation is provided. Below 1% clock, the final machine
   needs intermittent operation; the schematic reserves its running-rate capacity
   while power distinguishes the average from its active peak.
5. **Manifold detail has a 250-production-machine limit.** Larger plans retain
   the production result and aggregate summaries, but exact junction counts,
   per-machine wiring instructions and the junction construction bill are marked
   unavailable. No truncated preview is presented as a complete material list.
   Reduce the target or divide the factory into modules to obtain this detail.
6. **The drawing is schematic.** Machine footprints, foundations, collision
   clearances, belt geometry and physical connector positions are not verified
   in-game. Belt/pipe lengths, supports, pumps, valves and power-distribution
   construction costs are not counted. Templates and downloadable guides are
   build instructions, not importable game blueprint/save files.
7. **Dataset boundaries remain explicit.** FICSMAS, handcraft-only and
   workshop-only recipes are excluded. Gathered items or nuclear waste outside
   modeled production require explicit inputs. The catalog does not auto-update
   and exact live-reference recipe/data-version equality is not verified.
8. **Finite numeric computation.** The LP uses floating point and work limits;
   infeasible, unbounded and failed numerical checks are reported rather than
   replaced with approximate success. Runtime feasibility checks do not prove
   equality for every alternative recipe combination and reference option.

## Persistence

Migration `0004_production_plan.sql` adds the separate `factory_production_plans` table.
Authenticated `GET /api/production` and revision-checked `PUT /api/production` use
the existing player permissions and same-origin protections. Applying a template
changes a draft; it does not overwrite another player's save without the normal
revision check or modify the shared manual factory layout.
