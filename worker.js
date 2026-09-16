const MODEL="@cf/meta/llama-3.1-8b-instruct-fast";

const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json","Cache-Control":"no-store",...headers}});
const body=async r=>{try{return await r.json()}catch{return{}}};
const clean=(v,n=10000)=>String(v??"").trim().slice(0,n);
const num=(v,d=0)=>Number.isFinite(Number(v))?Number(v):d;
const now=()=>Date.now();

async function hashPassword(p){
 const h=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(String(p)));
 return [...new Uint8Array(h)].map(x=>x.toString(16).padStart(2,"0")).join("");
}

function cookie(r,n){
 for(const x of (r.headers.get("Cookie")||"").split(";")){
  const [k,...v]=x.trim().split("=");
  if(k===n)return decodeURIComponent(v.join("="));
 }
 return null;
}

function sessionCookie(id,maxAge=2592000){
 return `nova_session=${encodeURIComponent(id)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function clearCookie(){
 return "nova_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax";
}

/* =========================================================
   DATABASE
========================================================= */

async function db(env){

 if(!env.DB)
  throw Error("D1 database binding DB is not configured.");

 await env.DB.batch([

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS sessions(
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS purchases(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    product TEXT,
    supplier TEXT,
    quantity REAL,
    unit_price REAL,
    landed_cost REAL,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS negotiations(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    supplier TEXT,
    offer TEXT,
    reply TEXT,
    result TEXT,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS deals(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    company TEXT,
    product TEXT,
    country TEXT,
    quantity REAL,
    price REAL,
    moq REAL,
    description TEXT,
    url TEXT,
    status TEXT,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS suppliers(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    country TEXT,
    website TEXT,
    description TEXT,
    source TEXT,
    verification_status TEXT DEFAULT 'not_verified',
    evidence_score REAL DEFAULT 0,
    risk_score REAL DEFAULT 0,
    supplier_score REAL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS supplier_evidence(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL,
    evidence_type TEXT,
    source_url TEXT,
    evidence_text TEXT,
    score REAL DEFAULT 0,
    verified INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS procurement_projects(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    name TEXT NOT NULL,
    product TEXT,
    quantity REAL,
    destination TEXT,
    requirements TEXT,
    status TEXT DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS rfqs(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    user_id INTEGER,
    product TEXT,
    quantity REAL,
    destination TEXT,
    requirements TEXT,
    message TEXT,
    status TEXT DEFAULT 'draft',
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
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
    quality_notes TEXT,
    offer_text TEXT,
    comparison_score REAL DEFAULT 0,
    status TEXT DEFAULT 'submitted',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS purchase_orders(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    bid_id INTEGER,
    user_id INTEGER,
    po_number TEXT UNIQUE,
    supplier_name TEXT,
    product TEXT,
    quantity REAL,
    unit_price REAL,
    total_value REAL,
    currency TEXT DEFAULT 'USD',
    destination TEXT,
    payment_terms TEXT,
    incoterm TEXT,
    status TEXT DEFAULT 'draft',
    created_at INTEGER NOT NULL
   )
  `),

  env.DB.prepare(`
   CREATE TABLE IF NOT EXISTS procurement_memory(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    project_id INTEGER,
    memory_type TEXT,
    memory_key TEXT,
    memory_value TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
   )
  `)

 ]);
}

/* =========================================================
   AUTH
========================================================= */

async function auth(r,env){

 const sid=cookie(r,"nova_session");

 if(!sid)
  throw Error("Authentication required.");

 const x=await env.DB.prepare(`
  SELECT sessions.*,users.email
  FROM sessions
  JOIN users ON users.id=sessions.user_id
  WHERE sessions.id=?
  LIMIT 1
 `).bind(sid).first();

 if(!x || Number(x.expires_at)<now())
  throw Error("Authentication required.");

 return {
  id:x.user_id,
  email:x.email,
  sessionId:sid
 };
}

/* =========================================================
   PAGE INTELLIGENCE
========================================================= */

function extractPrice(t){

 const s=String(t||"");

 const patterns=[
  /\b(?:US\$|USD|\$)\s*([0-9]+(?:\.[0-9]+)?)/i,
  /\b([0-9]+(?:\.[0-9]+)?)\s*(?:USD|US dollars)\b/i,
  /\bprice\s*(?:per\s*(?:piece|unit))?\s*[:\-]?\s*(?:US\$|USD|\$)?\s*([0-9]+(?:\.[0-9]+)?)/i
 ];

 for(const p of patterns){

  const m=s.match(p);

  if(m)
   return Number(m[1]);

 }

 return null;
}

function extractMOQ(t){

 const s=String(t||"");

 const patterns=[
  /\bMOQ\s*[:\-]?\s*([0-9][0-9,]*)/i,
  /\bminimum\s+order\s+quantity\s*[:\-]?\s*([0-9][0-9,]*)/i,
  /\bminimum\s+order\s*[:\-]?\s*([0-9][0-9,]*)\s*(?:pcs|pieces|units)?/i,
  /\b([0-9][0-9,]*)\s*(?:pcs|pieces|units)\s*(?:MOQ|minimum\s+order)/i
 ];

 for(const p of patterns){

  const m=s.match(p);

  if(m)
   return Number(m[1].replace(/,/g,""));

 }

 return null;
}

function extractLead(t){

 const s=String(t||"");

 const patterns=[
  /\blead\s*time\s*[:\-]?\s*([0-9]+)\s*(?:-|–|to)?\s*([0-9]+)?\s*days?/i,
  /\bproduction\s*time\s*[:\-]?\s*([0-9]+)\s*(?:-|–|to)?\s*([0-9]+)?\s*days?/i,
  /\b([0-9]+)\s*(?:-|–|to)\s*([0-9]+)\s*days?\b/i
 ];

 for(const p of patterns){

  const m=s.match(p);

  if(m)
   return m[2]
    ? `${m[1]}-${m[2]} days`
    : `${m[1]} days`;

 }

 return null;
}

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

async function fetchSupplierPage(url){

 if(!/^https?:\/\//i.test(url))
  return "";

 try{

  const r=await fetch(url,{
   method:"GET",
   redirect:"follow",
   headers:{
    "User-Agent":"Mozilla/5.0 (compatible; NOVA Procurement/2.0)",
    "Accept":"text/html,application/xhtml+xml"
   }
  });

  if(!r.ok)
   return "";

  const type=r.headers.get("content-type")||"";

  if(!type.includes("text/html"))
   return "";

  return htmlToText(await r.text());

 }catch{

  return "";

 }
}

/* =========================================================
   SUPPLIER INTELLIGENCE
========================================================= */

function evidenceScore(t){

 const s=String(t||"").toLowerCase();

 let n=0;

 if(/supplier|factory|manufacturer/.test(s))
  n+=10;

 if(/wholesale|bulk/.test(s))
  n+=10;

 if(/oem|odm|custom/.test(s))
  n+=10;

 if(/moq|minimum order/.test(s))
  n+=10;

 if(/price|usd|\$|quotation/.test(s))
  n+=10;

 if(/lead time|shipping|delivery/.test(s))
  n+=10;

 return Math.min(50,n);
}

function dealScore(t){

 const s=String(t||"").toLowerCase();

 let n=0;

 if(/factory|manufacturer/.test(s))
  n+=15;

 if(/wholesale|bulk/.test(s))
  n+=10;

 if(/oem|odm/.test(s))
  n+=5;

 if(/custom/.test(s))
  n+=5;

 return Math.min(35,n);
}

function countryFromText(t){

 const s=String(t||"").toLowerCase();

 if(/china|shenzhen|guangzhou|yiwu|ningbo/.test(s))
  return "China";

 if(/india|delhi|mumbai|bangalore/.test(s))
  return "India";

 if(/japan|tokyo|osaka/.test(s))
  return "Japan";

 if(/south korea|korea|seoul/.test(s))
  return "South Korea";

 if(/germany|france|italy|spain|netherlands|europe/.test(s))
  return "Europe";

 if(/usa|united states|america/.test(s))
  return "North America";

 return "Global";
}

function normalizeSearchResultBase(item){

 const title=clean(
  item?.title ||
  item?.name ||
  item?.headline ||
  "",
  500
 );

 const url=clean(
  item?.url ||
  item?.link ||
  "",
  2000
 );

 const snippet=clean(
  item?.snippet ||
  item?.description ||
  item?.content ||
  "",
  3000
 );

 const combined=`${title} ${snippet}`;

 const evidence=evidenceScore(combined);

 return {

  title,
  url,
  snippet,

  country:countryFromText(combined),
  region:countryFromText(combined),

  price:extractPrice(combined),
  moq:extractMOQ(combined),
  leadTime:extractLead(combined),

  evidence,

  confidence:
   Math.min(
    98,
    Math.round(evidence*1.7)
   ),

  dealScore:dealScore(combined),

  pageChecked:false,

  verificationStatus:"not_verified"
 };
}

async function enrichSupplierResult(item){

 if(!item.url)
  return item;

 const pageText=await fetchSupplierPage(item.url);

 if(!pageText)
  return item;

 const price=extractPrice(pageText)??item.price;
 const moq=extractMOQ(pageText)??item.moq;
 const leadTime=extractLead(pageText)??item.leadTime;

 const evidence=Math.max(
  item.evidence,
  evidenceScore(pageText)
 );

 const confidence=Math.min(
  98,
  Math.round(
   evidence*1.7+
   (price!==null?8:0)+
   (moq!==null?5:0)+
   (leadTime?5:0)
  )
 );

 return {

  ...item,

  price,
  moq,
  leadTime,

  evidence,
  confidence,

  pageChecked:true,

  verificationStatus:
   price!==null ||
   moq!==null ||
   leadTime
    ? "partially_verified"
    : "not_verified"
 };
}

/* =========================================================
   YEP SEARCH
========================================================= */

async function yepSearch(env,query){

 if(!env.YEP_API_KEY)
  throw Error("YEP_API_KEY is not configured.");

 const r=await fetch(
  "https://platform.yep.com/api/search",
  {
   method:"POST",

   headers:{
    "Authorization":`Bearer ${env.YEP_API_KEY}`,
    "Content-Type":"application/json"
   },

   body:JSON.stringify({
    query,
    type:"basic",
    limit:20,
    language:["en"],
    location:"US"
   })
  }
 );

 const t=await r.text();

 let d;

 try{
  d=JSON.parse(t);
 }catch{
  throw Error(
   `Yep search returned invalid JSON (${r.status}).`
  );
 }

 if(!r.ok)
  throw Error(
   d?.error ||
   d?.message ||
   `Yep search failed (${r.status}).`
  );

 return d;
}

/* =========================================================
   AI
========================================================= */

async function runAI(env,messages){

 if(!env.AI)
  throw Error("Workers AI is not configured.");

 const r=await env.AI.run(
  MODEL,
  {
   messages,
   max_tokens:1200,
   temperature:.2
  }
 );

 return (
  r?.response ||
  r?.result?.response ||
  JSON.stringify(r)
 );
}

/* =========================================================
   RFQ
========================================================= */

async function generateRFQ(
 env,
 product,
 quantity,
 destination,
 requirements
){

 try{

  return await runAI(
   env,
   [
    {
     role:"system",
     content:
      "You are NOVA, a professional procurement specialist. Return 4-6 concise commercial questions about unit price, MOQ, lead time, samples, payment, shipping and Incoterms. Do not invent facts."
    },
    {
     role:"user",
     content:
      `Product: ${product}
Quantity: ${quantity}
Destination: ${destination}
Requirements: ${requirements}`
    }
   ]
  );

 }catch{

  return `
- Best unit price
- MOQ and quantity discounts
- Production lead time
- Sample availability and cost
- Payment terms
- Shipping terms and Incoterms
`.trim();

 }
}

/* =========================================================
   SUPPLIER SCORE
========================================================= */

function supplierScore(
 evidence,
 risk,
 price,
 moq,
 lead
){

 return Math.round(
  Math.max(
   0,
   Math.min(
    100,
    Math.min(40,evidence||0)+
    Math.max(0,Math.min(30,30-risk*.3))+
    (price!==null?15:0)+
    (moq!==null?5:0)+
    (lead?5:0)
   )
  )
 );
}

/* =========================================================
   BID SCORE
========================================================= */

function bidScore(x){

 const landed=
  num(
   x.landed_cost,
   num(x.unit_price)+
   num(x.shipping)+
   num(x.duty)+
   num(x.tax)
  );

 let s=50;

 if(landed>0)
  s+=Math.max(
   0,
   Math.min(30,30-landed)
  );

 if(x.moq!=null)
  s+=5;

 if(x.lead_time)
  s+=5;

 if(x.payment_terms)
  s+=5;

 if(x.incoterm)
  s+=5;

 return Math.round(
  Math.max(0,Math.min(100,s))
 );
}

/* =========================================================
   MAIN
========================================================= */

export default {

 async fetch(request,env){

  const u=new URL(request.url);
  const p=u.pathname;
  const m=request.method;

  try{

   await db(env);

   if(m==="OPTIONS"){

    return new Response(null,{
     status:204,
     headers:{
      "Access-Control-Allow-Origin":"*",
      "Access-Control-Allow-Methods":"GET,POST,OPTIONS",
      "Access-Control-Allow-Headers":"Content-Type"
     }
    });

   }

   /* =====================================================
      SIGNUP
   ===================================================== */

   if(p==="/api/signup"&&m==="POST"){

    const d=await body(request);

    const email=
     clean(d.email,320).toLowerCase();

    const pw=String(d.password||"");

    if(!email||pw.length<6){

     return json(
      {
       error:
        "Valid email and password of at least 6 characters are required."
      },
      400
     );

    }

    const exists=
     await env.DB
      .prepare(
       "SELECT id FROM users WHERE email=?"
      )
      .bind(email)
      .first();

    if(exists){

     return json(
      {
       error:
        "An account with this email already exists."
      },
      409
     );

    }

    const r=
     await env.DB
      .prepare(
       "INSERT INTO users(email,password_hash,created_at) VALUES(?,?,?)"
      )
      .bind(
       email,
       await hashPassword(pw),
       now()
      )
      .run();

    return json({
     ok:true,
     user:{
      id:r.meta.last_row_id,
      email
     }
    });

   }

   /* =====================================================
      LOGIN
   ===================================================== */

   if(p==="/api/login"&&m==="POST"){

    const d=await body(request);

    const email=
     clean(d.email,320).toLowerCase();

    const x=
     await env.DB
      .prepare(
       "SELECT id,email FROM users WHERE email=? AND password_hash=?"
      )
      .bind(
       email,
       await hashPassword(d.password||"")
      )
      .first();

    if(!x){

     return json(
      {
       error:
        "Invalid email or password."
      },
      401
     );

    }

    const sid=crypto.randomUUID();

    await env.DB
     .prepare(
      "INSERT INTO sessions(id,user_id,expires_at,created_at) VALUES(?,?,?,?)"
     )
     .bind(
      sid,
      x.id,
      now()+2592000000,
      now()
     )
     .run();

    return json(
     {
      ok:true,
      user:x
     },
     200,
     {
      "Set-Cookie":
       sessionCookie(sid)
     }
    );

   }

   /* =====================================================
      LOGOUT
   ===================================================== */

   if(p==="/api/logout"&&m==="POST"){

    const sid=cookie(
     request,
     "nova_session"
    );

    if(sid){

     await env.DB
      .prepare(
       "DELETE FROM sessions WHERE id=?"
      )
      .bind(sid)
      .run();

    }

    return json(
     {ok:true},
     200,
     {
      "Set-Cookie":
       clearCookie()
     }
    );

   }

   /* =====================================================
      ME
   ===================================================== */

   if(p==="/api/me"&&m==="GET"){

    try{

     const x=
      await auth(request,env);

     return json({
      ok:true,
      loggedIn:true,
      user:{
       id:x.id,
       email:x.email
      }
     });

    }catch{

     return json({
      ok:true,
      loggedIn:false,
      user:null
     });

    }

   }

   /* =====================================================
      NETWORK
   ===================================================== */

   if(p==="/api/network"&&m==="GET"){

    const a=
     await env.DB
      .prepare(
       "SELECT COUNT(*) count FROM suppliers"
      )
      .first();

    const e=
     await env.DB
      .prepare(
       "SELECT COUNT(*) count FROM supplier_evidence"
      )
      .first();

    return json({
     ok:true,
     actualRecords:
      Number(a?.count||0),
     targetRecords:20000000,
     evidenceRecords:
      Number(e?.count||0),
     coverage:[
      "China",
      "India",
      "Japan",
      "South Korea",
      "Europe",
      "North America"
     ],
     status:
      "Live supplier discovery through configured search sources."
    });

   }

   /* =====================================================
      SEARCH SUPPLIERS
   ===================================================== */

   if(p==="/api/search"&&m==="POST"){

    const d=await body(request);

    const q=
     clean(
      d.query||
      d.product||
      d.request,
      2000
     );

    if(!q){

     return json(
      {
       error:
        "Search query is required."
      },
      400
     );

    }

    const searchQuery=`
${q}
manufacturer supplier factory wholesale OEM ODM exporter
bulk custom logo MOQ minimum order quantity
unit price USD quotation production lead time shipping
`
     .replace(/\s+/g," ")
     .trim();

    const yd=
     await yepSearch(
      env,
      searchQuery
     );

    const raw=
     Array.isArray(yd?.results)
      ?yd.results
      :[];

    const baseResults=
     raw
      .map(
       normalizeSearchResultBase
      )
      .filter(
       item=>
        item.title||
        item.url||
        item.snippet
      );

    /*
      Limit page fetching to the first
      10 strongest results.
      This keeps the Worker fast.
    */

    const top=
     baseResults.slice(0,10);

    const rest=
     baseResults.slice(10);

    const enriched=
     await Promise.all(
      top.map(
       item=>
        enrichSupplierResult(item)
      )
     );

    const results=[
     ...enriched,
     ...rest
    ];

    results.sort(
     (a,b)=>
      (b.dealScore-a.dealScore)||
      (b.evidence-a.evidence)||
      (b.confidence-a.confidence)
    );

    /* SAVE SUPPLIERS */

    for(const x of results){

     if(!x.title)
      continue;

     let s=
      await env.DB
       .prepare(
        "SELECT id FROM suppliers WHERE name=? AND website=? LIMIT 1"
       )
       .bind(
        x.title,
        x.url
       )
       .first();

     let id;

     const score=
      supplierScore(
       x.evidence,
       50,
       x.price,
       x.moq,
       x.leadTime
      );

     if(s){

      id=s.id;

      await env.DB
       .prepare(`
        UPDATE suppliers
        SET country=?,
            description=?,
            evidence_score=?,
            supplier_score=?,
            updated_at=?,
            verification_status=?
        WHERE id=?
       `)
       .bind(
        x.country,
        x.snippet,
        x.evidence,
        score,
        now(),
        x.verificationStatus,
        id
       )
       .run();

     }else{

      const r=
       await env.DB
        .prepare(`
         INSERT INTO suppliers(
          name,
          country,
          website,
          description,
          source,
          verification_status,
          evidence_score,
          risk_score,
          supplier_score,
          created_at,
          updated_at
         )
         VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `)
        .bind(
         x.title,
         x.country,
         x.url,
         x.snippet,
         "Yep",
         x.verificationStatus,
         x.evidence,
         50,
         score,
         now(),
         now()
        )
        .run();

      id=r.meta.last_row_id;

     }

     await env.DB
      .prepare(`
       INSERT INTO supplier_evidence(
        supplier_id,
        evidence_type,
        source_url,
        evidence_text,
        score,
        verified,
        created_at
       )
       VALUES(?,?,?,?,?,?,?)
      `)
      .bind(
       id,
       "supplier_page",
       x.url,
       `Page checked: ${x.pageChecked}; Price: ${x.price??"Not verified"}; MOQ: ${x.moq??"Not verified"}; Lead time: ${x.leadTime??"Not verified"}`,
       x.evidence,
       0,
       now()
      )
      .run();

    }

    return json({
     ok:true,
     results,
     total:results.length,
     query:searchQuery,
     yepSuccess:true,
     request_id:
      yd?.request_id||null
    });

   }

   /* =====================================================
      SUPPLIERS
   ===================================================== */

   if(p==="/api/suppliers"&&m==="GET"){

    const limit=
     Math.min(
      100,
      Math.max(
       1,
       num(
        u.searchParams.get("limit"),
        50
       )
      )
     );

    const r=
     await env.DB
      .prepare(
       "SELECT * FROM suppliers ORDER BY supplier_score DESC,id DESC LIMIT ?"
      )
      .bind(limit)
      .all();

    return json({
     ok:true,
     suppliers:r.results||[]
    });

   }

   /* =====================================================
      SINGLE SUPPLIER
   ===================================================== */

   if(p==="/api/supplier"&&m==="POST"){

    const d=await body(request);

    const name=
     clean(d.name,500);

    if(!name)
     return json(
      {
       error:
        "Supplier name required."
      },
      400
     );

    const e=num(d.evidence);
    const r=num(d.risk,50);

    const score=
     supplierScore(
      e,
      r,
      d.price==null
       ?null
       :num(d.price),
      d.moq==null
       ?null
       :num(d.moq),
      d.leadTime
    );

    const x=
     await env.DB
      .prepare(`
       INSERT INTO suppliers(
        name,country,website,description,
        source,verification_status,
        evidence_score,risk_score,
        supplier_score,created_at,updated_at
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       name,
       clean(d.country,300),
       clean(d.website,2000),
       clean(d.description,3000),
       clean(d.source||"manual",100),
       clean(
        d.verificationStatus||
        "not_verified",
        100
       ),
       e,
       r,
       score,
       now(),
       now()
      )
      .run();

    return json({
     ok:true,
     supplierId:
      x.meta.last_row_id,
     supplierScore:score
    });

   }

   /* =====================================================
      PROJECTS CREATE
   ===================================================== */

   if(p==="/api/projects"&&m==="POST"){

    const d=await body(request);

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    const product=
     clean(d.product,1000);

    if(!product)
     return json(
      {
       error:
        "Product required."
      },
      400
     );

    const x=
     await env.DB
      .prepare(`
       INSERT INTO procurement_projects(
        user_id,name,product,
        quantity,destination,
        requirements,status,
        created_at,updated_at
       )
       VALUES(?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       a?.id||null,
       clean(
        d.name||product,
        500
       ),
       product,
       num(d.quantity),
       clean(d.destination,500),
       clean(d.requirements,5000),
       "active",
       now(),
       now()
      )
      .run();

    return json({
     ok:true,
     projectId:
      x.meta.last_row_id,
     status:"active"
    });

   }

   /* =====================================================
      PROJECTS LIST
   ===================================================== */

   if(p==="/api/projects"&&m==="GET"){

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    const r=a
     ?await env.DB
       .prepare(`
        SELECT *
        FROM procurement_projects
        WHERE user_id=? OR user_id IS NULL
        ORDER BY id DESC
        LIMIT 100
       `)
       .bind(a.id)
       .all()
     :await env.DB
       .prepare(`
        SELECT *
        FROM procurement_projects
        WHERE user_id IS NULL
        ORDER BY id DESC
        LIMIT 100
       `)
       .all();

    return json({
     ok:true,
     projects:r.results||[]
    });

   }

   /* =====================================================
      RFQ
   ===================================================== */

   if(p==="/api/rfq"&&m==="POST"){

    const d=await body(request);

    if(
     !clean(d.product,1000)||
     num(d.quantity)<=0||
     !clean(d.destination,300)
    )
     return json(
      {
       error:
        "Product, valid quantity and destination are required."
      },
      400
     );

    return json({
     ok:true,
     message:
      await generateRFQ(
       env,
       clean(d.product,1000),
       num(d.quantity),
       clean(d.destination,300),
       clean(d.requirements,3000)
      )
    });

   }

   /* =====================================================
      RFQ CREATE
   ===================================================== */

   if(p==="/api/rfq/create"&&m==="POST"){

    const d=await body(request);

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    const product=
     clean(d.product,1000);

    const quantity=
     num(d.quantity);

    const destination=
     clean(d.destination,500);

    const requirements=
     clean(d.requirements,5000);

    const message=
     await generateRFQ(
      env,
      product,
      quantity,
      destination,
      requirements
     );

    const x=
     await env.DB
      .prepare(`
       INSERT INTO rfqs(
        project_id,user_id,
        product,quantity,
        destination,requirements,
        message,status,
        created_at
       )
       VALUES(?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       d.projectId
        ?num(d.projectId)
        :null,
       a?.id||null,
       product,
       quantity,
       destination,
       requirements,
       message,
       "draft",
       now()
      )
      .run();

    return json({
     ok:true,
     rfqId:
      x.meta.last_row_id,
     message,
     status:"draft"
    });

   }

   /* =====================================================
      LANDED COST
   ===================================================== */

   if(p==="/api/landed-cost"&&m==="POST"){

    const d=await body(request);

    const quantity=
     num(d.unitPrice??d.unit_price);

    const q=
     num(d.quantity);

    const up=
     num(
      d.unitPrice??
      d.unit_price
     );

    const shipping=
     num(
      d.shipping
    );

    const insurance=
     num(
      d.insurance
    );

    const dutyPercent=
     num(
      d.dutyPercent??
      d.duty_percent
    );

    const taxPercent=
     num(
      d.taxPercent??
      d.tax_percent
    );

    const localDelivery=
     num(
      d.localDelivery??
      d.local_delivery
    );

    if(q<=0||up<0)
     return json(
      {
       error:
        "Quantity and unit price must be valid."
      },
      400
     );

    const goods=q*up;

    const duty=
     goods*dutyPercent/100;

    const base=
     goods+
     shipping+
     duty;

    const tax=
     base*taxPercent/100;

    const total=
     base+
     tax+
     insurance+
     localDelivery;

    return json({
     ok:true,
     quantity:q,
     unitPrice:up,
     goods,
     shipping,
     insurance,
     duty,
     tax,
     localDelivery,
     total,
     unitLanded:total/q,
     status:
      "Estimated landed cost. Verify destination customs, taxes, shipping and fees."
    });

   }

   /* =====================================================
      BIDS
   ===================================================== */

   if(p==="/api/bids"&&m==="POST"){

    const d=await body(request);

    const supplier=
     clean(
      d.supplierName??
      d.supplier,
      500
     );

    const unitPrice=
     num(
      d.unitPrice??
      d.unit_price
     );

    if(!supplier)
     return json(
      {
       error:
        "Supplier name required."
      },
      400
     );

    const x={
     unit_price:unitPrice,
     shipping:num(d.shipping),
     duty:num(d.duty),
     tax:num(d.tax),
     landed_cost:
      num(
       d.landedCost??
       d.landed_cost,
       unitPrice+
       num(d.shipping)+
       num(d.duty)+
       num(d.tax)
      ),
     moq:
      d.moq==null
       ?null
       :num(d.moq),
     lead_time:
      clean(
       d.leadTime??
       d.lead_time,
       200
      ),
     payment_terms:
      clean(
       d.paymentTerms??
       d.payment_terms,
       500
      ),
     incoterm:
      clean(d.incoterm,100)
    };

    const score=
     bidScore(x);

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
        quality_notes,offer_text,
        comparison_score,status,
        created_at,updated_at
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       d.projectId
        ?num(d.projectId)
        :null,

       d.supplierId
        ?num(d.supplierId)
        :null,

       supplier,
       unitPrice,
       num(d.quantity),
       x.moq,
       x.shipping,
       x.duty,
       x.tax,
       x.landed_cost,
       x.lead_time,
       x.payment_terms,
       x.incoterm,

       clean(
        d.qualityNotes??
        d.quality_notes,
        3000
       ),

       clean(
        d.offerText??
        d.offer_text,
        5000
       ),

       score,
       "submitted",
       now(),
       now()
      )
      .run();

    return json({
     ok:true,
     bidId:
      r.meta.last_row_id,
     comparisonScore:score
    });

   }

   /* =====================================================
      BID COMPARISON
   ===================================================== */

   if(
    p==="/api/bids/compare"&&
    (m==="GET"||m==="POST")
   ){

    const d=
     m==="POST"
      ?await body(request)
      :Object.fromEntries(
       u.searchParams
      );

    const id=
     num(
      d.projectId??
      d.project_id
     );

    if(!id)
     return json(
      {
       error:
        "Project ID required."
      },
      400
     );

    const r=
     await env.DB
      .prepare(`
       SELECT *
       FROM bids
       WHERE project_id=?
       ORDER BY comparison_score DESC,
                landed_cost ASC,
                id ASC
      `)
      .bind(id)
      .all();

    return json({
     ok:true,
     projectId:id,
     count:r.results?.length||0,
     bids:r.results||[],
     note:
      "Comparison score is a decision-support heuristic."
    });

   }

   /* =====================================================
      AWARD BID
   ===================================================== */

   if(p==="/api/award"&&m==="POST"){

    const d=await body(request);

    const id=
     num(
      d.bidId??
      d.bid_id
     );

    const b=
     await env.DB
      .prepare(
       "SELECT * FROM bids WHERE id=?"
      )
      .bind(id)
      .first();

    if(!b)
     return json(
      {
       error:
        "Bid not found."
      },
      404
     );

    await env.DB.batch([

     env.DB
      .prepare(`
       UPDATE bids
       SET status='awarded',
           updated_at=?
       WHERE id=?
      `)
      .bind(now(),id),

     env.DB
      .prepare(`
       UPDATE bids
       SET status='not_awarded',
           updated_at=?
       WHERE project_id=?
       AND id!=?
       AND status='submitted'
      `)
      .bind(
       now(),
       b.project_id,
       id
      )

    ]);

    return json({
     ok:true,
     bidId:id,
     status:"awarded",
     supplier:b.supplier_name
    });

   }

   /* =====================================================
      PURCHASE ORDERS
   ===================================================== */

   if(
    p==="/api/purchase-orders"&&
    m==="POST"
   ){

    const d=await body(request);

    const bidId=
     num(
      d.bidId??
      d.bid_id
     );

    if(!bidId)
     return json(
      {
       error:
        "Bid ID required."
      },
      400
     );

    const b=
     await env.DB
      .prepare(
       "SELECT * FROM bids WHERE id=?"
      )
      .bind(bidId)
      .first();

    if(!b)
     return json(
      {
       error:
        "Bid not found."
      },
      404
     );

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    const project=
     b.project_id
      ?await env.DB
       .prepare(
        "SELECT * FROM procurement_projects WHERE id=?"
       )
       .bind(b.project_id)
       .first()
      :null;

    const po=
     `NOVA-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0,8).toUpperCase()}`;

    const total=
     num(b.quantity)*
     num(b.unit_price);

    const r=
     await env.DB
      .prepare(`
       INSERT INTO purchase_orders(
        project_id,bid_id,user_id,
        po_number,supplier_name,
        product,quantity,unit_price,
        total_value,currency,
        destination,payment_terms,
        incoterm,status,created_at
       )
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
      .bind(
       b.project_id||null,
       bidId,
       a?.id||null,
       po,
       b.supplier_name,
       project?.product||"",
       b.quantity,
       b.unit_price,
       total,
       "USD",
       project?.destination||"",
       b.payment_terms||"",
       b.incoterm||"",
       "draft",
       now()
      )
      .run();

    return json({
     ok:true,
     purchaseOrderId:
      r.meta.last_row_id,
     poNumber:po,
     status:"draft",
     totalValue:total
    });

   }

   if(
    p==="/api/purchase-orders"&&
    m==="GET"
   ){

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    const r=a
     ?await env.DB
      .prepare(`
       SELECT *
       FROM purchase_orders
       WHERE user_id=? OR user_id IS NULL
       ORDER BY id DESC
       LIMIT 100
      `)
      .bind(a.id)
      .all()
     :await env.DB
      .prepare(`
       SELECT *
       FROM purchase_orders
       WHERE user_id IS NULL
       ORDER BY id DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     purchaseOrders:
      r.results||[]
    });

   }

   /* =====================================================
      AI NEGOTIATION
   ===================================================== */

   if(p==="/api/negotiate"&&m==="POST"){

    const d=await body(request);

    const supplier=
     clean(d.supplier,1000);

    const offer=
     clean(
      d.offer??
      d.message,
      5000
     );

    const reply=
     clean(
      d.reply??
      d.supplierReply,
      5000
     );

    const goal=
     clean(
      d.goal??
      d.target,
      3000
     );

    if(!offer&&!reply)
     return json(
      {
       error:
        "Supplier offer or reply is required."
      },
      400
     );

    const result=
     await runAI(
      env,
      [
       {
        role:"system",
        content:
         "You are NOVA, an expert procurement negotiation agent. Analyze the commercial offer and produce a professional buyer response. Do not invent facts or claim verification. Focus on price, MOQ, payment, lead time, shipping, quality and samples."
       },
       {
        role:"user",
        content:
         `Supplier: ${supplier}
Offer: ${offer}
Supplier reply: ${reply}
Goal: ${goal}`
       }
      ]
     );

    let a=null;

    try{
     a=await auth(
      request,
      env
     );
    }catch{}

    await env.DB
     .prepare(`
      INSERT INTO negotiations(
       user_id,supplier,
       offer,reply,result,
       created_at
      )
      VALUES(?,?,?,?,?,?)
     `)
     .bind(
      a?.id||null,
      supplier,
      offer,
      reply,
      result,
      now()
     )
     .run();

    return json({
     ok:true,
     reply:result,
     result
    });

   }

   /* =====================================================
      NEGOTIATIONS
   ===================================================== */

   if(
    p==="/api/negotiations"&&
    m==="GET"
   ){

    const r=
     await env.DB
      .prepare(`
       SELECT *
       FROM negotiations
       ORDER BY id DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     negotiations:
      r.results||[]
    });

   }

   /* =====================================================
      FLASH DEALS
   ===================================================== */

   if(
    p==="/api/deals"&&
    m==="GET"
   ){

    const r=
     await env.DB
      .prepare(`
       SELECT *
       FROM deals
       ORDER BY id DESC
       LIMIT 100
      `)
      .all();

    return json({
     ok:true,
     deals:r.results||[]
    });

   }

   if(
    p==="/api/deals"&&
    m==="POST"
   ){

    const d=await body(request);

    if(!clean(d.product,1000))
     return json(
      {
       error:
        "Product required."
      },
      400
     );

    await env.DB
     .prepare(`
      INSERT INTO deals(
       company,product,country,
       quantity,price,moq,
       description,url,
       status,created_at
      )
      VALUES(?,?,?,?,?,?,?,?,?,?)
     `)
     .bind(
      clean(
       d.company??
       d.supplier,
       500
      ),
      clean(d.product,1000),
      clean(d.country,300),
      num(d.quantity),
      num(d.price),
      num(d.moq),
      clean(
       d.description??
       d.snippet,
       3000
      ),
      clean(d.url,2000),
      "submitted",
      now()
     )
     .run();

    return json({
     ok:true,
     status:"submitted",
     message:
      "Deal submitted successfully."
    });

   }

   /* =====================================================
      PROCUREMENT MEMORY
   ===================================================== */

   if(
    p==="/api/memory"&&
    m==="POST"
   ){

    let a;

    try{
     a=await auth(
      request,
      env
     );
    }catch{
     return json(
      {
       error:
        "Authentication required."
      },
      401
     );
    }

    const d=await body(request);

    const key=
     clean(
      d.key||
      `${d.product||"procurement"}:${d.supplier||""}`,
      300
     );

    const value=
     clean(
      d.value||
      d.memory,
      5000
     );

    if(!key||!value)
     return json(
      {
       error:
        "Memory content required."
      },
      400
     );

    const old=
     await env.DB
      .prepare(`
       SELECT id
       FROM procurement_memory
       WHERE user_id=?
       AND memory_key=?
      `)
      .bind(
       a.id,
       key
      )
      .first();

    if(old){

     await env.DB
      .prepare(`
       UPDATE procurement_memory
       SET project_id=?,
           memory_type=?,
           memory_value=?,
           updated_at=?
       WHERE id=?
      `)
      .bind(
       d.projectId
        ?num(d.projectId)
        :null,
       clean(
        d.type||
        d.memoryType||
        d.outcome||
        "procurement",
        100
       ),
       value,
       now(),
       old.id
      )
      .run();

     return json({
      ok:true,
      memoryId:old.id,
      updated:true
     });

    }

    const r=
     await env.DB
      .prepare(`
       INSERT INTO procurement_memory(
        user_id,project_id,
        memory_type,memory_key,
        memory_value,
        created_at,updated_at
       )
       VALUES(?,?,?,?,?,?,?)
      `)
      .bind(
       a.id,
       d.projectId
        ?num(d.projectId)
        :null,
       clean(
        d.type||
        d.memoryType||
        d.outcome||
        "procurement",
        100
       ),
       key,
       value,
       now(),
       now()
      )
      .run();

    return json({
     ok:true,
     memoryId:
      r.meta.last_row_id,
     updated:false
    });

   }

   /* =====================================================
      MEMORY LIST
   ===================================================== */

   if(
    p==="/api/memory"&&
    m==="GET"
   ){

    let a;

    try{
     a=await auth(
      request,
      env
     );
    }catch{
     return json(
      {
       error:
        "Authentication required."
      },
      401
     );
    }

    const r=
     await env.DB
      .prepare(`
       SELECT *
       FROM procurement_memory
       WHERE user_id=?
       ORDER BY updated_at DESC
       LIMIT 200
      `)
      .bind(a.id)
      .all();

    return json({
     ok:true,
     memory:r.results||[]
    });

   }

   /* =====================================================
      PURCHASE HISTORY
   ===================================================== */

   if(
    p==="/api/purchases"&&
    m==="GET"
   ){

    let a;

    try{
     a=await auth(
      request,
      env
     );
    }catch{
     return json(
      {
       error:
        "Authentication required."
      },
      401
     );
    }

    const r=
     await env.DB
      .prepare(`
       SELECT *
       FROM purchases
       WHERE user_id=?
       ORDER BY id DESC
       LIMIT 100
      `)
      .bind(a.id)
      .all();

    return json({
     ok:true,
     purchases:r.results||[]
    });

   }

   if(
    p==="/api/purchases"&&
    m==="POST"
   ){

    let a;

    try{
     a=await auth(
      request,
      env
     );
    }catch{
     return json(
      {
       error:
        "Authentication required."
      },
      401
     );
    }

    const d=await body(request);

    if(!clean(d.product,1000))
     return json(
      {
       error:
        "Product required."
      },
      400
     );

    await env.DB
     .prepare(`
      INSERT INTO purchases(
       user_id,product,supplier,
       quantity,unit_price,
       landed_cost,created_at
      )
      VALUES(?,?,?,?,?,?,?)
     `)
     .bind(
      a.id,
      clean(d.product,1000),
      clean(d.supplier,1000),
      num(d.quantity),
      num(
       d.unitPrice??
       d.unit_price
      ),
      num(
       d.landedCost??
       d.landed_cost
      ),
      now()
     )
     .run();

    return json({
     ok:true,
     message:
      "Purchase saved successfully."
    });

   }

   /* =====================================================
      STATUS
   ===================================================== */

   if(
    p==="/api/status"&&
    m==="GET"
   ){

    return json({
     ok:Boolean(
      env.DB&&
      env.AI&&
      env.YEP_API_KEY
     ),

     nova:"2.1",

     integrations:{
      cloudflareD1:Boolean(env.DB),
      cloudflareAI:Boolean(env.AI),
      yepSearch:Boolean(
       env.YEP_API_KEY
      )
     },

     modules:{
      supplierPageIntelligence:true,
      supplierEvidence:true,
      procurementProjects:true,
      rfqManagement:true,
      bidManagement:true,
      bidComparison:true,
      purchaseOrders:true,
      procurementMemory:true,
      aiNegotiation:true,
      landedCost:true
     }
    });

   }

   /* =====================================================
      STATIC FRONTEND
   ===================================================== */

   if(env.ASSETS)
    return env.ASSETS.fetch(request);

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
      "Internal server error."
    },
    500
   );

  }

 }
};
