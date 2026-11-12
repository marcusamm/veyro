export type Item = {
    id: string;
    name: string;
    form: 'solid' | 'liquid' | 'gas';
    unit?: string;
    resource?: boolean;
};
export type Ingredient = {
    itemId: string;
    amount: number;
};
export type Recipe = {
    id: string;
    name: string;
    machineId: string;
    durationSeconds: number;
    ingredients: Ingredient[];
    products: Ingredient[];
    alternate: boolean;
    powerMW?: number;
    powerMinMW?: number;
    powerMaxMW?: number;
};
export type Machine = {
    id: string;
    name: string;
    powerMW: number;
    powerExponent?: number;
    manufacturingSpeed?: number;
    sloopSlots?: number;
    sloopBoost?: number;
    widthM?: number;
    lengthM?: number;
};
export type FactoryCatalog = {
    provenance: {
        gameVersion: string;
        sourceName: string;
        sourceUrl: string;
        formulaSource: string;
        verifiedAt: string;
        exclusions: string[];
        [key: string]: unknown;
    };
    items: Item[];
    recipes: Recipe[];
    machines: Machine[];
    transport: {
        belts: TransportTier[];
        pipes: TransportTier[];
    };
};
export type TransportTier = {
    id: string;
    name: string;
    tier: number;
    capacity: number;
    unit: string;
};
export type FactorySettings = {
    recipeMultiplier: number;
    powerMultiplier: number;
};
export type NodeKind = 'machine' | 'source' | 'sink' | 'splitter' | 'merger' | 'smart-splitter';
export type FactoryNode = {
    id: string;
    kind: NodeKind;
    label?: string;
    x: number;
    y: number;
    rotation: 0 | 90 | 180 | 270;
    recipeId?: string;
    clock?: number;
    itemId?: string;
    rate?: number;
    sloops?: number;
    filters?: Record<string, string>;
};
export type FactoryEdge = {
    id: string;
    from: string;
    to: string;
    fromPort: string;
    toPort: string;
    itemId: string;
    transport: 'belt' | 'pipe';
    tier: number;
};
export type FactoryLayout = {
    version: 1;
    name: string;
    nodes: FactoryNode[];
    edges: FactoryEdge[];
    settings: FactorySettings;
};
export type MaterialRate = {
    itemId: string;
    rate: number;
};
export type NodePort = {
    id: string;
    direction: 'input' | 'output';
    itemId: string;
    medium: 'belt' | 'pipe';
};
export type FactoryIssue = {
    code: string;
    message: string;
    nodeId?: string;
    edgeId?: string;
};
export type NodeCalculation = {
    utilization: number;
    inputs: MaterialRate[];
    outputs: MaterialRate[];
    actualInputs: MaterialRate[];
    actualOutputs: MaterialRate[];
    powerMW: number;
    actualPowerMW: number;
    powerMinMW: number;
    powerMaxMW: number;
    status: 'running' | 'limited' | 'idle' | 'unsupported';
    issues: string[];
};
export type FactoryCalculation = {
    nodes: Record<string, NodeCalculation>;
    edges: Record<string, {
        rate: number;
        capacity: number;
        saturation: number;
    }>;
    totals: {
        powerMW: number;
        actualPowerMW: number;
        inputs: MaterialRate[];
        outputs: MaterialRate[];
    };
    issues: FactoryIssue[];
    supported: boolean;
};
export function createEmptyFactoryLayout(): FactoryLayout { return { version: 1, name: 'Our factory layout', nodes: [], edges: [], settings: { recipeMultiplier: 1, powerMultiplier: 1 } }; }
