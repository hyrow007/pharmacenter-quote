// Validated against Melissa's "FRIDA PostPartum" sheet (SKU Margins Analysis
// For Blister Work, 2026-08-24): 190,000 unit cartons, blister line at an
// effective 40 blisters/min, packout 1 u/min x 1 person, carton printing
// 20/min station with 2 people, bundling 9/min with 2. Her speeds are STATION
// speeds; this model takes per-person speeds, so station ÷ people below.
//
// Run: node --experimental-strip-types src/lib/blisterCosting.test.mjs
import * as X from './blisterCosting.ts';

const ok = (n, c, e, tol = 1e-6) =>
  console.log(
    (c === e || (typeof c === 'number' && typeof e === 'number' && Math.abs(c - e) < tol)
      ? 'PASS'
      : '**FAIL**'
    ).padEnd(10),
    n, 'got=', c, 'want=', e,
  );

// --- effective line speed: strokes x per-stroke x (1 - penalty)
ok('eff 50x1 @20% = 40', X.effectiveBlistersPerMinute({ strokesPerMinute: 50, blistersPerStroke: 1, speedPenaltyPct: 20 }), 40);
ok('eff 30x4 @20% = 96', X.effectiveBlistersPerMinute({ strokesPerMinute: 30, blistersPerStroke: 4, speedPenaltyPct: 20 }), 96);
ok('eff null penalty -> house 20%', X.effectiveBlistersPerMinute({ strokesPerMinute: 50, blistersPerStroke: 1, speedPenaltyPct: null }), 40);
ok('eff 0 penalty honoured', X.effectiveBlistersPerMinute({ strokesPerMinute: 50, blistersPerStroke: 1, speedPenaltyPct: 0 }), 50);
ok('eff penalty 100 -> null', X.effectiveBlistersPerMinute({ strokesPerMinute: 50, blistersPerStroke: 1, speedPenaltyPct: 100 }), null);
ok('eff no strokes -> null', X.effectiveBlistersPerMinute({ strokesPerMinute: null, blistersPerStroke: 1, speedPenaltyPct: 20 }), null);

// --- FRIDA labour matrix. Station speeds -> per person: packout 1/1=1,
//     cartoning 20/2=10, bundling 9/2=4.5.
const frida = {
  strokesPerMinute: 50, blistersPerStroke: 1, speedPenaltyPct: 20,
  blistersPerUnit: 1,
  packoutSpeed: 1, cartoningSpeed: 10, bundlingSpeed: 4.5,
  setup: { hours: 8, leaders: 0, operators: 2 },
  line: { hours: null, leaders: 0, operators: 3 },
  packout: { hours: null, leaders: 0, operators: 1 },
  cartoning: { hours: null, leaders: 0, operators: 2 },
  bundling: { hours: null, leaders: 0, operators: 2 },
  cleaning: { hours: 2, leaders: 0, operators: 2 },
  leaderRate: 20, operatorRate: 17,
};

ok('FRIDA line hours = her C42', X.blisterProductionHours(190000, frida), 190000 / (40 * 60), 1e-4);
const lb = X.blisterLaborBreakdown(190000, frida);
const ph = Object.fromEntries(lb.phases.map((p) => [p.label, p]));
ok('phases = 6', lb.phases.length, 6);
ok('Packout hours = her C44', ph['Packout'].totalHours, 190000 / (1 * 60), 1e-4);
ok('Cartoning hours = her C46', ph['Cartoning'].totalHours, 190000 / (20 * 60), 1e-4);
ok('Bundling hours = her C47', ph['Bundling'].totalHours, 190000 / (9 * 60), 1e-4);
// Her per-carton labour figures are hours x station heads x rate / qty; man
// hours here must match hours x people.
ok('Cartoning man hours', ph['Cartoning'].operatorManHours, (190000 / (20 * 60)) * 2, 1e-3);
ok('Bundling man hours', ph['Bundling'].operatorManHours, (190000 / (9 * 60)) * 2, 1e-3);
// Occupancy: hand stations run alongside the line; packout is the long pole.
ok('occupancy = setup+clean+max', lb.occupancyHours, 8 + 2 + 190000 / 60, 1e-3);

// --- multi-blister finished unit: 10,000 cartons x 2 blisters at eff 96
const multi = { ...frida, strokesPerMinute: 30, blistersPerStroke: 4, blistersPerUnit: 2 };
ok('line hours scale with blisters/unit', X.blisterProductionHours(10000, multi), 20000 / (96 * 60), 1e-6);

// --- typed hours beat the derivation on a hand station
const typed = { ...frida, packout: { hours: 100, leaders: 0, operators: 1 } };
ok('typed packout hours win', X.blisterLaborBreakdown(190000, typed).phases[2].totalHours, 100);

// --- blank speed = station skipped, not blocked
const noBundle = { ...frida, bundlingSpeed: null };
ok('no bundling speed -> 0 h', X.blisterLaborBreakdown(190000, noBundle).phases[4].totalHours, 0);

// --- no line speed -> null breakdown (never a guess)
ok('no speeds -> null', X.blisterLaborBreakdown(190000, { ...frida, strokesPerMinute: null }), null);

// --- top level: film+foil per blister ride blistersPerUnit; her waste
//     convention (yield form) applies. Film $0.03/ea 15% waste, foil $0.12/ea
//     20% waste, carton $0.721 3% waste, 2 blisters per carton.
const bom = [
  { id: 'f', slot: 'other', fpCode: 'PC-PK-F', name: 'film', qtyPerUnit: 2, costPerUnit: 0.03, costStatus: 'ok', suppliedBy: 'pharmacenter', costSource: 'Fish Bowl (Inventory)', wastePct: 15 },
  { id: 'l', slot: 'other', fpCode: 'PC-PK-L', name: 'foil', qtyPerUnit: 2, costPerUnit: 0.12, costStatus: 'ok', suppliedBy: 'pharmacenter', costSource: 'Fish Bowl (Inventory)', wastePct: 20 },
  { id: 'c', slot: 'carton', fpCode: 'PC-PK-C', name: 'carton', qtyPerUnit: 1, costPerUnit: 0.721, costStatus: 'ok', suppliedBy: 'pharmacenter', costSource: 'Fish Bowl (Inventory)', wastePct: 3 },
];
const expectMat = (2 * 0.03) / 0.85 + (2 * 0.12) / 0.8 + 0.721 / 0.97;
const r = X.computeBlisterCosting({
  quantity: 10000,
  bom,
  labor: multi,
  overhead: { rentLease: [], indirectLabor: [], other: [], workingDaysPerMonth: 21, leasePerRunDay: 1027.95, indirectPerRunDay: 305.8, otherPerRunDay: 110.82 },
  labTesting: { rawMaterials: [], finishedProduct: [] },
  pricing: { marginPct: 30, marginMode: 'gross-margin', hosCommissionPct: 0.5, repCommissionPct: 3 },
});
ok('materials per unit', r.materialsPerUnit, expectMat, 1e-9);
ok('production hours', r.productionHours, 20000 / (96 * 60), 1e-6);
ok('cost resolves', r.costPerUnit !== null, true);
// gross-margin algebra: sale = cost / (1 - 0.30 - 0.035)
ok('sale algebra', r.salePerUnit, r.costPerUnit / (1 - 0.3 - 0.035), 1e-9);

// --- re-exports intact: the generic machinery must be THE bottle machinery
ok('re-export roundDays', X.roundDays(1.25), 2);
ok('re-export breakeven', X.BREAKEVEN_OP_PROFIT_PER_RUN_DAY, 1745);
