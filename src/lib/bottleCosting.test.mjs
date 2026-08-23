import * as B from './bottleCosting.ts';
const ok=(n,c,e)=>console.log((Math.abs((c??-1)-(e??-1))<1e-9?'PASS':'**FAIL**').padEnd(10),n,'got=',c,'want=',e);

// --- roundDays: quarter-shift rule
ok('roundDays(0)',B.roundDays(0),0);
ok('roundDays(1.2) stays 1',B.roundDays(1.2),1);
ok('roundDays(1.25) bills 2',B.roundDays(1.25),2);

// --- burden: $20 leader at 8.5% tax + 4% wc
ok('burdened leader',B.burdenedRate(20),20*1.125);
ok('burdened operator',B.burdenedRate(17),17*1.125);

// --- line time: 12,000 bottles @ 40 BPM
ok('prodHours 12k@40bpm',B.productionHours(12000,40),5);
ok('prodHours no BPM => null',B.productionHours(12000,null),null);

// --- Q0016 BOM. Bottle/closure/label are CUSTOMER supplied => $0 known.
const bom=[
 {id:'1',slot:'bottle', fpCode:'CA-PK-1',name:'150cc amber PET',qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'},
 {id:'2',slot:'closure',fpCode:'CA-PK-2',name:'38/400 flip-top',qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'},
 {id:'3',slot:'label',  fpCode:'CA-LL-1',name:'bottle label',   qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'},
 {id:'4',slot:'neckband',fpCode:'PC-PK-9',name:'clear neckband',qtyPerUnit:1,costPerUnit:0.05,costStatus:'ok'},
 {id:'5',slot:'other',  fpCode:'PC-PK-8',name:'cotton',         qtyPerUnit:1,costPerUnit:0.01,costStatus:'ok'},
 {id:'6',slot:'other',  fpCode:'PC-PK-7',name:'desiccant',      qtyPerUnit:1,costPerUnit:0.02,costStatus:'ok'},
 {id:'7',slot:'master_box',fpCode:'PC-PK-6',name:'master box 12ct',qtyPerUnit:1/12,costPerUnit:0,costStatus:'zero_cost'},
];
const inputs={quantity:12000,bom,
 labor:{bottlesPerMinute:40,setup:{days:1,hoursPerDay:8,leaders:1,operators:2},
        production:{leaders:1,operators:3},cleaning:{days:null,hoursPerDay:8,leaders:0,operators:2},
        leaderRate:20,operatorRate:17},
 overhead:{rentLease:[{id:'r',label:'rent',monthly:12000,sharePct:25}],indirectLabor:[],other:[],workingDaysPerMonth:21},
 labTestingTotal:null};

console.log('\n-- unconfirmed zero master box --');
let r=B.computeBottleCosting(inputs);
ok('materials blocked',r.materialsPerUnit,null);
ok('costPerUnit blocked',r.costPerUnit,null);
console.log('  issue:',r.issues.map(i=>i.slot+'/'+i.reason).join(', '));
console.log('  labor still computed =',r.laborPerUnit?.toFixed(5),'  prodHours =',r.productionHours);

console.log('\n-- after a human confirms the $0 is genuine --');
bom[6].zeroCostConfirmed=true;
r=B.computeBottleCosting(inputs);
ok('materials now resolve',r.materialsPerUnit,0.08);
console.log('  labor/unit    =',r.laborPerUnit?.toFixed(6));
console.log('  overhead/unit =',r.overheadPerUnit?.toFixed(6));
console.log('  COST/BOTTLE   = $'+r.costPerUnit?.toFixed(4));
console.log('  TOTAL         = $'+r.totalCost?.toFixed(2));

console.log('\n-- a PC part with no cost at all still blocks --');
bom[3].costStatus='no_cost'; bom[3].costPerUnit=null;
console.log('  costPerUnit =',B.computeBottleCosting(inputs).costPerUnit,'(expect null)');

// ---- suite 2: 'not used' vs 'not chosen' (scoped) ----
{
const mk=(id,slot,over={})=>({id,slot,fpCode:'X-'+id,name:slot,qtyPerUnit:1,costPerUnit:0.05,costStatus:'ok',...over});
// Q0016 shape: 3 slots genuinely unused, rest costed
const bom=[
 mk('1','bottle',{costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'}),
 mk('2','closure',{costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'}),
 mk('3','liner',{fpCode:null,costPerUnit:null,costStatus:'no_cost',notUsed:true}),
 mk('4','other',{costPerUnit:0.03}),
 mk('5','neckband',{costPerUnit:0.05}),
 mk('6','label',{costPerUnit:0,costStatus:'customer_asset',suppliedBy:'customer'}),
 mk('7','carton',{fpCode:null,costPerUnit:null,costStatus:'no_cost',notUsed:true}),
 mk('8','master_box',{qtyPerUnit:1/12,costPerUnit:3.30}),
];
const inp={quantity:12000,bom,
 labor:{bottlesPerMinute:40,setup:{days:1,hoursPerDay:8,leaders:1,operators:2},
  production:{leaders:1,operators:3},cleaning:{days:null,hoursPerDay:8,leaders:0,operators:2},
  leaderRate:20,operatorRate:17},
 overhead:{rentLease:[{id:'r',label:'r',monthly:12000,sharePct:25}],indirectLabor:[],other:[],workingDaysPerMonth:21},
 labTestingTotal:null};
let r=B.computeBottleCosting(inp);
console.log('unused slots do NOT block :', r.costPerUnit!==null ? 'PASS' : '**FAIL**');
console.log('  issues:', r.issues.length===0?'none':r.issues.map(i=>i.slot+'/'+i.reason).join(','));
console.log('  materials/bottle = $'+r.materialsPerUnit?.toFixed(4), '(0 + 0 + 0.03 + 0.05 + 0 + 3.30/12 = 0.355)');
console.log('  COST/BOTTLE      = $'+r.costPerUnit?.toFixed(4));
console.log('  TOTAL            = $'+r.totalCost?.toFixed(2));
// and an UNCHOSEN (not marked unused) line must still block
bom[6].notUsed=false;
console.log('\nunchosen line still blocks   :', B.computeBottleCosting(inp).costPerUnit===null?'PASS':'**FAIL**');
}

// ---- suite 3: pricing tier (scoped) ----
{
const P=(m,mode,hos=0.5,rep=3)=>({marginPct:m,marginMode:mode,hosCommissionPct:hos,repCommissionPct:rep});
const ok=(n,got,want)=>{const p=Math.abs(got-want)<1e-9;console.log((p?'PASS':'**FAIL**').padEnd(10),n,'got',got,'want',want);};

// Markup mode: commission is part of the base being marked up, so the
// invariant is sale / (cost + commission) = 1 + markup. Derive it:
//   sale = cost(1+m) / (1 - rate(1+m))
//   =>  sale(1 - rate(1+m)) = cost(1+m)
//   =>  sale = (1+m)(cost + sale*rate)   <- sale*rate IS the commission
const cost=0.49, qty=12000;
let r=B.computeSalePrice(cost,qty,P(30,'markup'));
const commPerUnit=(r.hosCommission+r.repCommission)/qty;
ok('markup: sale/(cost+comm) == 1.30',
   +(r.salePerUnit/(cost+commPerUnit)).toFixed(9), 1.3);

// Gross-margin mode: profit after commission is 30% OF SALE.
r=B.computeSalePrice(cost,qty,P(30,'gross-margin'));
ok('gross-margin: profit/revenue == 30%', +r.effectiveMarginPct.toFixed(9), 30);

// The two modes must not agree — that is the whole reason both exist.
const a=B.computeSalePrice(cost,qty,P(30,'markup')).salePerUnit;
const b=B.computeSalePrice(cost,qty,P(30,'gross-margin')).salePerUnit;
console.log('\n30% markup   -> $'+a.toFixed(4)+' /bottle');
console.log('30% margin   -> $'+b.toFixed(4)+' /bottle');
ok('modes differ', a!==b, true);
}

// ---- suite 4: supplied-by + cost source (scoped) ----
{
const ok=(n,got,want)=>console.log((JSON.stringify(got)===JSON.stringify(want)?'PASS':'**FAIL**').padEnd(10),n,'got',JSON.stringify(got));
const L=(o)=>({id:'x',slot:'bottle',fpCode:'PC-PK-1',name:'n',qtyPerUnit:1,
  costPerUnit:null,costStatus:'ok',suppliedBy:'pharmacenter',costSource:'Fish Bowl (Inventory)',...o});

// customer-supplied resolves at 0 EVEN WITH NO PART CHOSEN — the Q0016 case
ok('customer-supplied, no part -> $0',
   B.resolveLine(L({suppliedBy:'customer',fpCode:null})).cost, 0);
ok('  ...and raises no issue',
   B.resolveLine(L({suppliedBy:'customer',fpCode:null})).issue, null);

// PC-supplied with no part still blocks
ok('PC-supplied, no part -> blocks',
   B.resolveLine(L({fpCode:null})).cost, null);

// source switching
const both=L({inventoryCostPerUnit:0.10,lastOrderCostPerUnit:0.14});
ok('Inventory source', B.resolveLine({...both,costSource:'Fish Bowl (Inventory)'}).cost, 0.10);
ok('Last Order source', B.resolveLine({...both,costSource:'Fish Bowl (Last Order)'}).cost, 0.14);
ok('App source -> blocks', B.resolveLine({...both,costSource:'App'}).cost, null);
ok('Manual, no value -> blocks', B.resolveLine({...both,costSource:'Manual'}).cost, null);
ok('Manual with value', B.resolveLine({...both,costSource:'Manual',manualCostPerUnit:0.22}).cost, 0.22);
ok('Manual works with NO part chosen',
   B.resolveLine({...both,fpCode:null,costSource:'Manual',manualCostPerUnit:0.22}).cost, 0.22);

// last-order missing must not silently fall back to inventory
ok('Last Order missing -> blocks (no silent fallback)',
   B.resolveLine(L({inventoryCostPerUnit:0.10,lastOrderCostPerUnit:null,costSource:'Fish Bowl (Last Order)'})).cost, null);

// the #358 zero gate still applies, now per-source
ok('$0 manual unconfirmed -> blocks',
   B.resolveLine({...both,costSource:'Manual',manualCostPerUnit:0}).cost, null);
ok('$0 manual CONFIRMED -> counts',
   B.resolveLine({...both,costSource:'Manual',manualCostPerUnit:0,zeroCostConfirmed:true}).cost, 0);

// qty multiplies
ok('qty 1/12 x $3.30', +B.resolveLine(L({qtyPerUnit:1/12,inventoryCostPerUnit:3.30})).cost.toFixed(6), 0.275);

// uom_unresolved poisons Fishbowl sources but Manual escapes it
ok('uom_unresolved blocks Fishbowl',
   B.resolveLine(L({costStatus:'uom_unresolved',inventoryCostPerUnit:5})).cost, null);
ok('uom_unresolved: Manual escapes',
   B.resolveLine(L({costStatus:'uom_unresolved',costSource:'Manual',manualCostPerUnit:0.05})).cost, 0.05);
}

// ---- suite 5: waste % (scoped) ----
{
const ok=(n,got,want)=>console.log((JSON.stringify(got)===JSON.stringify(want)?'PASS':'**FAIL**').padEnd(10),n,'got',JSON.stringify(got));
const L=(o)=>({id:'x',slot:'label',fpCode:'PC-LL-1',name:'label',qtyPerUnit:1,
  costPerUnit:null,costStatus:'ok',suppliedBy:'pharmacenter',
  costSource:'Manual',manualCostPerUnit:1,...o});
const r6=(v)=>v===null?null:+v.toFixed(6);

// absent / zero waste must not disturb the existing number
ok('no wastePct -> factor 1',        B.wasteFactor(L({})), 1);
ok('wastePct 0 -> factor 1',         B.wasteFactor(L({wastePct:0})), 1);
ok('null wastePct -> factor 1',      B.wasteFactor(L({wastePct:null})), 1);
ok('undefined leaves cost alone',    B.resolveLine(L({})).cost, 1);

// the yield convention: buy 1/(1-w), NOT multiply by (1+w)
ok('5% waste -> 1/0.95',   r6(B.wasteFactor(L({wastePct:5}))),  1.052632);
ok('20% waste -> 1.25 not 1.20', r6(B.wasteFactor(L({wastePct:20}))), 1.25);
ok('50% waste -> 2x',      r6(B.wasteFactor(L({wastePct:50}))), 2);

// it actually reaches the cost, and compounds with qty
ok('$1 @ 5% waste',        r6(B.resolveLine(L({wastePct:5})).cost), 1.052632);
ok('qty 1/12 x $3.30 @ 10%',
   r6(B.resolveLine(L({slot:'master_box',qtyPerUnit:1/12,manualCostPerUnit:3.30,wastePct:10})).cost),
   r6(3.30/12/0.9));

// out-of-range is refused, not clamped and not infinite
ok('100% waste -> null',   B.wasteFactor(L({wastePct:100})), null);
ok('120% waste -> null',   B.wasteFactor(L({wastePct:120})), null);
ok('negative -> null',     B.wasteFactor(L({wastePct:-5})),  null);
ok('100% blocks the line', B.resolveLine(L({wastePct:100})).cost, null);
ok('  ...with waste_invalid',
   B.resolveLine(L({wastePct:100})).issue.reason, 'waste_invalid');

// waste cannot resurrect a line that was already blocked for a better reason
ok('unassigned still wins over waste',
   B.resolveLine(L({fpCode:null,costSource:'Fish Bowl (Inventory)',wastePct:100})).issue.reason,
   'unassigned');

// customer-supplied stays $0 — we buy none of it, so we scrap none of it
ok('customer-supplied ignores waste',
   B.resolveLine(L({suppliedBy:'customer',wastePct:50})).cost, 0);
// and an unused slot likewise
ok('notUsed ignores waste',
   B.resolveLine(L({notUsed:true,wastePct:50})).cost, 0);
}

// ---- suite 6: default waste rates (scoped) ----
{
const ok=(n,got,want)=>console.log((JSON.stringify(got)===JSON.stringify(want)?'PASS':'**FAIL**').padEnd(10),n,'got',JSON.stringify(got));
const D=B.DEFAULT_WASTE_PCT;

ok('label defaults 10',       D.label,      10);
ok('master box defaults 2',   D.master_box,  2);
ok('bottle defaults 5',       D.bottle,      5);
ok('closure defaults 5',      D.closure,     5);
ok('carton defaults 5 (unit carton is not a master case)', D.carton, 5);
ok('other defaults 5',        D.other,       5);

// every slot must have an entry, or a row would seed undefined and price at 0%
const SLOTS=['bottle','closure','liner','neckband','sleeve','label',
             'carton','insert','safety_seal','master_box','other'];
ok('every slot has a default', SLOTS.filter(s=>typeof D[s]!=='number'), []);
ok('no default is out of range',
   SLOTS.filter(s=>D[s]<0||D[s]>=100), []);

// the defaults must survive the factor maths
const L=(slot)=>({id:'x',slot,fpCode:'PC-1',name:'n',qtyPerUnit:1,costPerUnit:null,
  costStatus:'ok',suppliedBy:'pharmacenter',costSource:'Manual',
  manualCostPerUnit:1,wastePct:D[slot]});
const r4=(v)=>+v.toFixed(4);
ok('label line at default 10% -> 1/0.90',  r4(B.resolveLine(L('label')).cost),      1.1111);
ok('master box at default 2% -> 1/0.98',   r4(B.resolveLine(L('master_box')).cost), 1.0204);
ok('bottle at default 5% -> 1/0.95',       r4(B.resolveLine(L('bottle')).cost),     1.0526);

// an explicit 0 must NOT be replaced by the default (?? not ||)
ok('explicit 0 survives', B.wasteFactor({...L('label'),wastePct:0}), 1);
}

// ---- suite 7: hand-typed custom parts (scoped) ----
{
const ok=(n,got,want)=>console.log((JSON.stringify(got)===JSON.stringify(want)?'PASS':'**FAIL**').padEnd(10),n,'got',JSON.stringify(got));
const L=(o)=>({id:'x',slot:'other',fpCode:null,name:'Desiccant sachet (not coded yet)',
  qtyPerUnit:1,costPerUnit:null,costStatus:'no_cost',suppliedBy:'pharmacenter',
  costSource:'Manual',manualCostPerUnit:0.04,wastePct:0,customPart:true,...o});

// the whole point: no fpCode, but it still prices
ok('custom part with manual cost resolves', B.resolveLine(L({})).cost, 0.04);
ok('  ...and raises no issue',              B.resolveLine(L({})).issue, null);

// and is NOT mistaken for an unchosen line
ok('not reported as unassigned',
   B.resolveLine(L({manualCostPerUnit:null})).issue.reason, 'no_cost');

// a plain unchosen line must still block, exactly as before
ok('no part + no custom flag still blocks',
   B.resolveLine(L({customPart:false,costSource:'Fish Bowl (Inventory)'})).issue.reason,
   'unassigned');

// a custom part on a Fishbowl source is a dead end — say so specifically
ok('custom + Fishbowl source -> no_cost',
   B.resolveLine(L({costSource:'Fish Bowl (Inventory)'})).issue.reason, 'no_cost');
ok('  ...with a message naming the fix',
   /Manual/.test(B.resolveLine(L({costSource:'Fish Bowl (Inventory)'})).issue.message), true);

// everything else still applies to a custom part
ok('waste applies to custom parts',
   +B.resolveLine(L({wastePct:20})).cost.toFixed(4), 0.05);
ok('qty applies to custom parts',
   +B.resolveLine(L({qtyPerUnit:1/12})).cost.toFixed(6), +(0.04/12).toFixed(6));
ok('$0 custom still needs confirming',
   B.resolveLine(L({manualCostPerUnit:0})).issue.reason, 'zero_unconfirmed');
ok('customer-supplied custom part is $0',
   B.resolveLine(L({suppliedBy:'customer',manualCostPerUnit:null})).cost, 0);
}
