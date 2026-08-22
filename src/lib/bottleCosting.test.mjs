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
 {id:'1',slot:'bottle', fpCode:'CA-PK-1',name:'150cc amber PET',qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset'},
 {id:'2',slot:'closure',fpCode:'CA-PK-2',name:'38/400 flip-top',qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset'},
 {id:'3',slot:'label',  fpCode:'CA-LL-1',name:'bottle label',   qtyPerUnit:1,costPerUnit:0,costStatus:'customer_asset'},
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
 mk('1','bottle',{costPerUnit:0,costStatus:'customer_asset'}),
 mk('2','closure',{costPerUnit:0,costStatus:'customer_asset'}),
 mk('3','liner',{fpCode:null,costPerUnit:null,costStatus:'no_cost',notUsed:true}),
 mk('4','other',{costPerUnit:0.03}),
 mk('5','neckband',{costPerUnit:0.05}),
 mk('6','label',{costPerUnit:0,costStatus:'customer_asset'}),
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
