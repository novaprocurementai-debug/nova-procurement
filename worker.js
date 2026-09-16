const MODEL="@cf/meta/llama-3.1-8b-instruct-fast";
const TARGET_NETWORK=20000000;

const REGIONS=[
 ["US","North America"],["CA","North America"],
 ["CN","China"],["IN","India"],["JP","Japan"],
 ["KR","South Korea"],["DE","Europe"],
 ["GB","Europe"],["FR","Europe"],["IT","Europe"]
];

const json=(d,s=200,h={})=>new Response(JSON.stringify(d),{
 status:s,
 headers:{"Content-Type":"application/json;charset=UTF-8",...h}
});

const now=()=>Date.now();
const clean=(v,n=10000)=>String(v??"").trim().slice(0,n);
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;

async function sha256(t){
 const h=await crypto.subtle.digest(
  "SHA-256",
  new TextEncoder().encode(t)
 );
 return [...new Uint8Array(h)]
  .map(x=>x.toString(16).padStart(2,"0"))
  .join("");
}

function token(){
 return crypto.randomUUID()+crypto.randomUUID();
}

async function passwordHash(p,s){
 return sha256(s+":"+p);
}

function cookieValue(req,name){
 const c=req.headers.get("Cookie")||"";
 const m=c.match(
  new RegExp("(^|;\\s*)"+name+"=([^;]*)")
 );
 return m?decodeURIComponent(m[2]):null;
}

function sessionCookie(t){
 return `nova_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearCookie(){
 return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/* =========================================================
DATABASE
========================================================= */

async function ensureDB(db){

 await db.batch([

  db.prepare(`
   CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS sessions(
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS suppliers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    url TEXT UNIQUE,
    country TEXT,
    region TEXT,
    source TEXT,
    product TEXT,
    price REAL,
    moq REAL,
    lead_time TEXT,
    evidence INTEGER DEFAULT 0,
    confidence INTEGER DEFAULT 0,
    deal_score INTEGER DEFAULT 0,
    verification TEXT DEFAULT 'Not verified',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS supplier_evidence(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER,
    source_url TEXT,
    evidence_text TEXT,
    evidence_score INTEGER DEFAULT 0,
    verified INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS procurement_projects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT,
    product TEXT,
    quantity REAL,
    destination TEXT,
    requirements TEXT,
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS rfqs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    project_id INTEGER,
    product TEXT,
    quantity REAL,
    destination TEXT,
    requirements TEXT,
    message TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS bids(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    supplier_id INTEGER,
    supplier_name TEXT,
    unit_price REAL,
    quantity REAL,
    moq REAL,
    shipping REAL,
    duty REAL,
    tax REAL,
    landed_cost REAL,
    lead_time TEXT,
    payment_terms TEXT,
    incoterm TEXT,
    notes TEXT,
    score INTEGER DEFAULT 0,
    status TEXT DEFAULT 'submitted',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS negotiations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    supplier TEXT,
    offer TEXT,
    result TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS purchase_orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    bid_id INTEGER,
    user_id INTEGER,
    po_number TEXT UNIQUE,
    supplier TEXT,
    product TEXT,
    quantity REAL,
    unit_price REAL,
    total REAL,
    currency TEXT DEFAULT 'USD',
    destination TEXT,
    status TEXT DEFAULT 'draft',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS purchases(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    product TEXT,
    supplier TEXT,
    quantity REAL,
    unit_price REAL,
    shipping REAL,
    landed_cost REAL,
    supplier_url TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS procurement_memory(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    product TEXT,
    supplier TEXT,
    outcome TEXT,
    memory TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `),

  db.prepare(`
   CREATE TABLE IF NOT EXISTS flash_deals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    company TEXT,
    product TEXT,
    description TEXT,
    country TEXT,
    quantity REAL,
    price REAL,
    currency TEXT DEFAULT 'USD',
    moq REAL,
    url TEXT,
    status TEXT DEFAULT 'submitted',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
   )
  `)

 ]);
}

/* =========================================================
AUTH
========================================================= */

async function currentUser(req,db){

 if(!db)return null;

 const t=cookieValue(
  req,
  "nova_session"
 );

 if(!t)return null;

 return db.prepare(`
  SELECT users.id,users.email
  FROM sessions
  JOIN users ON users.id=sessions.user_id
  WHERE sessions.token=?
  AND sessions.expires_at>?
 `)
 .bind(t,now())
 .first();
}

/* =========================================================
PARSERS
========================================================= */

function parsePrice(t){

 const s=String(t||"");

 const patterns=[
  /(?:US\$|USD|\$)\s*([0-9]+(?:\.[0-9]+)?)/i,
  /price[^0-9]{0,30}([0-9]+(?:\.[0-9]+)?)/i
 ];

 for(const p of patterns){
  const m=s.match(p);
  if(m)return Number(m[1]);
 }

 return null;
}

function parseMOQ(t){

 const s=String(t||"");

 const patterns=[
  /MOQ[^0-9]{0,40}([0-9][0-9,]*)/i,
  /minimum\s+order\s+quantity[^0-9]{0,40}([0-9][0-9,]*)/i,
  /minimum\s+order[^0-9]{0,40}([0-9][0-9,]*)/i
 ];

 for(const p of patterns){
  const m=s.match(p);
  if(m)
   return Number(
    m[1].replace(/,/g,"")
   );
 }

 return null;
}

function parseLead(t){

 const s=String(t||"");

 const patterns=[
  /lead\s*time[^0-9]{0,30}([0-9]+)\s*(?:-|to)\s*([0-9]+)\s*days?/i,
  /lead\s*time[^0-9]{0,30}([0-9]+)\s*days?/i,
  /production[^0-9]{0,30}([0-9]+)\s*(?:-|to)\s*([0-9]+)\s*days?/i
 ];

 for(const p of patterns){

  const m=s.match(p);

  if(m)
   return m[2]
    ?`${m[1]}-${m[2]} days`
    :`${m[1]} days`;
 }

 return null;
}

function supplierSignals(t){

 const s=String(t||"").toLowerCase();

 return [
  "manufacturer",
  "factory",
  "supplier",
  "wholesale",
  "wholesaler",
  "oem",
  "odm",
  "exporter",
  "bulk",
  "custom",
  "private label"
 ].reduce(
  (n,w)=>n+(s.includes(w)?1:0),
  0
 );
}

function evidenceScore(t){

 const s=String(t||"").toLowerCase();

 let n=0;

 if(/\$|usd|price/.test(s))n+=10;
 if(/moq|minimum order/.test(s))n+=10;
 if(/shipping|delivery/.test(s))n+=5;
 if(/lead time|production/.test(s))n+=5;
 if(/manufacturer|factory/.test(s))n+=5;
 if(/oem|odm/.test(s))n+=5;
 if(/wholesale|bulk/.test(s))n+=5;
 if(/quotation|quote/.test(s))n+=5;

 return Math.min(50,n);
}

function dealScore(sig,e,p,m){

 return Math.min(
  100,
  Math.max(
   0,
   50+
   sig*3+
   e+
   (p!==null?5:0)+
   (m!==null?5:0)
  )
 );
}

function countryFromCode(code){

 const x=REGIONS.find(
  r=>r[0]===code
 );

 return x?x[1]:"Global";
}

/* =========================================================
PAGE INTELLIGENCE
========================================================= */

function htmlToText(h){

 return String(h||"")
  .replace(/<script[\s\S]*?<\/script>/gi," ")
  .replace(/<style[\s\S]*?<\/style>/gi," ")
  .replace(/<noscript[\s\S]*?<\/noscript>/gi," ")
  .replace(/<[^>]+>/g," ")
  .replace(/&nbsp;/gi," ")
  .replace(/&amp;/gi,"&")
  .replace(/&quot;/gi,'"')
  .replace(/&#39;/gi,"'")
  .replace(/\s+/g," ")
  .trim()
  .slice(0,120000);
}

async function fetchPage(url){

 if(!/^https?:\/\//i.test(url))
  return "";

 try{

  const r=await fetch(
   url,
   {
    method:"GET",
    redirect:"follow",
    headers:{
     "User-Agent":
      "Mozilla/5.0 (compatible; NOVA Procurement Bot/3.0)",
     "Accept":
      "text/html,application/xhtml+xml"
    }
   }
  );

  if(!r.ok)return "";

  const type=
   r.headers.get("content-type")||"";

  if(!type.includes("text/html"))
   return "";

  return htmlToText(
   await r.text()
  );

 }catch{

  return "";

 }
}

/* =========================================================
YEP
========================================================= */

async function yepSearch(
 query,
 location,
 env,
 limit=10
){

 if(!env.YEP_API_KEY)
  throw Error(
   "YEP_API_KEY is missing in Cloudflare."
  );

 const r=await fetch(
  "https://platform.yep.com/api/search",
  {
   method:"POST",

   headers:{
    Authorization:
     `Bearer ${env.YEP_API_KEY}`,
    "Content-Type":
     "application/json"
   },

   body:JSON.stringify({
    query,
    type:"basic",
    limit,
    language:["en"],
    location
   })
  }
 );

 const txt=await r.text();

 let d;

 try{
  d=JSON.parse(txt);
 }catch{
  throw Error(
   `Yep returned invalid response. HTTP ${r.status}`
  );
 }

 if(!r.ok)
  throw Error(
   d?.error||
   `Yep HTTP ${r.status}`
  );

 return d;
}

/* =========================================================
MULTI-SOURCE SUPPLIER ENGINE
========================================================= */

async function searchSuppliers(
 requestText,
 env,
 db
){

 const request=
  clean(
   requestText,
   1000
  );

 if(!request)
  throw Error(
   "Please enter a procurement request."
  );

 const baseQuery=`
${request}
manufacturer factory supplier wholesale
OEM ODM exporter bulk custom private label
MOQ price quotation production lead time shipping
`
 .replace(/\s+/g," ")
 .trim();

 const searches=
  REGIONS.map(
   ([code])=>
    yepSearch(
     baseQuery,
     code,
     env,
     10
    )
  );

 const settled=
  await Promise.allSettled(
   searches
  );

 const results=[];

 for(
  let i=0;
  i<settled.length;
  i++
 ){

  const x=settled[i];

  if(x.status!=="fulfilled")
   continue;

  const raw=
   Array.isArray(
    x.value?.results
   )
    ?x.value.results
    :[];

  for(const r of raw){

   const title=
    clean(
     r.title||
     r.name||
     r.headline||
     "Supplier",
     500
    );

   const url=
    clean(
     r.url||
     r.link||
     "",
     2000
    );

   if(!url)continue;

   const snippet=
    clean(
     r.snippet||
     r.description||
     r.text||
     "",
     3000
    );

   const combined=
    `${title} ${snippet}`;

   const price=
    parsePrice(combined);

   const moq=
    parseMOQ(combined);

   const lead=
    parseLead(combined);

   const sig=
    supplierSignals(combined);

   const ev=
    evidenceScore(combined);

   results.push({

    title,
    url,
    snippet,

    price,
    moq,

    leadTime:lead,

    shipping:null,

    supplierSignal:sig,

    evidence:ev,

    confidence:
     Math.min(
      98,
      Math.round(
       ev*1.7+
       (price!==null?8:0)+
       (moq!==null?5:0)+
       (lead?5:0)
      )
     ),

    dealScore:
     dealScore(
      sig,
      ev,
      price,
      moq
     ),

    country:
     REGIONS[i][0],

    region:
     REGIONS[i][1],

    verified:false,

    verification:"Not verified",

    pageChecked:false
   });
  }
 }

 /* REMOVE DUPLICATES */

 const map=new Map();

 for(const r of results){

  const key=
   r.url
    .toLowerCase()
    .replace(/\/$/,"");

  if(!map.has(key)){

   map.set(
    key,
    r
   );

  }else{

   const old=map.get(key);

   old.evidence=
    Math.max(
     old.evidence,
     r.evidence
    );

   old.confidence=
    Math.max(
     old.confidence,
     r.confidence
    );

   if(old.price===null)
    old.price=r.price;

   if(old.moq===null)
    old.moq=r.moq;

   if(!old.leadTime)
    old.leadTime=r.leadTime;
  }
 }

 let unique=
  [...map.values()]
   .sort(
    (a,b)=>
     b.dealScore-a.dealScore||
     b.evidence-a.evidence
   )
   .slice(0,60);

 /* CHECK TOP 10 SUPPLIER PAGES */

 const top=
  unique.slice(0,10);

 const checked=
  await Promise.all(
   top.map(
    async supplier=>{

     const page=
      await fetchPage(
       supplier.url
      );

     if(!page)
      return supplier;

     const price=
      parsePrice(page) ??
      supplier.price;

     const moq=
      parseMOQ(page) ??
      supplier.moq;

     const lead=
      parseLead(page) ??
      supplier.leadTime;

     const ev=
      Math.max(
       supplier.evidence,
       evidenceScore(page)
      );

     return {
      ...supplier,

      price,
      moq,
      leadTime:lead,

      evidence:ev,

      confidence:
       Math.min(
        98,
        Math.round(
         ev*1.7+
         (price!==null?8:0)+
         (moq!==null?5:0)+
         (lead?5:0)
        )
       ),

      pageChecked:true,

      verification:
       price!==null||
       moq!==null||
       lead
        ?"Partially verified"
        :"Not verified"
     };
    }
   )
  );

 unique=[
  ...checked,
  ...unique.slice(10)
 ];

 /* SAVE TO D1 */

 if(db&&unique.length){

  const statements=[];

  for(const r of unique){

   statements.push(
    db.prepare(`
     INSERT INTO suppliers(
      name,url,country,region,
      source,product,price,moq,
      lead_time,evidence,
      confidence,deal_score,
      verification
     )
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(url) DO UPDATE SET
      name=excluded.name,
      country=excluded.country,
      region=excluded.region,
      product=excluded.product,
      price=COALESCE(excluded.price,suppliers.price),
      moq=COALESCE(excluded.moq,suppliers.moq),
      lead_time=COALESCE(excluded.lead_time,suppliers.lead_time),
      evidence=MAX(excluded.evidence,suppliers.evidence),
      confidence=MAX(excluded.confidence,suppliers.confidence),
      deal_score=MAX(excluded.deal_score,suppliers.deal_score),
      verification=excluded.verification
    `)
    .bind(
     r.title,
     r.url,
     r.country,
     r.region,
     "Yep",
     request,
     r.price,
     r.moq,
     r.leadTime,
     r.evidence,
     r.confidence,
     r.dealScore,
     r.verification
    )
   );
  }

  await db.batch(
   statements
  );
 }

 return {
  ok:true,
  results:unique,
  total:unique.length,
  networkTarget:TARGET_NETWORK,
  sourcesQueried:REGIONS.length,
  engine:"Multi-Source Supplier Engine"
 };
}

/* =========================================================
AI
========================================================= */

async function ai(
 env,
 system,
 user,
 max_tokens=1200
){

 if(!env.AI)
  throw Error(
   "Workers AI binding AI is missing."
  );

 const r=
  await env.AI.run(
   MODEL,
   {
    messages:[
     {
      role:"system",
      content:system
     },
     {
      role:"user",
      content:user
     }
    ],
    max_tokens,
    temperature:.2
   }
  );

 return (
  r?.response||
  r?.result?.response||
  "No AI response generated."
 );
}

/* =========================================================
LANDED COST
========================================================= */

function landed(body){

 const quantity=
  Math.max(
   0,
   num(body.quantity)
  );

 const unitPrice=
  Math.max(
   0,
   num(
    body.unitPrice||
    body.unit_price
   )
  );

 const shipping=
  Math.max(
   0,
   num(body.shipping)
  );

 const insurance=
  Math.max(
   0,
   num(body.insurance)
  );

 const dutyPercent=
  Math.max(
   0,
   num(
    body.dutyPercent||
    body.duty_percent
   )
  );

 const taxPercent=
  Math.max(
   0,
   num(
    body.taxPercent||
    body.tax_percent
   )
  );

 const local=
  Math.max(
   0,
   num(
    body.localDelivery||
    body.local_delivery
   )
  );

 const goods=
  quantity*
  unitPrice;

 const duty=
  goods*
  dutyPercent/100;

 const taxable=
  goods+
  shipping+
  duty;

 const tax=
  taxable*
  taxPercent/100;

 const total=
  goods+
  shipping+
  insurance+
  duty+
  tax+
  local;

 return {
  goods,
  shipping,
  insurance,
  duty,
  tax,
  localDelivery:local,
  total,
  unitLanded:
   quantity
    ?total/quantity
    :0,
  status:
   "Estimated — verify freight, customs and taxes before payment"
 };
}

/* =========================================================
BID SCORE
========================================================= */

function bidScore(b){

 let score=50;

 if(num(b.unit_price)>0)
  score+=10;

 if(num(b.landed_cost)>0)
  score+=15;

 if(num(b.moq)>0)
  score+=5;

 if(b.lead_time)
  score+=5;

 if(b.payment_terms)
  score+=5;

 if(b.incoterm)
  score+=5;

 return Math.min(
  100,
  score
 );
}

/* =========================================================
FULL PROCUREMENT AGENT
========================================================= */

async function procure(
 body,
 env,
 db,
 user
){

 const product=
  clean(
   body.product||
   body.request,
   1000
  );

 const quantity=
  num(body.quantity);

 const destination=
  clean(
   body.destination,
   500
  );

 const requirements=
  clean(
   body.requirements,
   5000
  );

 if(!product||quantity<=0)
  throw Error(
   "Product and quantity are required."
  );

 /* 1 SEARCH */

 const search=
  await searchSuppliers(
   `${product} ${requirements}`,
   env,
   db
  );

 /* 2 PROJECT */

 const project=
  await db.prepare(`
   INSERT INTO procurement_projects(
    user_id,name,product,
    quantity,destination,
    requirements,status
   )
   VALUES(?,?,?,?,?,?,?)
  `)
  .bind(
   user?.id||null,
   `${product} Procurement`,
   product,
   quantity,
   destination,
   requirements,
   "active"
  )
  .run();

 const projectId=
  project.meta.last_row_id;

 /* 3 RFQ */

 const rfqMessage=
  await ai(
   env,

   `You are NOVA, an expert procurement specialist.
Create a professional ready-to-send RFQ.
Do not invent specifications.
Ask for price, MOQ, sample, production lead time,
shipping, Incoterm, payment, packaging,
certifications and quotation validity.`,

   `Product: ${product}
Quantity: ${quantity}
Destination: ${destination}
Requirements: ${requirements}`
  );

 const rfq=
  await db.prepare(`
   INSERT INTO rfqs(
    user_id,project_id,
    product,quantity,
    destination,requirements,
    message,status
   )
   VALUES(?,?,?,?,?,?,?,?)
  `)
  .bind(
   user?.id||null,
   projectId,
   product,
   quantity,
   destination,
   requirements,
   rfqMessage,
   "draft"
  )
  .run();

 /* 4 PROCUREMENT PLAN */

 const plan=
  await ai(
   env,

   `You are NOVA, an autonomous procurement planning agent.
Create a concise execution plan using only known information.
Separate verified supplier data from information that still
requires supplier confirmation.`,

   JSON.stringify({
    product,
    quantity,
    destination,
    requirements,
    suppliers:
     search.results.slice(0,10)
   })
  );

 return {
  ok:true,

  workflow:"complete",

  projectId,

  rfqId:
   rfq.meta.last_row_id,

  product,
  quantity,
  destination,

  suppliers:
   search.results,

  supplierCount:
   search.total,

  rfq:rfqMessage,

  plan,

  nextSteps:[
   "Review supplier evidence",
   "Send RFQ",
   "Collect supplier bids",
   "Compare landed cost",
   "Negotiate selected offers",
   "Award bid",
   "Create purchase order"
  ]
 };
}

/* =========================================================
MAIN WORKER
========================================================= */

export default{

 async fetch(request,env){

  const url=
   new URL(request.url);

  const path=
   url.pathname;

  const method=
   request.method;

  try{

   if(env.DB)
    await ensureDB(env.DB);

   /* OPTIONS */

   if(method==="OPTIONS"){

    return new Response(
     null,
     {
      status:204,
      headers:{
       "Access-Control-Allow-Origin":"*",
       "Access-Control-Allow-Methods":
        "GET,POST,OPTIONS",
       "Access-Control-Allow-Headers":
        "Content-Type"
      }
     }
    );
   }

   /* SEARCH */

   if(
    path==="/api/search"&&
    method==="POST"
   ){

    const b=
     await request.json();

    return json(
     await searchSuppliers(
      b.request||
      b.product||
      b.query,
      env,
      env.DB
     )
    );
   }

   /* FULL PROCUREMENT */

   if(
    path==="/api/procure"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const user=
     await currentUser(
      request,
      env.DB
     );

    return json(
     await procure(
      b,
      env,
      env.DB,
      user
     )
    );
   }

   /* NETWORK */

   if(
    path==="/api/network"&&
    method==="GET"
   ){

    const row=
     await env.DB
      .prepare(
       "SELECT COUNT(*) AS count FROM suppliers"
      )
      .first();

    const evidence=
     await env.DB
      .prepare(
       "SELECT COUNT(*) AS count FROM supplier_evidence"
      )
      .first();

    return json({
     ok:true,
     actualRecords:
      Number(row?.count||0),
     evidenceRecords:
      Number(evidence?.count||0),
     targetRecords:
      TARGET_NETWORK,
     coverage:[
      ...new Set(
       REGIONS.map(
        x=>x[1]
       )
      )
     ],
     sources:
      REGIONS.length,
     status:
      "Live multi-source supplier discovery"
    });
   }

   /* SUPPLIERS */

   if(
    path==="/api/suppliers"&&
    method==="GET"
   ){

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM suppliers
       ORDER BY deal_score DESC,
                evidence DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     suppliers:
      rows.results||[]
    });
   }

   /* PROJECTS */

   if(
    path==="/api/projects"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const user=
     await currentUser(
      request,
      env.DB
     );

    const r=
     await env.DB
      .prepare(`
       INSERT INTO procurement_projects(
        user_id,name,product,
        quantity,destination,
        requirements,status
       )
       VALUES(?,?,?,?,?,?,?)
      `)
      .bind(
       user?.id||null,
       clean(
        b.name||
        b.product,
        500
       ),
       clean(
        b.product,
        1000
       ),
       num(b.quantity),
       clean(
        b.destination,
        500
       ),
       clean(
        b.requirements,
        5000
       ),
       "active"
      )
      .run();

    return json({
     ok:true,
     projectId:
      r.meta.last_row_id
    });
   }

   if(
    path==="/api/projects"&&
    method==="GET"
   ){

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM procurement_projects
       ORDER BY id DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     projects:
      rows.results||[]
    });
   }

   /* RFQ */

   if(
    path==="/api/rfq"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const message=
     await ai(
      env,
      "You are NOVA procurement specialist. Create a professional ready-to-send RFQ. Do not invent facts.",
      `Product: ${b.product}
Quantity: ${b.quantity}
Destination: ${b.destination}
Requirements: ${b.requirements||"None"}
Ask for unit price, MOQ, samples, lead time, shipping, Incoterm, payment, packaging, certifications and quote validity.`
     );

    const user=
     await currentUser(
      request,
      env.DB
     );

    const r=
     await env.DB
      .prepare(`
       INSERT INTO rfqs(
        user_id,project_id,
        product,quantity,
        destination,requirements,
        message,status
       )
       VALUES(?,?,?,?,?,?,?,?)
      `)
      .bind(
       user?.id||null,
       b.projectId?
        num(b.projectId):
        null,
       clean(b.product,1000),
       num(b.quantity),
       clean(b.destination,500),
       clean(b.requirements,5000),
       message,
       "draft"
      )
      .run();

    return json({
     ok:true,
     rfqId:
      r.meta.last_row_id,
     message
    });
   }

   /* LANDED COST */

   if(
    path==="/api/landed-cost"&&
    method==="POST"
   ){

    return json(
     landed(
      await request.json()
     )
    );
   }

   /* BIDS */

   if(
    path==="/api/bids"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const unitPrice=
     num(
      b.unitPrice||
      b.unit_price
     );

    const shipping=
     num(b.shipping);

    const duty=
     num(b.duty);

    const tax=
     num(b.tax);

    const landedCost=
     num(
      b.landedCost||
      b.landed_cost,
      unitPrice+
      shipping+
      duty+
      tax
     );

    const score=
     bidScore({
      unit_price:unitPrice,
      landed_cost:landedCost,
      moq:b.moq,
      lead_time:
       b.leadTime||
       b.lead_time,
      payment_terms:
       b.paymentTerms||
       b.payment_terms,
      incoterm:b.incoterm
     });

    const r=
     await env.DB
      .prepare(`
       INSERT INTO bids(
        project_id,supplier_id,
        supplier_name,
        unit_price,quantity,
        moq,shipping,duty,tax,
        landed_cost,lead_time,
        payment_terms,incoterm,
        notes,score,status
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       b.projectId||
       b.project_id||
       null,

       b.supplierId||
       b.supplier_id||
       null,

       clean(
        b.supplierName||
        b.supplier,
        500
       ),

       unitPrice,
       num(b.quantity),
       num(b.moq),
       shipping,
       duty,
       tax,
       landedCost,

       clean(
        b.leadTime||
        b.lead_time,
        200
       ),

       clean(
        b.paymentTerms||
        b.payment_terms,
        500
       ),

       clean(
        b.incoterm,
        100
       ),

       clean(
        b.notes||
        b.qualityNotes||
        b.quality_notes,
        3000
       ),

       score,
       "submitted"
      )
      .run();

    return json({
     ok:true,
     bidId:
      r.meta.last_row_id,
     score
    });
   }

   /* COMPARE */

   if(
    path==="/api/bids/compare"
   ){

    const b=
     method==="POST"
      ?await request.json()
      :Object.fromEntries(
       url.searchParams
      );

    const projectId=
     num(
      b.projectId||
      b.project_id
     );

    if(!projectId)
     return json(
      {
       error:
        "Project ID required."
      },
      400
     );

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM bids
       WHERE project_id=?
       ORDER BY score DESC,
                landed_cost ASC
      `)
      .bind(projectId)
      .all();

    return json({
     ok:true,
     projectId,
     bids:
      rows.results||[]
    });
   }

   /* AWARD */

   if(
    path==="/api/award"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const bidId=
     num(
      b.bidId||
      b.bid_id
     );

    const bid=
     await env.DB
      .prepare(
       "SELECT * FROM bids WHERE id=?"
      )
      .bind(bidId)
      .first();

    if(!bid)
     return json(
      {
       error:"Bid not found."
      },
      404
     );

    await env.DB
     .prepare(
      "UPDATE bids SET status='awarded' WHERE id=?"
     )
     .bind(bidId)
     .run();

    return json({
     ok:true,
     status:"awarded",
     bidId,
     supplier:
      bid.supplier_name
    });
   }

   /* PURCHASE ORDER */

   if(
    path==="/api/purchase-orders"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const bidId=
     num(
      b.bidId||
      b.bid_id
     );

    const bid=
     await env.DB
      .prepare(
       "SELECT * FROM bids WHERE id=?"
      )
      .bind(bidId)
      .first();

    if(!bid)
     return json(
      {
       error:"Bid not found."
      },
      404
     );

    const user=
     await currentUser(
      request,
      env.DB
     );

    const project=
     bid.project_id
      ?await env.DB
       .prepare(
        "SELECT * FROM procurement_projects WHERE id=?"
       )
       .bind(
        bid.project_id
       )
       .first()
      :null;

    const po=
     "NOVA-"+
     new Date().getUTCFullYear()+
     "-"+
     crypto
      .randomUUID()
      .slice(0,8)
      .toUpperCase();

    const total=
     num(bid.quantity)*
     num(bid.unit_price);

    const r=
     await env.DB
      .prepare(`
       INSERT INTO purchase_orders(
        project_id,bid_id,user_id,
        po_number,supplier,
        product,quantity,
        unit_price,total,
        currency,destination,status
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       bid.project_id,
       bidId,
       user?.id||null,
       po,
       bid.supplier_name,
       project?.product||"",
       bid.quantity,
       bid.unit_price,
       total,
       "USD",
       project?.destination||"",
       "draft"
      )
      .run();

    return json({
     ok:true,
     purchaseOrderId:
      r.meta.last_row_id,
     poNumber:po,
     total
    });
   }

   if(
    path==="/api/purchase-orders"&&
    method==="GET"
   ){

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM purchase_orders
       ORDER BY id DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     purchaseOrders:
      rows.results||[]
    });
   }

   /* NEGOTIATION */

   if(
    path==="/api/negotiate"&&
    method==="POST"
   ){

    const b=
     await request.json();

    if(
     !b.supplier||
     !b.offer
    )
     return json(
      {
       error:
        "Supplier and offer are required."
      },
      400
     );

    const result=
     await ai(
      env,

      `You are NOVA, an expert procurement negotiation agent.
Never invent supplier facts.
Analyze the offer and produce:
1. Offer analysis
2. Target price
3. Counteroffer
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Risks
8. Ready-to-send negotiation message.`,

      `Supplier: ${b.supplier}
Offer: ${b.offer}
Supplier reply: ${b.reply||"Not provided"}
Target: ${b.target||b.goal||"Not specified"}
Quantity: ${b.quantity||"Not specified"}`
     );

    const user=
     await currentUser(
      request,
      env.DB
     );

    await env.DB
     .prepare(`
      INSERT INTO negotiations(
       user_id,supplier,offer,result
      )
      VALUES(?,?,?,?)
     `)
     .bind(
      user?.id||null,
      clean(b.supplier,1000),
      clean(b.offer,5000),
      result
     )
     .run();

    return json({
     ok:true,
     result
    });
   }

   /* MEMORY */

   if(
    path==="/api/memory"&&
    method==="POST"
   ){

    const user=
     await currentUser(
      request,
      env.DB
     );

    if(!user)
     return json(
      {
       error:
        "Please login first."
      },
      401
     );

    const b=
     await request.json();

    const r=
     await env.DB
      .prepare(`
       INSERT INTO procurement_memory(
        user_id,product,
        supplier,outcome,memory
       )
       VALUES(?,?,?,?,?)
      `)
      .bind(
       user.id,
       clean(b.product,1000),
       clean(b.supplier,1000),
       clean(
        b.outcome||
        "Successful",
        300
       ),
       clean(
        b.memory,
        5000
       )
      )
      .run();

    return json({
     ok:true,
     memoryId:
      r.meta.last_row_id
    });
   }

   if(
    path==="/api/memory"&&
    method==="GET"
   ){

    const user=
     await currentUser(
      request,
      env.DB
     );

    if(!user)
     return json(
      {
       error:
        "Please login first."
      },
      401
     );

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM procurement_memory
       WHERE user_id=?
       ORDER BY id DESC
      `)
      .bind(user.id)
      .all();

    return json({
     ok:true,
     memory:
      rows.results||[]
    });
   }

   /* DEALS */

   if(
    path==="/api/deals"&&
    method==="GET"
   ){

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM flash_deals
       WHERE status='submitted'
       ORDER BY id DESC
       LIMIT 50
      `)
      .all();

    return json({
     ok:true,
     deals:
      rows.results||[]
    });
   }

   if(
    path==="/api/deals"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const user=
     await currentUser(
      request,
      env.DB
     );

    await env.DB
     .prepare(`
      INSERT INTO flash_deals(
       user_id,company,product,
       description,country,
       quantity,price,currency,
       moq,url,status
      )
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
     `)
     .bind(
      user?.id||null,
      clean(
       b.company||
       b.supplier,
       500
      ),
      clean(b.product,1000),
      clean(
       b.description,
       3000
      ),
      clean(b.country,300),
      num(b.quantity),
      num(b.price),
      clean(
       b.currency||
       "USD",
       10
      ),
      num(b.moq),
      clean(b.url,2000),
      "submitted"
     )
     .run();

    return json({
     ok:true
    });
   }

   /* STATUS */

   if(
    path==="/api/status"&&
    method==="GET"
   ){

    return json({
     ok:true,
     nova:"3.0",

     integrations:{
      D1:Boolean(env.DB),
      AI:Boolean(env.AI),
      Yep:Boolean(env.YEP_API_KEY)
     },

     engines:{
      multiSourceSupplierEngine:true,
      pageIntelligence:true,
      supplierEvidence:true,
      procurementAgent:true,
      rfq:true,
      bids:true,
      negotiation:true,
      landedCost:true,
      purchaseOrders:true,
      memory:true
     },

     regions:
      REGIONS.length
    });
   }

   /* AUTH */

   if(
    path==="/api/signup"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const email=
     clean(
      b.email,
      320
     ).toLowerCase();

    const password=
     String(
      b.password||""
     );

    if(
     !email||
     password.length<6
    )
     return json(
      {
       error:
        "Valid email and password of at least 6 characters are required."
      },
      400
     );

    const exists=
     await env.DB
      .prepare(
       "SELECT id FROM users WHERE email=?"
      )
      .bind(email)
      .first();

    if(exists)
     return json(
      {
       error:
        "Account already exists."
      },
      409
     );

    const salt=
     token();

    const hash=
     await passwordHash(
      password,
      salt
     );

    const r=
     await env.DB
      .prepare(`
       INSERT INTO users(
        email,password_hash,salt
       )
       VALUES(?,?,?)
      `)
      .bind(
       email,
       hash,
       salt
      )
      .run();

    const t=
     token();

    await env.DB
     .prepare(`
      INSERT INTO sessions(
       token,user_id,expires_at
      )
      VALUES(?,?,?)
     `)
     .bind(
      t,
      r.meta.last_row_id,
      now()+604800000
     )
     .run();

    return json(
     {
      ok:true,
      email
     },
     200,
     {
      "Set-Cookie":
       sessionCookie(t)
     }
    );
   }

   if(
    path==="/api/login"&&
    method==="POST"
   ){

    const b=
     await request.json();

    const email=
     clean(
      b.email,
      320
     ).toLowerCase();

    const password=
     String(
      b.password||""
     );

    const user=
     await env.DB
      .prepare(
       "SELECT * FROM users WHERE email=?"
      )
      .bind(email)
      .first();

    if(
     !user||
     await passwordHash(
      password,
      user.salt
     )!==user.password_hash
    )
     return json(
      {
       error:
        "Invalid email or password."
      },
      401
     );

    const t=
     token();

    await env.DB
     .prepare(`
      INSERT INTO sessions(
       token,user_id,expires_at
      )
      VALUES(?,?,?)
     `)
     .bind(
      t,
      user.id,
      now()+604800000
     )
     .run();

    return json(
     {
      ok:true,
      email
     },
     200,
     {
      "Set-Cookie":
       sessionCookie(t)
     }
    );
   }

   if(
    path==="/api/logout"
   ){

    const t=
     cookieValue(
      request,
      "nova_session"
     );

    if(t)
     await env.DB
      .prepare(
       "DELETE FROM sessions WHERE token=?"
      )
      .bind(t)
      .run();

    return json(
     {ok:true},
     200,
     {
      "Set-Cookie":
       clearCookie()
     }
    );
   }

   if(
    path==="/api/me"
   ){

    const user=
     await currentUser(
      request,
      env.DB
     );

    return json({
     loggedIn:Boolean(user),
     user:user||null
    });
   }

   /* PURCHASE HISTORY */

   if(
    path==="/api/purchases"&&
    method==="POST"
   ){

    const user=
     await currentUser(
      request,
      env.DB
     );

    if(!user)
     return json(
      {
       error:
        "Please login first."
      },
      401
     );

    const b=
     await request.json();

    await env.DB
     .prepare(`
      INSERT INTO purchases(
       user_id,product,supplier,
       quantity,unit_price,
       shipping,landed_cost,
       supplier_url
      )
      VALUES(?,?,?,?,?,?,?,?)
     `)
     .bind(
      user.id,
      clean(b.product,1000),
      clean(b.supplier,1000),
      num(b.quantity),
      num(
       b.unitPrice||
       b.unit_price
      ),
      num(b.shipping),
      num(
       b.landedCost||
       b.landed_cost
      ),
      clean(
       b.supplierUrl||
       b.url,
       2000
      )
     )
     .run();

    return json({
     ok:true
    });
   }

   if(
    path==="/api/purchases"&&
    method==="GET"
   ){

    const user=
     await currentUser(
      request,
      env.DB
     );

    if(!user)
     return json(
      {
       error:
        "Please login first."
      },
      401
     );

    const rows=
     await env.DB
      .prepare(`
       SELECT *
       FROM purchases
       WHERE user_id=?
       ORDER BY id DESC
      `)
      .bind(user.id)
      .all();

    return json({
     ok:true,
     purchases:
      rows.results||[]
    });
   }

   /* STATIC */

   if(env.ASSETS)
    return env.ASSETS.fetch(
     request
    );

   return new Response(
    "NOVA Procurement AI is running.",
    {status:200}
   );

  }catch(e){

   console.error(e);

   return json(
    {
     ok:false,
     error:
      e?.message||
      "Server error."
    },
    500
   );
  }
 }
};
