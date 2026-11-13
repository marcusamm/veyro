import { catalog, itemById, machineById, recipeById } from './engine';
import type { MaterialRate } from './types';
import type { ProductionPlan, ProductionRequest } from './production';

export type FactoryTemplate = {
  id: string;
  title: string;
  description: string;
  category: 'Starter' | 'Assembly' | 'Steel' | 'Fluids';
  difficulty: 'Beginner' | 'Intermediate' | 'Advanced';
  outputs: MaterialRate[];
  /** The authored recipe chain keeps the build instructions reproducible. */
  recipeIds: string[];
  alternateRecipeIds?: string[];
  steps: string[];
  tips: string[];
};

const iron = 'Recipe_IngotIron_C', rods = 'Recipe_IronRod_C', plates = 'Recipe_IronPlate_C';
const screws = 'Recipe_Screw_C', copper = 'Recipe_IngotCopper_C', wire = 'Recipe_Wire_C';
const steel = 'Recipe_IngotSteel_C', reinforced = 'Recipe_IronPlateReinforced_C';
const rotor = 'Recipe_Rotor_C', pipes = 'Recipe_SteelPipe_C';

export const factoryTemplates: FactoryTemplate[] = [
  {
    id: 'iron-plates', title: 'Iron plate starter', category: 'Starter', difficulty: 'Beginner',
    description: 'A dedicated ore-to-plate line for foundations, machines and the next assembly stage.',
    outputs: [{ itemId: 'Desc_IronPlate_C', rate: 60 }], recipeIds: [iron, plates],
    steps: ['Place smelters first, then a separate row of Iron Plate constructors.', 'Feed the ore along a splitter manifold. Merge the ingots only onto belts that can carry the combined flow.', 'Connect the plate output to storage or the next factory; keep a clear route for extending both rows.'],
    tips: ['Fill the first machines before judging a manifold: the downstream machines take time to receive their share.', 'The output rate is for the entire module, not for each constructor.'],
  },
  {
    id: 'iron-rods', title: 'Iron rod starter', category: 'Starter', difficulty: 'Beginner',
    description: 'A simple iron-rod module that can feed storage, screws or assemblers.',
    outputs: [{ itemId: 'Desc_IronRod_C', rate: 60 }], recipeIds: [iron, rods],
    steps: ['Place the ore smelters upstream of the rod constructors.', 'Use one ingot manifold with a splitter at each constructor input. Recalculate before attaching any extra consumer.', 'Merge the rod outputs into storage, or connect them to a downstream module as an external input.'],
    tips: ['Reserve rods for assembly before sending the remainder to screw production.', 'Use the calculated final-machine clock when the selected scale does not require a full machine.'],
  },
  {
    id: 'screws', title: 'Screw workshop', category: 'Starter', difficulty: 'Beginner',
    description: 'The standard ingot → rod → screw chain, with the high-volume screw belts made explicit.',
    outputs: [{ itemId: 'Desc_IronScrew_C', rate: 120 }], recipeIds: [iron, rods, screws],
    steps: ['Build the smelter row, rod constructors and screw constructors in that order.', 'Feed rods to the screw constructors through a splitter manifold. Each screw constructor still needs its own input belt.', 'Keep screw outputs on separate belts until a merger and its outgoing belt can handle their combined rate.'],
    tips: ['Screws multiply the item count: the outgoing belt often needs a higher tier than the incoming rod belt.', 'Place this module close to the consuming assemblers to shorten high-volume screw runs.'],
  },
  {
    id: 'wire', title: 'Copper wire workshop', category: 'Starter', difficulty: 'Beginner',
    description: 'Copper ore to wire for building supplies and later electrical assemblies.',
    outputs: [{ itemId: 'Desc_Wire_C', rate: 120 }], recipeIds: [copper, wire],
    steps: ['Feed copper ore into the smelters and group wire constructors after them.', 'Split ingots across the wire constructors. Check the combined output rate before merging the wire belts.', 'Send the finished wire to storage or define it as an external input in another production plan.'],
    tips: ['A full wire output belt must not also feed an unaccounted-for cable branch.', 'Leave room next to the wire row if you intend to add a separate cable module later.'],
  },
  {
    id: 'cable', title: 'Cable workshop', category: 'Starter', difficulty: 'Beginner',
    description: 'A complete copper-to-cable line with its wire production included.',
    outputs: [{ itemId: 'Desc_Cable_C', rate: 60 }], recipeIds: [copper, wire, 'Recipe_Cable_C'],
    steps: ['Place copper smelters, wire constructors and cable constructors as three production stages.', 'Merge and split the wire between stages using the calculated wire throughput, not the lower final cable rate.', 'Collect the cable in storage and check that no wire is diverted away from its required inputs.'],
    tips: ['This template consumes its wire internally; it does not provide spare wire at the listed cable target.', 'For wire and cable together, add a separate wire output target and recalculate the full chain.'],
  },
  {
    id: 'concrete', title: 'Concrete supply', category: 'Starter', difficulty: 'Beginner',
    description: 'Limestone to concrete with no smelting or intermediate parts.',
    outputs: [{ itemId: 'Desc_Cement_C', rate: 60 }], recipeIds: ['Recipe_Concrete_C'],
    steps: ['Bring the calculated limestone supply to a row of concrete constructors.', 'Split the limestone along the row, respecting the capacity of the first, busiest belt section.', 'Merge concrete to storage. Provide additional storage or continuous consumption if the line must run without stopping.'],
    tips: ['The limestone input carries more items than the concrete output.', 'Check the miner and resource-node purity in the game; the production guide starts at the supplied limestone.'],
  },
  {
    id: 'reinforced-plates', title: 'Reinforced plate assembly', category: 'Assembly', difficulty: 'Intermediate',
    description: 'Separate plate and screw branches feeding standard reinforced-plate assemblers.',
    outputs: [{ itemId: 'Desc_IronPlateReinforced_C', rate: 10 }], recipeIds: [iron, plates, rods, screws, reinforced],
    steps: ['Build the iron smelting stage, then separate the plate branch from the rod-and-screw branch.', 'Run a plate manifold to one assembler input and a screw manifold to the other. Do not mix the two items on one manifold.', 'Set the assemblers to Reinforced Iron Plate and collect their combined output. Check both input buffers before judging the final rate.'],
    tips: ['High screw demand can be hidden by a slow final item rate; check screw belts separately.', 'Use the machine table for how many ingots each branch needs, rather than splitting every branch into equal shares.'],
  },
  {
    id: 'rotors', title: 'Rotor assembly', category: 'Assembly', difficulty: 'Intermediate',
    description: 'A standard rotor line with rod supply reserved separately from screw manufacture.',
    outputs: [{ itemId: 'Desc_Rotor_C', rate: 8 }], recipeIds: [iron, rods, screws, rotor],
    steps: ['Smelt iron and make the full calculated rod requirement.', 'Split rods into a direct assembler supply and a screw-production supply. A plain splitter manifold can balance after buffers fill; verify each branch demand.', 'Deliver rods and screws on separate belts to the rotor assemblers, then merge the finished rotors.'],
    tips: ['The direct rod branch and the rods consumed by screws are both included in the calculation.', 'Avoid merging every screw onto a low-tier belt before splitting it again.'],
  },
  {
    id: 'modular-frames', title: 'Modular frame assembly', category: 'Assembly', difficulty: 'Intermediate',
    description: 'An ore-to-frame module including reinforced plates, screws and the direct rod branch.',
    outputs: [{ itemId: 'Desc_ModularFrame_C', rate: 4 }], recipeIds: [iron, plates, rods, screws, reinforced, 'Recipe_ModularFrame_C'],
    steps: ['Build the iron branches for plates and rods. Separate rods used by screws from rods needed by the final assemblers.', 'Complete and fill the reinforced-plate stage before starting the frame assembly.', 'Feed reinforced plates and rods into separate inputs of each Modular Frame assembler; collect frames in the final storage.'],
    tips: ['Do not size the reinforced-plate workshop from its rounded machine count; use the exact required rate and clocks.', 'Low-rate final assemblies are a useful place to inspect buffers while upstream manifolds warm up.'],
  },
  {
    id: 'steel-beams', title: 'Steel beam mill', category: 'Steel', difficulty: 'Intermediate',
    description: 'Iron ore and coal through foundries to construction steel beams.',
    outputs: [{ itemId: 'Desc_SteelPlate_C', rate: 45 }], recipeIds: [steel, 'Recipe_SteelBeam_C'],
    steps: ['Place the steel foundries with independent iron-ore and coal manifolds.', 'Merge steel ingots into capacity-safe lines and distribute them to Steel Beam constructors.', 'Collect beams after the constructor row; leave both foundry-input manifolds accessible for expansion.'],
    tips: ['The standard steel recipe uses raw iron ore, not smelted iron ingots.', 'Both resource supplies must sustain the listed rate; extra coal does not compensate for missing iron.'],
  },
  {
    id: 'steel-pipes', title: 'Steel pipe mill', category: 'Steel', difficulty: 'Intermediate',
    description: 'A compact foundry-and-constructor chain for steel pipes.',
    outputs: [{ itemId: 'Desc_SteelPipe_C', rate: 60 }], recipeIds: [steel, pipes],
    steps: ['Supply iron ore and coal to the foundries on separate manifolds.', 'Feed steel ingots from the foundries to a row of Steel Pipe constructors.', 'Merge the solid steel-pipe items onto conveyor belts and route them to storage or stator assembly.'],
    tips: ['Steel Pipe is a solid item transported on belts; it is not transported in fluid pipelines.', 'If this line also supplies another factory, include that factory’s demand before scaling the module.'],
  },
  {
    id: 'motors', title: 'Motor assembly', category: 'Assembly', difficulty: 'Advanced',
    description: 'An integrated motor factory with separate rotor and stator production.',
    outputs: [{ itemId: 'Desc_Motor_C', rate: 5 }], recipeIds: [iron, rods, screws, rotor, copper, wire, steel, pipes, 'Recipe_Stator_C', 'Recipe_Motor_C'],
    steps: ['Build the iron/rod/screw branch for rotors, alongside a separate copper/wire branch.', 'Feed iron ore and coal to the foundries; send steel pipes and wire to the stator assemblers.', 'Bring completed rotors and stators to the two inputs of the motor assemblers. Keep both intermediate assembly stages running before measuring motor output.'],
    tips: ['Reserve iron ore separately for ordinary smelting and steel foundries.', 'Each stage’s clocks are calculated independently; copying the final assembler clock to every upstream machine changes the balance.'],
  },
  {
    id: 'plastic-rubber', title: 'Plastic & rubber refinery', category: 'Fluids', difficulty: 'Advanced',
    description: 'Standard plastic and rubber production with heavy oil residue processed into removable petroleum coke.',
    outputs: [{ itemId: 'Desc_Plastic_C', rate: 40 }, { itemId: 'Desc_Rubber_C', rate: 40 }, { itemId: 'Desc_PetroleumCoke_C', rate: 180 }],
    recipeIds: ['Recipe_Plastic_C', 'Recipe_Rubber_C', 'Recipe_PetroleumCoke_C'],
    steps: ['Split the crude-oil pipeline between dedicated Plastic and Rubber refinery rows.', 'Connect both heavy-oil-residue outputs to the Petroleum Coke refinery input network. Keep crude oil and residue in different pipe systems.', 'Connect plastic, rubber and coke outputs to belts. Send coke to continuous consumption or an AWESOME Sink; a full storage container eventually stops the refinery chain.'],
    tips: ['Coke is an intentional third output so heavy oil residue has a continuous exit.', 'Fill the oil network and check head lift before startup; the guide calculates flow, not pipe pressure or pump placement.'],
  },
  {
    id: 'aluminum-sheets', title: 'Aluminum sheet works', category: 'Fluids', difficulty: 'Advanced',
    description: 'Bauxite to alclad sheets, including silica, copper and a recovered-water loop.',
    outputs: [{ itemId: 'Desc_AluminumPlate_C', rate: 60 }],
    recipeIds: ['Recipe_AluminaSolution_C', 'Recipe_AluminumScrap_C', 'Recipe_IngotAluminum_C', 'Recipe_AluminumSheet_C', 'Recipe_Silica_C', copper],
    steps: ['Build alumina-solution and aluminum-scrap refineries as one recycling group. Feed bauxite to the first and coal to the second.', 'Return scrap-refinery water to the alumina input. The listed fresh-water requirement is the net steady-state makeup; initially fill the loop and prevent the fresh supply from blocking recycled water.', 'Merge recovered silica with separately produced silica, then feed silica and scrap to aluminum foundries.', 'Bring aluminum ingots and copper ingots to the Alclad Aluminum Sheet assemblers. Keep all liquid and solid byproduct exits available.'],
    tips: ['A correct material balance does not guarantee a stable in-game water junction; inspect fill levels, backflow and head lift during commissioning.', 'The recycled water is already credited. Supplying the full gross alumina water demand as fresh water can block the scrap refineries.'],
  },
];

export function templateRequest(template: FactoryTemplate | string, scale = 1, options: Partial<ProductionRequest> = {}): ProductionRequest {
  const selected = typeof template === 'string' ? factoryTemplates.find(t => t.id === template) : template;
  if (!selected) throw new Error('Unknown factory template.');
  if (!Number.isFinite(scale) || scale <= 0 || scale > 1000) throw new Error('Template scale must be greater than 0 and at most 1,000.');
  const included = new Set(selected.recipeIds);
  return {
    mode: 'target', optimization: 'resources', clock: 100, beltTier: 3, pipeTier: 1,
    settings: { recipeMultiplier: 1, powerMultiplier: 1 }, inputs: [],
    allowedAlternates: [...(selected.alternateRecipeIds ?? [])],
    excludedRecipes: catalog.recipes.filter(recipe => !included.has(recipe.id)).map(recipe => recipe.id),
    ...options,
    outputs: selected.outputs.map(output => ({ ...output, rate: output.rate * scale })),
  };
}

export type BuildGuideStep = { id: string; title: string; details: string[] };
export type BuildGuide = {
  steps: BuildGuideStep[];
  machines: { machineId: string; name: string; count: number }[];
  warnings: string[];
};
const format = (number: number) => new Intl.NumberFormat('en-GB', number !== 0 && Math.abs(number) < 0.0001 ? { maximumSignificantDigits: 4 } : { maximumFractionDigits: 4 }).format(number);
const itemName = (id: string) => itemById[id]?.name ?? id;
const rateText = (row: MaterialRate) => `${format(row.rate)} ${itemById[row.itemId]?.form === 'solid' ? 'items/min' : 'm³/min'} ${itemName(row.itemId)}`;

/** Condense actual recipe dependencies so a recycling loop is built as a group. */
function productionStages(plan: ProductionPlan): string[][] {
  const ids = plan.recipes.map(row => row.recipeId);
  const next = new Map(ids.map(id => [id, new Set<string>()]));
  for (const producer of plan.recipes) for (const consumer of plan.recipes) {
    if (producer.outputs.some(output => output.rate > 1e-8 && consumer.inputs.some(input => input.itemId === output.itemId && input.rate > 1e-8))) next.get(producer.recipeId)!.add(consumer.recipeId);
  }
  let index = 0;
  const indices = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], stacked = new Set<string>(), components: string[][] = [];
  function visit(id: string) {
    indices.set(id, index); low.set(id, index++); stack.push(id); stacked.add(id);
    for (const child of next.get(id)!) {
      if (!indices.has(child)) { visit(child); low.set(id, Math.min(low.get(id)!, low.get(child)!)); }
      else if (stacked.has(child)) low.set(id, Math.min(low.get(id)!, indices.get(child)!));
    }
    if (low.get(id) === indices.get(id)) {
      const group: string[] = []; let member: string;
      do { member = stack.pop()!; stacked.delete(member); group.push(member); } while (member !== id);
      components.push(group.reverse());
    }
  }
  for (const id of ids) if (!indices.has(id)) visit(id);
  // Tarjan emits dependencies last for producer-to-consumer edges.
  return components.reverse();
}

export function generateBuildGuide(plan: ProductionPlan): BuildGuide {
  if (plan.status !== 'optimal') return { steps: [], machines: [], warnings: [plan.message || 'A feasible production plan is required before building.'] };
  const machineCounts = new Map<string, number>();
  for (const row of plan.recipes) machineCounts.set(row.machineId, (machineCounts.get(row.machineId) ?? 0) + row.machineCount);
  const machines = [...machineCounts].map(([machineId, count]) => ({ machineId, name: machineById[machineId]?.name ?? machineId, count })).sort((a, b) => a.name.localeCompare(b.name));
  const steps: BuildGuideStep[] = [{ id: 'supplies', title: 'Bring in the required supplies', details: [
    ...plan.resources.map(row => `Supply ${rateText(row)} from resource extraction.`),
    ...plan.externalInputs.map(row => `Reserve ${rateText(row)} from the existing factory.`),
    ...((plan.totals.powerShards || plan.totals.somersloops) ? [`Reserve ${plan.totals.powerShards} Power Shard${plan.totals.powerShards === 1 ? '' : 's'} and ${plan.totals.somersloops} Somersloop${plan.totals.somersloops === 1 ? '' : 's'} for the production-machine groups below. These are installed totals, not rates per minute.`] : []),
    'These are net steady-state inputs. Check extraction capacity and node purity in the game; prime any fluid recycling loop before starting.',
  ] }];
  for (const [index, ids] of productionStages(plan).entries()) {
    const rows = ids.map(id => plan.recipes.find(row => row.recipeId === id)!);
    const recycling = rows.length > 1 || rows.some(row => row.outputs.some(output => row.inputs.some(input => input.itemId === output.itemId)));
    const details = rows.flatMap(row => {
      const machineName = machineById[row.machineId]?.name ?? row.machineId;
      const variants = row.variants?.length ? row.variants : [row];
      return variants.flatMap((variant, variantIndex) => {
        const groupName = variants.length > 1 ? `${recipeById[row.recipeId]?.name ?? row.recipeId}, group ${variantIndex + 1}: ` : '';
        const lastIsDifferent = Math.abs(variant.lastClock - variant.clock) > 0.0001;
        const clocks = lastIsDifferent
          ? `${variant.machineCount > 1 ? `${variant.machineCount - 1} at ${format(variant.clock)}%, then ` : ''}1 at ${format(variant.lastClock)}%`
          : `${variant.machineCount} at ${format(variant.clock)}%`;
        const settings = `${groupName}Place ${variant.machineCount} × ${machineName}; select ${recipeById[row.recipeId]?.name ?? row.recipeId}; set ${clocks}.`;
        const boosts = [
          ...(variant.powerShards > 0 ? [`Install ${variant.powerShards} Power Shards across this group to unlock the listed clock settings.`] : []),
          ...(variant.sloops > 0 ? [`Install ${variant.sloops} Somersloop${variant.sloops === 1 ? '' : 's'} in each machine (${variant.sloops * variant.machineCount} total for this group). The calculated output and power already include this boost.`] : variants.length > 1 ? ['Leave the Somersloop slots empty in this group; its output is not amplified.'] : []),
          ...(variant.clockLimited ? ['The chosen belt or pipe tier limits this recipe’s per-machine throughput. Follow the clock settings listed for this group; increase transport capacity and recalculate before overclocking further.'] : []),
        ];
        const duty = variant.dutyCycle < 1 - 1e-6 ? [`The final machine in this group needs intermittent operation (${format(variant.dutyCycle * 100)}% on-time); its minimum continuous clock cannot meet this tiny target exactly.`] : [];
        return [settings, ...boosts, `Feed this group: ${variant.inputs.map(rateText).join('; ') || 'no ingredients'}.`, `Collect from this group: ${variant.outputs.map(rateText).join('; ')}.`, ...duty];
      });
    });
    if (recycling) details.push('Connect all return flows within this group before commissioning. Prime the loop, and allow the net fresh supply without blocking recovered material.');
    steps.push({ id: `stage-${index + 1}`, title: recycling ? `Build recycling group ${index + 1}` : `Build ${recipeById[ids[0]]?.name ?? ids[0]} production`, details });
  }
  steps.push({ id: 'connections', title: 'Connect the stages and check capacity', details: [
    ...plan.transports.filter(row => row.rate > 1e-8).map(row => `${itemName(row.itemId)}: ${format(row.rate)} ${row.transport === 'belt' ? 'items/min' : 'm³/min'}; at least ${row.lines} parallel ${row.transport === 'belt' ? 'belt' : 'pipe'} line${row.lines === 1 ? '' : 's'} at Mk.${row.tier} (${format(row.capacity)} per line).`),
    'These line counts are aggregate capacity lower bounds, not a routing blueprint. Give each machine input and output enough capacity; use parallel manifolds when one trunk cannot carry the total.',
    'Keep different solid items on separate manifolds, split towards consumers and merge only within the outgoing belt capacity. Fluid circuits use pipe junctions rather than conveyor splitters.',
  ] });
  steps.push({ id: 'outputs', title: 'Keep finished products and byproducts moving', details: [
    ...plan.products.map(row => `Deliver ${rateText(row)} to storage or its next consumer.`),
    ...plan.surplus.filter(row => row.rate > 1e-8).map(row => `Provide a continuous exit for ${rateText(row)} surplus. ${itemById[row.itemId]?.form === 'solid' ? 'Use a suitable consumer or sink where the game permits.' : 'Consume or recycle the fluid; a buffer alone eventually fills and blocks production.'}`),
    'If every output container fills, production stops. Storage is a buffer, not permanent byproduct disposal.',
  ] });
  steps.push({ id: 'power-startup', title: 'Power up and commission the module', details: [
    `Connect ${plan.totals.machines} production machines. Production draw is ${format(plan.totals.powerMW)} MW${Math.abs(plan.totals.powerMaxMW - plan.totals.powerMinMW) > 1e-6 ? ` on average, varying from ${format(plan.totals.powerMinMW)} to ${format(plan.totals.powerMaxMW)} MW` : ''}. Allow capacity for the ${format(plan.totals.powerMaxMW)} MW production peak plus extraction, pumps and other equipment.`,
    'Start the supply stages, let belts and pipe networks fill, then enable downstream machines. A manifold may need time to fill before every machine runs continuously.',
    'Verify each recipe, clock, ingredient supply and byproduct exit. Compare the finished rate after buffers stabilise, and inspect any saturated transport sections.',
  ] });
  return { steps, machines, warnings: [...new Set([
    ...plan.warnings,
    'This is a production schematic and build sequence. Physical footprints, foundation dimensions, port positions and clearance are not verified.',
    'The machine checklist counts production buildings. Use the separate construction bill for build parts; plan site-specific belts, pipes, foundations and power connections separately.',
  ])] };
}
