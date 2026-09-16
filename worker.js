const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const TARGET_NETWORK = 20000000;

const REGIONS = [
  ["US","North America"],
  ["CA","North America"],
  ["CN","China"],
  ["IN","India"],
  ["JP","Japan"],
  ["KR","South Korea"],
  ["DE","Europe"],
  ["GB","Europe"],
  ["FR","Europe"],
  ["IT","Europe"]
];

function json(data,status=200,headers={}) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers:{
        "Content-Type":"application/json;charset=UTF-8",
        ...headers
      }
    }
  );
}

function cookieValue(req,name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(^|;\\s*)"+name+"=([^;]*)"));
  return m ? decodeURIComponent(m[2]) : null;
}

function token() {
  return crypto.randomUUID()+crypto.randomUUID();
}

async function sha256(text) {
  const h = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );

  return [...new Uint8Array(h)]
    .map(x=>x.toString(16).padStart(2,"0"))
    .join("");
}

async function passwordHash(password,salt) {
  return sha256(salt+":"+password);
}

function sessionCookie(t) {
  return `nova_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearCookie() {
  return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/* =========================
   DATABASE
========================= */

async function ensureDB(db) {

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
      CREATE TABLE IF NOT EXISTS purchases(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
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
      CREATE TABLE IF NOT EXISTS suppliers(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT UNIQUE,
        country TEXT,
        website TEXT,
        description TEXT,
        region TEXT,
        source TEXT,
        product TEXT,
        verification_status TEXT,
        evidence_score REAL DEFAULT 0,
        risk_score REAL DEFAULT 0,
        supplier_score REAL DEFAULT 0,
        evidence INTEGER DEFAULT 0,
        deal_score INTEGER DEFAULT 0,
        price REAL,
        moq REAL,
        lead_time TEXT,
        confidence INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
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
        expires_at TEXT,
        status TEXT DEFAULT 'submitted',
        url TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS rfqs(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        product TEXT,
        quantity REAL,
        destination TEXT,
        requirements TEXT,
        message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)

  ]);

}

/* =========================
   AUTH
========================= */

async function currentUser(req,db) {

  if(!db) return null;

  const t = cookieValue(req,"nova_session");

  if(!t) return null;

  return db.prepare(`
    SELECT
      users.id,
      users.email
    FROM sessions
    JOIN users
      ON users.id=sessions.user_id
    WHERE sessions.token=?
      AND sessions.expires_at>?
  `)
  .bind(t,Date.now())
  .first();
}

/* =========================
   SUPPLIER ANALYSIS
========================= */

function parsePrice(text) {

  const m = String(text||"").match(
    /(?:USD|US\$|\$)\s?(\d+(?:\.\d+)?)/i
  );

  return m ? Number(m[1]) : null;
}

function parseMOQ(text) {

  const m = String(text||"").match(
    /(?:MOQ|minimum order quantity|min(?:imum)? order)\D{0,40}([\d,]+)/i
  );

  return m
    ? Number(m[1].replace(/,/g,""))
    : null;
}

function parseLead(text) {

  const m = String(text||"").match(
    /(\d+(?:\s*-\s*\d+)?)\s*(days?|weeks?)/i
  );

  return m ? m[0] : null;
}

function supplierSignals(text) {

  const s = String(text||"").toLowerCase();

  const words = [
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
  ];

  return words.reduce(
    (n,w)=>n+(s.includes(w)?1:0),
    0
  );
}

function evidenceScore(text) {

  const s = String(text||"").toLowerCase();

  let score = 0;

  const signals = [
    ["$",10],
    ["moq",10],
    ["minimum order",10],
    ["shipping",5],
    ["lead time",5],
    ["manufacturer",5],
    ["factory",5],
    ["oem",5],
    ["odm",5]
  ];

  for(const [word,value] of signals) {

    if(s.includes(word)) {
      score += value;
    }

  }

  return Math.min(50,score);
}

function dealScore(sig,ev,price,moq) {

  return Math.min(
    100,
    Math.max(
      0,
      50 +
      sig*3 +
      ev +
      (price!==null ? 5 : 0) +
      (moq!==null ? 5 : 0)
    )
  );
}

function confidence(ev) {
  return Math.min(
    100,
    Math.round(ev*1.6)
  );
}

/* =========================
   YEP SEARCH
========================= */

async function yepSearch(
  query,
  location,
  env,
  limit=10
) {

  if(!env.YEP_API_KEY) {
    throw new Error(
      "YEP_API_KEY is missing in Cloudflare."
    );
  }

  const response = await fetch(
    "https://platform.yep.com/api/search",
    {
      method:"POST",
      headers:{
        Authorization:`Bearer ${env.YEP_API_KEY}`,
        "Content-Type":"application/json"
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

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Yep returned invalid response. HTTP ${response.status}`
    );
  }

  if(!response.ok) {

    throw new Error(
      data.error ||
      `Yep HTTP ${response.status}`
    );

  }

  return data;
}

/* =========================
   GLOBAL SUPPLIER ENGINE
========================= */

async function searchSuppliers(
  requestText,
  env,
  db
) {

  const clean = String(requestText||"")
    .replace(/\s+/g," ")
    .trim()
    .slice(0,700);

  if(!clean) {
    throw new Error(
      "Please enter a procurement request."
    );
  }

  const base =
    `${clean} manufacturer factory supplier wholesale OEM ODM exporter bulk custom MOQ price quotation production lead time shipping`;

  const searches = REGIONS.map(
    ([code]) =>
      yepSearch(base,code,env,10)
  );

  const settled =
    await Promise.allSettled(searches);

  const results = [];

  for(let i=0;i<settled.length;i++) {

    const item = settled[i];

    if(item.status!=="fulfilled") {
      continue;
    }

    const raw =
      Array.isArray(item.value.results)
        ? item.value.results
        : [];

    for(const r of raw) {

      const title =
        r.title ||
        r.name ||
        "Supplier";

      const url =
        r.url ||
        r.link ||
        "";

      if(!url) continue;

      const snippet =
        r.snippet ||
        r.description ||
        r.text ||
        "";

      const combined =
        `${title} ${snippet}`;

      const price =
        parsePrice(combined);

      const moq =
        parseMOQ(combined);

      const lead =
        parseLead(combined);

      const sig =
        supplierSignals(combined);

      const ev =
        evidenceScore(combined);

      const score =
        dealScore(
          sig,
          ev,
          price,
          moq
        );

      const conf =
        confidence(ev);

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

        confidence:conf,

        dealScore:score,

        region:REGIONS[i][1],

        country:REGIONS[i][0],

        verified:false,

        verification:"Not verified"

      });

    }

  }

  /* Remove duplicates */

  const unique =
    [...new Map(
      results.map(
        r=>[r.url,r]
      )
    ).values()]
    .sort(
      (a,b)=>b.dealScore-a.dealScore
    )
    .slice(0,60);

  /* Save only columns that exist
     in both old and new NOVA databases */

  if(db && unique.length) {

    const statements =
      unique.map(r=>{

        return db.prepare(`
          INSERT OR IGNORE INTO suppliers
          (name,url,country,source)
          VALUES(?,?,?,?)
        `)
        .bind(
          r.title,
          r.url,
          r.country,
          "Yep"
        );

      });

    await db.batch(statements);

  }

  return {

    ok:true,

    results:unique,

    total:unique.length,

    networkTarget:TARGET_NETWORK

  };
}

/* =========================
   AI
========================= */

async function ai(
  env,
  system,
  user,
  max_tokens=900
) {

  if(!env.AI) {

    throw new Error(
      "Workers AI binding AI is missing."
    );

  }

  const response =
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
        max_tokens
      }
    );

  return (
    response.response ||
    "No AI response generated."
  );
}

/* =========================
   NEGOTIATION
========================= */

async function negotiate(
  body,
  env
) {

  return ai(

    env,

    `You are NOVA, an AI procurement negotiation agent.

Never invent supplier facts.

Separate verified facts from assumptions.

Use the user's supplied price and quantity context.

Return:
1. Offer analysis
2. Target price/range
3. Counteroffer
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Risks
8. Ready-to-send negotiation message.`,

    `Supplier:
${body.supplier}

Offer:
${body.offer}

Supplier reply:
${body.reply || "Not provided"}`

  );

}

/* =========================
   LANDED COST
========================= */

function landed(body) {

  const quantity =
    Math.max(
      0,
      Number(
        body.quantity
      ) || 0
    );

  const unitPrice =
    Math.max(
      0,
      Number(
        body.unitPrice
      ) || 0
    );

  const shipping =
    Math.max(
      0,
      Number(
        body.shipping
      ) || 0
    );

  const dutyPercent =
    Math.max(
      0,
      Number(
        body.dutyPercent
      ) || 0
    );

  const taxPercent =
    Math.max(
      0,
      Number(
        body.taxPercent
      ) || 0
    );

  const localDelivery =
    Math.max(
      0,
      Number(
        body.localDelivery
      ) || 0
    );

  const goods =
    quantity*unitPrice;

  const duty =
    goods*dutyPercent/100;

  const taxable =
    goods+shipping+duty;

  const tax =
    taxable*taxPercent/100;

  const total =
    goods+
    shipping+
    duty+
    tax+
    localDelivery;

  return {

    goods,

    shipping,

    duty,

    tax,

    localDelivery,

    total,

    unitLanded:
      quantity
        ? total/quantity
        : 0,

    status:
      "Estimated — verify freight, customs and taxes before payment"

  };

}

/* =========================
   SEO
========================= */

function htmlPage(
  title,
  description,
  path
) {

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
<link rel="canonical" href="https://nova-procurement.nova-procurement-ai.workers.dev${path}">
</head>
<body style="font-family:Arial;max-width:900px;margin:40px auto;padding:20px">
<h1>${title}</h1>
<p>${description}</p>
<h2>NOVA Procurement AI</h2>
<p>
Search suppliers, compare commercial evidence,
estimate landed cost, generate RFQs and negotiate offers.
</p>
<p>
<a href="/">Open NOVA</a>
</p>
</body>
</html>`;

}

const SEO = {

  "/ai-procurement":[
    "AI Procurement | NOVA",
    "AI purchasing agent for supplier discovery, comparison, RFQs and negotiation."
  ],

  "/ai-sourcing":[
    "AI Sourcing | NOVA",
    "Search global manufacturers and suppliers with evidence-first deal intelligence."
  ],

  "/supplier-finder":[
    "Supplier Finder | NOVA",
    "Find manufacturers and suppliers across global markets."
  ],

  "/supplier-comparison":[
    "Supplier Comparison | NOVA",
    "Compare supplier evidence, price, MOQ, lead time and deal score."
  ],

  "/china-suppliers":[
    "China Suppliers | NOVA",
    "Discover Chinese manufacturers and wholesale suppliers."
  ],

  "/wholesale-suppliers":[
    "Wholesale Suppliers | NOVA",
    "Find global wholesale suppliers and manufacturers."
  ],

  "/ai-purchasing-agent":[
    "AI Purchasing Agent | NOVA",
    "NOVA searches, analyzes, creates RFQs and negotiates procurement offers."
  ],

  "/flash-deals":[
    "Factory Flash Deals | NOVA",
    "Discover submitted factory commercial deals."
  ]

};

/* =========================
   MAIN WORKER
========================= */

export default {

  async fetch(request,env) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {

      if(env.DB) {

        await ensureDB(env.DB);

      }

      /* Robots */

      if(path==="/robots.txt") {

        return new Response(
          `User-agent: *
Allow: /
Sitemap: ${url.origin}/sitemap.xml`,
          {
            headers:{
              "Content-Type":"text/plain"
            }
          }
        );

      }

      /* Sitemap */

      if(path==="/sitemap.xml") {

        const paths = [
          "/",
          "/ai-procurement",
          "/ai-sourcing",
          "/supplier-finder",
          "/supplier-comparison",
          "/china-suppliers",
          "/wholesale-suppliers",
          "/ai-purchasing-agent",
          "/flash-deals"
        ];

        return new Response(

          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(
  x=>`<url><loc>${url.origin}${x}</loc></url>`
).join("")}
</urlset>`,

          {
            headers:{
              "Content-Type":"application/xml"
            }
          }

        );

      }

      /* SEO pages */

      if(SEO[path]) {

        const [
          title,
          description
        ] = SEO[path];

        return new Response(
          htmlPage(
            title,
            description,
            path
          ),
          {
            headers:{
              "Content-Type":
                "text/html;charset=UTF-8"
            }
          }
        );

      }

      /* =========================
         SEARCH
      ========================= */

      if(
        path==="/api/search" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        return json(
          await searchSuppliers(
            body.request,
            env,
            env.DB
          )
        );

      }

      /* =========================
         NETWORK
      ========================= */

      if(
        path==="/api/network" &&
        request.method==="GET"
      ) {

        const row =
          env.DB
            ? await env.DB
                .prepare(
                  "SELECT COUNT(*) AS count FROM suppliers"
                )
                .first()
            : {count:0};

        return json({

          actualRecords:
            Number(row?.count || 0),

          targetRecords:
            TARGET_NETWORK,

          coverage:
            [
              ...new Set(
                REGIONS.map(
                  x=>x[1]
                )
              )
            ]

        });

      }

      /* =========================
         LANDED COST
      ========================= */

      if(
        path==="/api/landed-cost" &&
        request.method==="POST"
      ) {

        return json(
          landed(
            await request.json()
          )
        );

      }

      /* =========================
         RFQ
      ========================= */

      if(
        path==="/api/rfq" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        const message =
          await ai(

            env,

            `You write professional procurement RFQs.

Do not invent specifications.

Ask for:
unit price,
MOQ,
sample,
production lead time,
Incoterm,
packaging,
shipping,
payment terms,
certifications,
quotation validity.`,

            `Product:
${body.product}

Quantity:
${body.quantity}

Destination:
${body.destination}

Requirements:
${body.requirements || "None"}`

          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if(user && env.DB) {

          await env.DB.prepare(`
            INSERT INTO rfqs
            (user_id,product,quantity,destination,requirements,message)
            VALUES(?,?,?,?,?,?)
          `)
          .bind(
            user.id,
            body.product || "",
            Number(body.quantity)||0,
            body.destination || "",
            body.requirements || "",
            message
          )
          .run();

        }

        return json({
          success:true,
          message
        });

      }

      /* =========================
         NEGOTIATION
      ========================= */

      if(
        path==="/api/negotiate" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        if(
          !body.supplier ||
          !body.offer
        ) {

          return json(
            {
              error:
                "Supplier and offer are required."
            },
            400
          );

        }

        const result =
          await negotiate(
            body,
            env
          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if(user && env.DB) {

          await env.DB.prepare(`
            INSERT INTO negotiations
            (user_id,supplier,offer,result)
            VALUES(?,?,?,?)
          `)
          .bind(
            user.id,
            body.supplier,
            body.offer,
            result
          )
          .run();

        }

        return json({
          success:true,
          result
        });

      }

      /* =========================
         FLASH DEALS
      ========================= */

      if(
        path==="/api/deals" &&
        request.method==="GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM flash_deals
              WHERE status='submitted'
              AND (
                expires_at IS NULL
                OR expires_at>datetime('now')
              )
              ORDER BY id DESC
              LIMIT 50
            `)
            .all();

        return json({
          deals:
            rows.results || []
        });

      }

      if(
        path==="/api/deals" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        await env.DB.prepare(`
          INSERT INTO flash_deals
          (
            user_id,
            company,
            product,
            description,
            country,
            quantity,
            price,
            currency,
            moq,
            expires_at,
            url
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `)
        .bind(
          user?.id || null,
          body.company || "",
          body.product || "",
          body.description || "",
          body.country || "",
          Number(body.quantity)||0,
          Number(body.price)||0,
          body.currency || "USD",
          Number(body.moq)||0,
          body.expiresAt || null,
          body.url || ""
        )
        .run();

        return json({
          success:true,
          status:"submitted"
        });

      }

      /* =========================
         SIGN UP
      ========================= */

      if(
        path==="/api/signup" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        const email =
          String(body.email||"")
            .trim()
            .toLowerCase();

        const password =
          String(body.password||"");

        if(
          !email ||
          password.length<6
        ) {

          return json(
            {
              error:
                "Valid email and password of at least 6 characters are required."
            },
            400
          );

        }

        const existing =
          await env.DB
            .prepare(
              "SELECT id FROM users WHERE email=?"
            )
            .bind(email)
            .first();

        if(existing) {

          return json(
            {
              error:
                "Account already exists."
            },
            409
          );

        }

        const salt =
          token();

        const hash =
          await passwordHash(
            password,
            salt
          );

        const result =
          await env.DB.prepare(`
            INSERT INTO users
            (email,password_hash,salt)
            VALUES(?,?,?)
          `)
          .bind(
            email,
            hash,
            salt
          )
          .run();

        const session =
          token();

        await env.DB.prepare(`
          INSERT INTO sessions
          (token,user_id,expires_at)
          VALUES(?,?,?)
        `)
        .bind(
          session,
          result.meta.last_row_id,
          Date.now()+604800000
        )
        .run();

        return json(
          {
            success:true,
            email
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(session)
          }
        );

      }

      /* =========================
         LOGIN
      ========================= */

      if(
        path==="/api/login" &&
        request.method==="POST"
      ) {

        const body =
          await request.json();

        const email =
          String(body.email||"")
            .trim()
            .toLowerCase();

        const password =
          String(body.password||"");

        const user =
          await env.DB
            .prepare(
              "SELECT * FROM users WHERE email=?"
            )
            .bind(email)
            .first();

        if(
          !user ||
          await passwordHash(
            password,
            user.salt
          ) !== user.password_hash
        ) {

          return json(
            {
              error:
                "Invalid email or password."
            },
            401
          );

        }

        const session =
          token();

        await env.DB.prepare(`
          INSERT INTO sessions
          (token,user_id,expires_at)
          VALUES(?,?,?)
        `)
        .bind(
          session,
          user.id,
          Date.now()+604800000
        )
        .run();

        return json(
          {
            success:true,
            email
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(session)
          }
        );

      }

      /* =========================
         LOGOUT
      ========================= */

      if(path==="/api/logout") {

        const session =
          cookieValue(
            request,
            "nova_session"
          );

        if(session) {

          await env.DB
            .prepare(
              "DELETE FROM sessions WHERE token=?"
            )
            .bind(session)
            .run();

        }

        return json(
          {
            success:true
          },
          200,
          {
            "Set-Cookie":
              clearCookie()
          }
        );

      }

      /* =========================
         ACCOUNT
      ========================= */

      if(path==="/api/me") {

        const user =
          await currentUser(
            request,
            env.DB
          );

        return json({

          loggedIn:!!user,

          user:
            user || null

        });

      }

      /* =========================
         PURCHASE HISTORY
      ========================= */

      if(
        path==="/api/purchases" &&
        request.method==="POST"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        if(!user) {

          return json(
            {
              error:
                "Please login first."
            },
            401
          );

        }

        const body =
          await request.json();

        await env.DB.prepare(`
          INSERT INTO purchases
          (
            user_id,
            product,
            supplier,
            quantity,
            unit_price,
            shipping,
            landed_cost,
            supplier_url
          )
          VALUES(?,?,?,?,?,?,?,?)
        `)
        .bind(
          user.id,
          body.product || "",
          body.supplier || "",
          Number(body.quantity)||0,
          Number(body.unitPrice)||0,
          Number(body.shipping)||0,
          Number(body.landedCost)||0,
          body.supplierUrl || ""
        )
        .run();

        return json({
          success:true
        });

      }

      if(
        path==="/api/purchases" &&
        request.method==="GET"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        if(!user) {

          return json(
            {
              error:
                "Please login first."
            },
            401
          );

        }

        const rows =
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
          purchases:
            rows.results || []
        });

      }

      /* =========================
         STATIC NOVA
      ========================= */

      return env.ASSETS.fetch(
        request
      );

    } catch(error) {

      return json(
        {
          ok:false,
          error:
            error?.message ||
            "Server error."
        },
        500
      );

    }

  }

};
