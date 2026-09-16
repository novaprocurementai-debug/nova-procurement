const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const TARGET_NETWORK = 20000000;

const REGIONS = [
  ["US", "North America"],
  ["CA", "North America"],
  ["CN", "China"],
  ["IN", "India"],
  ["JP", "Japan"],
  ["KR", "South Korea"],
  ["DE", "Europe"],
  ["GB", "Europe"],
  ["FR", "Europe"],
  ["IT", "Europe"]
];

/* =========================================================
   BASIC HELPERS
========================================================= */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...headers
    }
  });
}

function cookieValue(req, name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(
    new RegExp("(^|;\\s*)" + name + "=([^;]*)")
  );
  return m ? decodeURIComponent(m[2]) : null;
}

function token() {
  return crypto.randomUUID() + crypto.randomUUID();
}

async function sha256(text) {
  const h = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text)
  );

  return [...new Uint8Array(h)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function passwordHash(password, salt) {
  return sha256(salt + ":" + password);
}

function sessionCookie(t) {
  return `nova_session=${encodeURIComponent(t)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearCookie() {
  return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

/* =========================================================
   DATABASE
========================================================= */

async function tableColumns(db, table) {
  const r = await db
    .prepare(`PRAGMA table_info("${table}")`)
    .all();

  return new Set(
    (r.results || []).map(x => x.name)
  );
}

async function addColumns(db, table, columns) {
  const existing = await tableColumns(db, table);
  const statements = [];

  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) {
      statements.push(
        db.prepare(
          `ALTER TABLE "${table}" ADD COLUMN "${name}" ${type}`
        )
      );
    }
  }

  if (statements.length) {
    await db.batch(statements);
  }
}

async function migrateDatabase(db) {

  await db.batch([

    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE,
        password_hash TEXT,
        salt TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER,
        expires_at INTEGER
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS suppliers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT,
        url TEXT,
        country TEXT,
        region TEXT,
        source TEXT,
        product TEXT,
        evidence INTEGER DEFAULT 0,
        deal_score INTEGER DEFAULT 0,
        price REAL,
        moq REAL,
        lead_time TEXT,
        confidence INTEGER DEFAULT 0,
        verification TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS projects (
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
      CREATE TABLE IF NOT EXISTS rfqs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        project_id INTEGER,
        supplier_id INTEGER,
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
      CREATE TABLE IF NOT EXISTS bids (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        project_id INTEGER,
        supplier_id INTEGER,
        supplier TEXT,
        unit_price REAL,
        currency TEXT DEFAULT 'USD',
        moq REAL,
        lead_time_days REAL,
        shipping REAL,
        notes TEXT,
        status TEXT DEFAULT 'submitted',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS negotiations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        supplier TEXT,
        offer TEXT,
        result TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        project_id INTEGER,
        supplier_id INTEGER,
        bid_id INTEGER,
        quantity REAL,
        unit_price REAL,
        currency TEXT DEFAULT 'USD',
        notes TEXT,
        status TEXT DEFAULT 'draft',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
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
      CREATE TABLE IF NOT EXISTS flash_deals (
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
      CREATE TABLE IF NOT EXISTS procurement_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        product TEXT,
        supplier TEXT,
        outcome TEXT,
        memory TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)

  ]);

  await addColumns(db, "users", {
    email: "TEXT",
    password_hash: "TEXT",
    salt: "TEXT",
    created_at: "TEXT"
  });

  await addColumns(db, "sessions", {
    token: "TEXT",
    user_id: "INTEGER",
    expires_at: "INTEGER"
  });

  await addColumns(db, "suppliers", {
    name: "TEXT",
    url: "TEXT",
    country: "TEXT",
    region: "TEXT",
    source: "TEXT",
    product: "TEXT",
    evidence: "INTEGER DEFAULT 0",
    deal_score: "INTEGER DEFAULT 0",
    price: "REAL",
    moq: "REAL",
    lead_time: "TEXT",
    confidence: "INTEGER DEFAULT 0",
    verification: "TEXT",
    created_at: "TEXT"
  });

  await addColumns(db, "projects", {
    user_id: "INTEGER",
    name: "TEXT",
    product: "TEXT",
    quantity: "REAL",
    destination: "TEXT",
    requirements: "TEXT",
    status: "TEXT DEFAULT 'active'",
    created_at: "TEXT"
  });

  await addColumns(db, "rfqs", {
    user_id: "INTEGER",
    project_id: "INTEGER",
    supplier_id: "INTEGER",
    product: "TEXT",
    quantity: "REAL",
    destination: "TEXT",
    requirements: "TEXT",
    message: "TEXT",
    status: "TEXT DEFAULT 'draft'",
    created_at: "TEXT"
  });

  await addColumns(db, "bids", {
    user_id: "INTEGER",
    project_id: "INTEGER",
    supplier_id: "INTEGER",
    supplier: "TEXT",
    unit_price: "REAL",
    currency: "TEXT",
    moq: "REAL",
    lead_time_days: "REAL",
    shipping: "REAL",
    notes: "TEXT",
    status: "TEXT DEFAULT 'submitted'",
    created_at: "TEXT"
  });

  await addColumns(db, "negotiations", {
    user_id: "INTEGER",
    supplier: "TEXT",
    offer: "TEXT",
    result: "TEXT",
    created_at: "TEXT"
  });

  await addColumns(db, "purchase_orders", {
    user_id: "INTEGER",
    project_id: "INTEGER",
    supplier_id: "INTEGER",
    bid_id: "INTEGER",
    quantity: "REAL",
    unit_price: "REAL",
    currency: "TEXT",
    notes: "TEXT",
    status: "TEXT DEFAULT 'draft'",
    created_at: "TEXT"
  });

  await addColumns(db, "purchases", {
    user_id: "INTEGER",
    product: "TEXT",
    supplier: "TEXT",
    quantity: "REAL",
    unit_price: "REAL",
    shipping: "REAL",
    landed_cost: "REAL",
    supplier_url: "TEXT",
    created_at: "TEXT"
  });

  await addColumns(db, "flash_deals", {
    user_id: "INTEGER",
    company: "TEXT",
    product: "TEXT",
    description: "TEXT",
    country: "TEXT",
    quantity: "REAL",
    price: "REAL",
    currency: "TEXT",
    moq: "REAL",
    expires_at: "TEXT",
    status: "TEXT",
    url: "TEXT",
    created_at: "TEXT"
  });

  await addColumns(db, "procurement_memory", {
    user_id: "INTEGER",
    product: "TEXT",
    supplier: "TEXT",
    outcome: "TEXT",
    memory: "TEXT",
    created_at: "TEXT"
  });
}

async function currentUser(req, db) {

  if (!db) return null;

  const t = cookieValue(
    req,
    "nova_session"
  );

  if (!t) return null;

  return db.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users
      ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
  `)
    .bind(t, Date.now())
    .first();
}

/* =========================================================
   SUPPLIER PARSING
========================================================= */

function parsePrice(text) {

  const patterns = [

    /(?:US\$|USD|\$)\s*([0-9]+(?:\.[0-9]+)?)/i,

    /([0-9]+(?:\.[0-9]+)?)\s*(?:USD|US\$)/i,

    /(?:price|pricing|starting|from)
      \D{0,40}
      (?:US\$|USD|\$)
      \s*
      ([0-9]+(?:\.[0-9]+)?)/ix

  ];

  for (const pattern of patterns) {

    const m = String(text || "")
      .match(pattern);

    if (m) {

      const value = Number(m[1]);

      if (
        value > 0 &&
        value < 100000
      ) {
        return value;
      }
    }
  }

  return null;
}

function parseMOQ(text) {

  const patterns = [

    /(?:MOQ|minimum order quantity|minimum order)
      \D{0,60}
      ([\d,]+)
      \s*(?:pcs?|pieces?|units?)?/ix,

    /(?:minimum quantity|minimum qty)
      \D{0,50}
      ([\d,]+)/ix,

    /([\d,]+)
      \s*(?:pcs?|pieces?)
      \s*(?:MOQ|minimum)/ix

  ];

  for (const pattern of patterns) {

    const m = String(text || "")
      .match(pattern);

    if (m) {

      const value =
        Number(
          m[1].replace(/,/g, "")
        );

      if (
        value > 0 &&
        value < 100000000
      ) {
        return value;
      }
    }
  }

  return null;
}

function parseLead(text) {

  const patterns = [

    /(?:lead time|production time|delivery time|production lead time)
      \D{0,60}
      (\d+(?:\s*-\s*\d+)?)
      \s*(days?|weeks?)/ix,

    /(\d+(?:\s*-\s*\d+)?)
      \s*(days?|weeks?)
      \s*(?:lead time|production|delivery)/ix

  ];

  for (const pattern of patterns) {

    const m =
      String(text || "")
        .match(pattern);

    if (m) {
      return `${m[1]} ${m[2]}`;
    }
  }

  return null;
}

function supplierSignals(text) {

  const s =
    String(text || "")
      .toLowerCase();

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
    (n, word) =>
      n + (s.includes(word) ? 1 : 0),
    0
  );
}

function evidence(text) {

  const s =
    String(text || "")
      .toLowerCase();

  let score = 0;

  for (const [word, value] of [

    ["$", 10],
    ["usd", 10],
    ["moq", 10],
    ["minimum order", 10],
    ["shipping", 5],
    ["lead time", 5],
    ["manufacturer", 5],
    ["factory", 5],
    ["oem", 5],
    ["odm", 5],
    ["certification", 3],
    ["fda", 3],
    ["lfgb", 3],
    ["bpa", 2]

  ]) {

    if (s.includes(word)) {
      score += value;
    }
  }

  return Math.min(50, score);
}

function dealScore(
  signal,
  ev,
  price,
  moq
) {

  return Math.min(
    100,
    Math.max(
      0,
      50 +
      signal * 3 +
      ev +
      (price !== null ? 5 : 0) +
      (moq !== null ? 5 : 0)
    )
  );
}

function confidence(ev) {
  return Math.min(
    100,
    Math.round(ev * 1.6)
  );
}

/* =========================================================
   YEP SEARCH
========================================================= */

async function yepSearch(
  query,
  location,
  env,
  limit = 10
) {

  if (!env.YEP_API_KEY) {
    throw new Error(
      "YEP_API_KEY is missing in Cloudflare."
    );
  }

  const response =
    await fetch(
      "https://platform.yep.com/api/search",
      {
        method: "POST",

        headers: {
          Authorization:
            `Bearer ${env.YEP_API_KEY}`,

          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          query,
          type: "basic",
          limit,
          language: ["en"],
          location
        })
      }
    );

  const text =
    await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Yep returned invalid response. HTTP ${response.status}`
    );
  }

  if (!response.ok) {
    throw new Error(
      data.error ||
      `Yep HTTP ${response.status}`
    );
  }

  return data;
}

/* =========================================================
   SUPPLIER PAGE ENRICHMENT
========================================================= */

function cleanHTML(html) {

  return String(html || "")
    .replace(
      /<script[\s\S]*?<\/script>/gi,
      " "
    )
    .replace(
      /<style[\s\S]*?<\/style>/gi,
      " "
    )
    .replace(
      /<noscript[\s\S]*?<\/noscript>/gi,
      " "
    )
    .replace(
      /<svg[\s\S]*?<\/svg>/gi,
      " "
    )
    .replace(
      /<[^>]+>/g,
      " "
    )
    .replace(
      /&nbsp;/gi,
      " "
    )
    .replace(
      /&amp;/gi,
      "&"
    )
    .replace(
      /&quot;/gi,
      '"'
    )
    .replace(
      /&#39;/gi,
      "'"
    )
    .replace(
      /&#x27;/gi,
      "'"
    )
    .replace(
      /\s+/g,
      " "
    )
    .trim()
    .slice(0, 120000);
}

async function enrichSupplier(
  url,
  fallback
) {

  const result = {
    ...fallback,

    price:
      fallback.price ?? null,

    moq:
      fallback.moq ?? null,

    leadTime:
      fallback.leadTime ?? null,

    evidence:
      Number(fallback.evidence) || 0,

    confidence:
      Number(fallback.confidence) || 0,

    verification:
      fallback.verification ||
      "Not verified",

    verified:
      false,

    sourcePageChecked:
      false
  };

  if (!url) {
    return result;
  }

  try {

    const response =
      await fetch(
        url,
        {
          method: "GET",

          headers: {
            "User-Agent":
              "Mozilla/5.0 (compatible; NOVA Procurement Bot/1.0)",

            "Accept":
              "text/html,application/xhtml+xml,text/html"
          }
        }
      );

    if (!response.ok) {
      return result;
    }

    const html =
      await response.text();

    if (
      !html ||
      html.length < 200
    ) {
      return result;
    }

    const pageText =
      cleanHTML(html);

    const combined =
      `${fallback.title || ""}
       ${fallback.snippet || ""}
       ${pageText}`;

    const pagePrice =
      parsePrice(combined);

    const pageMOQ =
      parseMOQ(combined);

    const pageLead =
      parseLead(combined);

    if (
      result.price === null &&
      pagePrice !== null
    ) {
      result.price = pagePrice;
    }

    if (
      result.moq === null &&
      pageMOQ !== null
    ) {
      result.moq = pageMOQ;
    }

    if (
      !result.leadTime &&
      pageLead
    ) {
      result.leadTime =
        pageLead;
    }

    const signal =
      supplierSignals(combined);

    const ev =
      evidence(combined);

    result.supplierSignal =
      Math.max(
        Number(result.supplierSignal) || 0,
        signal
      );

    result.evidence =
      Math.min(
        50,
        Math.max(
          Number(result.evidence) || 0,
          ev
        )
      );

    result.dealScore =
      dealScore(
        result.supplierSignal,
        result.evidence,
        result.price,
        result.moq
      );

    result.confidence =
      confidence(
        result.evidence
      );

    result.sourcePageChecked =
      true;

    const commercial =
      result.price !== null ||
      result.moq !== null ||
      result.leadTime !== null;

    const supplierIdentity =
      /manufacturer|factory|supplier|wholesale|oem|odm|exporter/i
        .test(combined);

    if (
      commercial &&
      supplierIdentity &&
      result.evidence >= 20
    ) {

      result.verification =
        "Partially Verified";

      result.verified =
        false;
    }

    if (
      result.price !== null &&
      result.moq !== null &&
      result.leadTime !== null &&
      result.evidence >= 30
    ) {

      result.verification =
        "Verified from supplier page";

      result.verified =
        true;
    }

    return result;

  } catch {

    return result;
  }
}

/* =========================================================
   SAVE SUPPLIER
========================================================= */

async function saveSupplier(
  db,
  supplier,
  product
) {

  if (!db || !supplier.url) {
    return;
  }

  try {

    const existing =
      await db.prepare(
        "SELECT id FROM suppliers WHERE url=? LIMIT 1"
      )
      .bind(supplier.url)
      .first();

    if (existing) {

      await db.prepare(`
        UPDATE suppliers
        SET
          name=?,
          country=?,
          region=?,
          source=?,
          product=?,
          evidence=?,
          deal_score=?,
          price=?,
          moq=?,
          lead_time=?,
          confidence=?,
          verification=?
        WHERE id=?
      `)
        .bind(
          supplier.title ||
            "Supplier",

          supplier.country ||
            "",

          supplier.region ||
            "",

          "Yep + Supplier Page",

          product ||
            "",

          Number(
            supplier.evidence
          ) || 0,

          Number(
            supplier.dealScore
          ) || 0,

          supplier.price,

          supplier.moq,

          supplier.leadTime ||
            null,

          Number(
            supplier.confidence
          ) || 0,

          supplier.verification ||
            "Not verified",

          existing.id
        )
        .run();

    } else {

      await db.prepare(`
        INSERT INTO suppliers
        (
          name,
          url,
          country,
          region,
          source,
          product,
          evidence,
          deal_score,
          price,
          moq,
          lead_time,
          confidence,
          verification
        )
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      `)
        .bind(

          supplier.title ||
            "Supplier",

          supplier.url,

          supplier.country ||
            "",

          supplier.region ||
            "",

          "Yep + Supplier Page",

          product ||
            "",

          Number(
            supplier.evidence
          ) || 0,

          Number(
            supplier.dealScore
          ) || 0,

          supplier.price,

          supplier.moq,

          supplier.leadTime ||
            null,

          Number(
            supplier.confidence
          ) || 0,

          supplier.verification ||
            "Not verified"

        )
        .run();
    }

  } catch {
    /* Supplier failure must never break the search */
  }
}

/* =========================================================
   SEARCH + ENRICHMENT
========================================================= */

async function searchSuppliers(
  requestText,
  env,
  db
) {

  const clean =
    String(requestText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 700);

  if (!clean) {
    throw new Error(
      "Please enter a procurement request."
    );
  }

  const base =
    `${clean} manufacturer factory supplier wholesale OEM ODM exporter bulk custom MOQ price quotation production lead time shipping`;

  const searches =
    REGIONS.map(
      ([code]) =>
        yepSearch(
          base,
          code,
          env,
          10
        )
    );

  const settled =
    await Promise.allSettled(
      searches
    );

  const results = [];

  for (
    let i = 0;
    i < settled.length;
    i++
  ) {

    const item =
      settled[i];

    if (
      item.status !==
      "fulfilled"
    ) {
      continue;
    }

    const raw =
      Array.isArray(
        item.value.results
      )
        ? item.value.results
        : [];

    for (const r of raw) {

      const title =
        r.title ||
        r.name ||
        "Supplier";

      const url =
        r.url ||
        r.link ||
        "";

      if (!url) {
        continue;
      }

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

      const signal =
        supplierSignals(
          combined
        );

      const ev =
        evidence(
          combined
        );

      const score =
        dealScore(
          signal,
          ev,
          price,
          moq
        );

      results.push({

        title,

        url,

        snippet,

        price,

        moq,

        leadTime:
          lead,

        shipping:
          null,

        supplierSignal:
          signal,

        evidence:
          ev,

        confidence:
          confidence(ev),

        dealScore:
          score,

        region:
          REGIONS[i][1],

        country:
          REGIONS[i][0],

        verified:
          false,

        verification:
          "Not verified"

      });
    }
  }

  const unique = [
    ...new Map(
      results.map(
        r => [r.url, r]
      )
    ).values()
  ]
    .sort(
      (a, b) =>
        Number(b.dealScore || 0) -
        Number(a.dealScore || 0)
    )
    .slice(0, 40);

  /*
    فحص صفحات الموردين الحقيقية.
    30 صفحة كحد أقصى في كل عملية بحث.
  */

  const checked =
    unique.slice(0, 30);

  const enriched =
    await Promise.all(
      checked.map(
        supplier =>
          enrichSupplier(
            supplier.url,
            supplier
          )
      )
    );

  const remaining =
    unique.slice(30);

  const finalResults = [
    ...enriched,
    ...remaining
  ];

  finalResults.sort(
    (a, b) =>
      Number(b.dealScore || 0) -
      Number(a.dealScore || 0)
  );

  for (
    const supplier of finalResults
  ) {

    await saveSupplier(
      db,
      supplier,
      clean
    );
  }

  return {

    ok: true,

    results:
      finalResults,

    total:
      finalResults.length,

    networkTarget:
      TARGET_NETWORK,

    pageEnrichment:
      true,

    checkedSupplierPages:
      enriched.length

  };
}

/* =========================================================
   AI
========================================================= */

async function ai(
  env,
  system,
  user,
  max_tokens = 900
) {

  if (!env.AI) {
    throw new Error(
      "Workers AI binding AI is missing."
    );
  }

  const response =
    await env.AI.run(
      MODEL,
      {
        messages: [
          {
            role: "system",
            content: system
          },
          {
            role: "user",
            content: user
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

/* =========================================================
   NEGOTIATION
========================================================= */

async function negotiate(
  body,
  env
) {

  return ai(

    env,

    `You are NOVA, an advanced procurement negotiation agent.
Never invent supplier facts.
Clearly separate verified facts from assumptions.
Give practical commercial negotiation advice.`,

    `
Supplier:
${body.supplier || ""}

Target Price:
${body.target || ""}

Quantity:
${body.quantity || ""}

Current Price:
${body.current || ""}

Negotiation Goal:
${body.goal || ""}

Supplier Offer:
${body.offer || ""}

Supplier Reply:
${body.reply || ""}

Supplier Message:
${body.message || ""}

Return:

1. Offer analysis
2. Target price/range
3. Counteroffer
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Risk points
8. Ready-to-send negotiation message
`
  );
}

/* =========================================================
   LANDED COST
========================================================= */

function landed(body) {

  const quantity =
    Math.max(
      0,
      Number(
        body.quantity ??
        body.qty
      ) || 0
    );

  const unitPrice =
    Math.max(
      0,
      Number(
        body.unitPrice ??
        body.unit_price
      ) || 0
    );

  const shipping =
    Math.max(
      0,
      Number(body.shipping) || 0
    );

  const insurance =
    Math.max(
      0,
      Number(body.insurance) || 0
    );

  const dutyPercent =
    Math.max(
      0,
      Number(
        body.dutyPercent ??
        body.duty_percent
      ) || 0
    );

  const taxPercent =
    Math.max(
      0,
      Number(
        body.taxPercent ??
        body.tax_percent
      ) || 0
    );

  const localDelivery =
    Math.max(
      0,
      Number(
        body.localDelivery ??
        body.local_delivery
      ) || 0
    );

  const goods =
    quantity * unitPrice;

  const duty =
    goods *
    dutyPercent /
    100;

  const taxable =
    goods +
    shipping +
    insurance +
    duty;

  const tax =
    taxable *
    taxPercent /
    100;

  const total =
    goods +
    shipping +
    insurance +
    duty +
    tax +
    localDelivery;

  return {

    goods,

    shipping,

    insurance,

    duty,

    tax,

    localDelivery,

    total,

    unitLanded:
      quantity
        ? total / quantity
        : 0,

    status:
      "Estimated — verify freight, customs and taxes before payment"

  };
}

/* =========================================================
   SEO
========================================================= */

const SEO = {

  "/ai-procurement": [
    "AI Procurement | NOVA",
    "AI purchasing agent for supplier discovery, comparison, RFQs and negotiation."
  ],

  "/ai-sourcing": [
    "AI Sourcing | NOVA",
    "Search global manufacturers and suppliers with evidence-first deal intelligence."
  ],

  "/supplier-finder": [
    "Supplier Finder | NOVA",
    "Find manufacturers and suppliers across global markets."
  ],

  "/supplier-comparison": [
    "Supplier Comparison | NOVA",
    "Compare supplier evidence, price, MOQ, lead time, risk and deal score."
  ],

  "/china-suppliers": [
    "China Suppliers | NOVA",
    "Discover Chinese manufacturers and wholesale suppliers."
  ],

  "/wholesale-suppliers": [
    "Wholesale Suppliers | NOVA",
    "Find global wholesale suppliers and manufacturers."
  ],

  "/ai-purchasing-agent": [
    "AI Purchasing Agent | NOVA",
    "NOVA searches, analyzes, creates RFQs and negotiates procurement offers."
  ],

  "/flash-deals": [
    "Factory Flash Deals | NOVA",
    "Discover factory commercial deals."
  ]

};

function htmlPage(
  title,
  description
) {

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description" content="${description}">
</head>
<body style="font-family:Arial;max-width:900px;margin:40px auto;padding:20px">
<h1>${title}</h1>
<p>${description}</p>
<p><a href="/">Open NOVA</a></p>
</body>
</html>`;
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(
    request,
    env
  ) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    const method =
      request.method;

    try {

      /* DATABASE MIGRATION */

      if (env.DB) {
        await migrateDatabase(
          env.DB
        );
      }

      /* HEALTH */

      if (
        path === "/api/health"
      ) {

        return json({

          ok: true,

          nova:
            "online",

          database:
            !!env.DB,

          ai:
            !!env.AI,

          yep:
            !!env.YEP_API_KEY,

          timestamp:
            new Date()
              .toISOString()

        });
      }

      /* ROBOTS */

      if (
        path === "/robots.txt"
      ) {

        return new Response(
          `User-agent: *
Allow: /
Sitemap: ${url.origin}/sitemap.xml`,
          {
            headers: {
              "Content-Type":
                "text/plain"
            }
          }
        );
      }

      /* SITEMAP */

      if (
        path === "/sitemap.xml"
      ) {

        const paths = [
          "/",
          ...Object.keys(SEO)
        ];

        return new Response(

          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths.map(
  x =>
    `<url><loc>${url.origin}${x}</loc></url>`
).join("")}
</urlset>`,

          {
            headers: {
              "Content-Type":
                "application/xml"
            }
          }

        );
      }

      /* SEO PAGES */

      if (SEO[path]) {

        const [
          title,
          description
        ] = SEO[path];

        return new Response(

          htmlPage(
            title,
            description
          ),

          {
            headers: {
              "Content-Type":
                "text/html;charset=UTF-8"
            }
          }

        );
      }

      /* =====================================================
         SEARCH
      ===================================================== */

      if (
        path === "/api/search" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        return json(
          await searchSuppliers(
            body.request ||
            body.query ||
            body.product,
            env,
            env.DB
          )
        );
      }

      /* =====================================================
         NETWORK
      ===================================================== */

      if (
        path === "/api/network" &&
        method === "GET"
      ) {

        const row =
          await env.DB
            .prepare(
              "SELECT COUNT(*) AS count FROM suppliers"
            )
            .first();

        return json({

          ok: true,

          actualRecords:
            Number(
              row?.count || 0
            ),

          targetRecords:
            TARGET_NETWORK,

          evidenceRecords:
            Number(
              row?.count || 0
            ),

          coverage:
            [
              ...new Set(
                REGIONS.map(
                  x => x[1]
                )
              )
            ],

          status:
            "Live supplier discovery through configured search sources."

        });
      }

      /* =====================================================
         SUPPLIERS
      ===================================================== */

      if (
        path === "/api/suppliers" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM suppliers
              ORDER BY deal_score DESC, id DESC
              LIMIT 200
            `)
            .all();

        return json({
          suppliers:
            rows.results || []
        });
      }

      /* =====================================================
         PROJECTS CREATE
      ===================================================== */

      if (
        path === "/api/projects" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO projects
            (
              user_id,
              name,
              product,
              quantity,
              destination,
              requirements,
              status
            )
            VALUES(?,?,?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            body.name || "",

            body.product || "",

            Number(
              body.quantity
            ) || 0,

            body.destination ||
              "",

            body.requirements ||
              "",

            "active"

          )
          .run();

        return json({

          success: true,

          projectId:
            r.meta.last_row_id

        });
      }

      /* PROJECTS LOAD */

      if (
        path === "/api/projects" &&
        method === "GET"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        const rows = user

          ? await env.DB
              .prepare(`
                SELECT *
                FROM projects
                WHERE user_id=?
                   OR user_id IS NULL
                ORDER BY id DESC
              `)
              .bind(user.id)
              .all()

          : await env.DB
              .prepare(`
                SELECT *
                FROM projects
                ORDER BY id DESC
              `)
              .all();

        return json({
          projects:
            rows.results || []
        });
      }

      /* =====================================================
         RFQ CREATE
      ===================================================== */

      if (
        path === "/api/rfq" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const message =
          await ai(

            env,

            "You write concise professional procurement RFQs. Never invent specifications.",

            `
Product:
${body.product || ""}

Quantity:
${body.quantity || ""}

Destination:
${body.destination || ""}

Requirements:
${body.requirements || "None"}

Create a professional RFQ requesting:

- Unit price
- MOQ
- Sample cost
- Production lead time
- Incoterm
- Packaging
- Shipping to destination
- Payment terms
- Certifications
- Quotation validity
`

          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO rfqs
            (
              user_id,
              project_id,
              supplier_id,
              product,
              quantity,
              destination,
              requirements,
              message,
              status
            )
            VALUES(?,?,?,?,?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            body.project_id ??
              body.projectId ??
              null,

            body.supplier_id ??
              body.supplierId ??
              null,

            body.product || "",

            Number(
              body.quantity
            ) || 0,

            body.destination ||
              "",

            body.requirements ||
              "",

            message,

            "draft"

          )
          .run();

        return json({

          success: true,

          rfqId:
            r.meta.last_row_id,

          message

        });
      }

      /* RFQ LOAD */

      if (
        path === "/api/rfq" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM rfqs
              ORDER BY id DESC
              LIMIT 100
            `)
            .all();

        return json({
          rfqs:
            rows.results || []
        });
      }

      /* =====================================================
         BIDS SUBMIT
      ===================================================== */

      if (
        path === "/api/bids" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO bids
            (
              user_id,
              project_id,
              supplier_id,
              supplier,
              unit_price,
              currency,
              moq,
              lead_time_days,
              shipping,
              notes,
              status
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            body.project_id ??
              body.projectId ??
              null,

            body.supplier_id ??
              body.supplierId ??
              null,

            body.supplier ||
              body.supplierName ||
              "",

            Number(
              body.unit_price ??
              body.unitPrice
            ) || 0,

            body.currency ||
              "USD",

            Number(
              body.moq
            ) || 0,

            Number(
              body.lead_time_days ??
              body.leadTimeDays
            ) || 0,

            Number(
              body.shipping
            ) || 0,

            body.notes || "",

            "submitted"

          )
          .run();

        return json({

          success: true,

          bidId:
            r.meta.last_row_id

        });
      }

      /* BIDS LOAD */

      if (
        path === "/api/bids" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM bids
              ORDER BY id DESC
              LIMIT 200
            `)
            .all();

        return json({
          bids:
            rows.results || []
        });
      }

      /* =====================================================
         BID COMPARE GET
      ===================================================== */

      if (
        path === "/api/bids/compare" &&
        method === "GET"
      ) {

        const projectId =
          url.searchParams.get(
            "project_id"
          ) ||
          url.searchParams.get(
            "projectId"
          );

        const rows =
          projectId

            ? await env.DB
                .prepare(`
                  SELECT *
                  FROM bids
                  WHERE project_id=?
                  ORDER BY unit_price ASC
                `)
                .bind(projectId)
                .all()

            : await env.DB
                .prepare(`
                  SELECT *
                  FROM bids
                  ORDER BY unit_price ASC
                  LIMIT 100
                `)
                .all();

        return json({
          bids:
            rows.results || []
        });
      }

      /* BID COMPARE POST */

      if (
        path === "/api/bids/compare" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const projectId =
          body.project_id ??
          body.projectId ??
          null;

        const rows =
          projectId

            ? await env.DB
                .prepare(`
                  SELECT *
                  FROM bids
                  WHERE project_id=?
                  ORDER BY unit_price ASC
                `)
                .bind(projectId)
                .all()

            : await env.DB
                .prepare(`
                  SELECT *
                  FROM bids
                  ORDER BY unit_price ASC
                  LIMIT 100
                `)
                .all();

        return json({
          bids:
            rows.results || []
        });
      }

      /* =====================================================
         AWARD BID
      ===================================================== */

      if (
        path === "/api/bids/award" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const bidId =
          body.bid_id ??
          body.bidId;

        if (!bidId) {
          return json({
            error:
              "Bid ID is required."
          }, 400);
        }

        await env.DB
          .prepare(`
            UPDATE bids
            SET status='awarded'
            WHERE id=?
          `)
          .bind(bidId)
          .run();

        return json({

          success: true,

          bidId

        });
      }

      /* =====================================================
         LANDED COST
      ===================================================== */

      if (
        path === "/api/landed-cost" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        return json(
          landed(body)
        );
      }

      /* =====================================================
         NEGOTIATION
      ===================================================== */

      if (
        path === "/api/negotiate" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        if (!body.supplier) {

          return json({
            error:
              "Supplier is required."
          }, 400);

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

        await env.DB.prepare(`
          INSERT INTO negotiations
          (
            user_id,
            supplier,
            offer,
            result
          )
          VALUES(?,?,?,?)
        `)
          .bind(

            user?.id || null,

            body.supplier ||
              "",

            body.offer ||
              body.current ||
              body.target ||
              "",

            result

          )
          .run();

        return json({

          success: true,

          result

        });
      }

      /* NEGOTIATION HISTORY */

      if (
        path === "/api/negotiations" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM negotiations
              ORDER BY id DESC
              LIMIT 100
            `)
            .all();

        return json({
          negotiations:
            rows.results || []
        });
      }

      /* =====================================================
         PURCHASE ORDER CREATE
      ===================================================== */

      if (
        path === "/api/purchase-orders" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        let projectId =
          body.project_id ??
          body.projectId ??
          null;

        let supplierId =
          body.supplier_id ??
          body.supplierId ??
          null;

        let bidId =
          body.bid_id ??
          body.bidId ??
          null;

        let quantity =
          Number(
            body.quantity
          ) || 0;

        let unitPrice =
          Number(
            body.unit_price ??
            body.unitPrice
          ) || 0;

        let currency =
          body.currency ||
          "USD";

        let notes =
          body.notes ||
          "";

        if (bidId) {

          const bid =
            await env.DB
              .prepare(
                "SELECT * FROM bids WHERE id=?"
              )
              .bind(bidId)
              .first();

          if (bid) {

            if (
              projectId === null
            ) {
              projectId =
                bid.project_id;
            }

            if (
              supplierId === null
            ) {
              supplierId =
                bid.supplier_id;
            }

            if (!unitPrice) {
              unitPrice =
                Number(
                  bid.unit_price
                ) || 0;
            }

            if (!quantity) {
              quantity = 1;
            }

            currency =
              body.currency ||
              bid.currency ||
              "USD";
          }
        }

        const r =
          await env.DB.prepare(`
            INSERT INTO purchase_orders
            (
              user_id,
              project_id,
              supplier_id,
              bid_id,
              quantity,
              unit_price,
              currency,
              notes,
              status
            )
            VALUES(?,?,?,?,?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            projectId,

            supplierId,

            bidId,

            quantity,

            unitPrice,

            currency,

            notes,

            "draft"

          )
          .run();

        return json({

          success: true,

          purchaseOrderId:
            r.meta.last_row_id,

          status:
            "draft"

        });
      }

      /* PURCHASE ORDERS LOAD */

      if (
        path === "/api/purchase-orders" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM purchase_orders
              ORDER BY id DESC
              LIMIT 200
            `)
            .all();

        return json({
          purchaseOrders:
            rows.results || []
        });
      }

      /* =====================================================
         FLASH DEALS LOAD
      ===================================================== */

      if (
        path === "/api/deals" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM flash_deals
              WHERE status='submitted'
                AND (
                  expires_at IS NULL
                  OR expires_at=''
                  OR expires_at > datetime('now')
                )
              ORDER BY id DESC
              LIMIT 100
            `)
            .all();

        return json({
          deals:
            rows.results || []
        });
      }

      /* FLASH DEAL CREATE */

      if (
        path === "/api/deals" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
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
              status,
              url
            )
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            body.company ||
              body.supplier ||
              "",

            body.product ||
              "",

            body.description ||
              "",

            body.country ||
              "",

            Number(
              body.quantity
            ) || 0,

            Number(
              body.price
            ) || 0,

            body.currency ||
              "USD",

            Number(
              body.moq
            ) || 0,

            body.expiresAt ||
              body.expires_at ||
              null,

            "submitted",

            body.url ||
              ""

          )
          .run();

        return json({

          success: true,

          dealId:
            r.meta.last_row_id,

          status:
            "submitted"

        });
      }

      /* =====================================================
         MEMORY SAVE
      ===================================================== */

      if (
        path === "/api/memory" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO procurement_memory
            (
              user_id,
              product,
              supplier,
              outcome,
              memory
            )
            VALUES(?,?,?,?,?)
          `)
          .bind(

            user?.id || null,

            body.product ||
              "",

            body.supplier ||
              "",

            body.outcome ||
              "",

            body.memory ||
              ""

          )
          .run();

        return json({

          success: true,

          memoryId:
            r.meta.last_row_id

        });
      }

      /* MEMORY LOAD */

      if (
        path === "/api/memory" &&
        method === "GET"
      ) {

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM procurement_memory
              ORDER BY id DESC
              LIMIT 200
            `)
            .all();

        return json({
          memory:
            rows.results || []
        });
      }

      /* =====================================================
         PURCHASE HISTORY CREATE
      ===================================================== */

      if (
        path === "/api/purchases" &&
        method === "POST"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {

          return json({
            error:
              "Please login first."
          }, 401);

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

            body.product ||
              "",

            body.supplier ||
              "",

            Number(
              body.quantity
            ) || 0,

            Number(
              body.unitPrice ??
              body.unit_price
            ) || 0,

            Number(
              body.shipping
            ) || 0,

            Number(
              body.landedCost ??
              body.landed_cost
            ) || 0,

            body.supplierUrl ||
              body.supplier_url ||
              ""

          )
          .run();

        return json({
          success: true
        });
      }

      /* PURCHASE HISTORY LOAD */

      if (
        path === "/api/purchases" &&
        method === "GET"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {

          return json({
            error:
              "Please login first."
          }, 401);

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

      /* =====================================================
         SIGN UP
      ===================================================== */

      if (
        path === "/api/signup" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const email =
          String(
            body.email || ""
          )
            .trim()
            .toLowerCase();

        const password =
          String(
            body.password || ""
          );

        if (
          !email ||
          password.length < 6
        ) {

          return json({
            error:
              "Valid email and password of at least 6 characters are required."
          }, 400);

        }

        const exists =
          await env.DB
            .prepare(
              "SELECT id FROM users WHERE email=?"
            )
            .bind(email)
            .first();

        if (exists) {

          return json({
            error:
              "Account already exists."
          }, 409);

        }

        const salt =
          token();

        const hash =
          await passwordHash(
            password,
            salt
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO users
            (
              email,
              password_hash,
              salt
            )
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
          (
            token,
            user_id,
            expires_at
          )
          VALUES(?,?,?)
        `)
          .bind(
            session,
            r.meta.last_row_id,
            Date.now() +
              604800000
          )
          .run();

        return json(

          {
            success: true,
            email
          },

          200,

          {
            "Set-Cookie":
              sessionCookie(
                session
              )
          }

        );
      }

      /* =====================================================
         LOGIN
      ===================================================== */

      if (
        path === "/api/login" &&
        method === "POST"
      ) {

        const body =
          await request.json();

        const email =
          String(
            body.email || ""
          )
            .trim()
            .toLowerCase();

        const password =
          String(
            body.password || ""
          );

        const user =
          await env.DB
            .prepare(`
              SELECT *
              FROM users
              WHERE email=?
            `)
            .bind(email)
            .first();

        if (
          !user ||
          !user.salt ||
          !user.password_hash ||
          await passwordHash(
            password,
            user.salt
          ) !==
          user.password_hash
        ) {

          return json({
            error:
              "Invalid email or password."
          }, 401);

        }

        const session =
          token();

        await env.DB.prepare(`
          INSERT INTO sessions
          (
            token,
            user_id,
            expires_at
          )
          VALUES(?,?,?)
        `)
          .bind(

            session,

            user.id,

            Date.now() +
              604800000

          )
          .run();

        return json(

          {
            success: true,
            email
          },

          200,

          {
            "Set-Cookie":
              sessionCookie(
                session
              )
          }

        );
      }

      /* =====================================================
         LOGOUT
      ===================================================== */

      if (
        path === "/api/logout"
      ) {

        const session =
          cookieValue(
            request,
            "nova_session"
          );

        if (session) {

          await env.DB
            .prepare(
              "DELETE FROM sessions WHERE token=?"
            )
            .bind(session)
            .run();

        }

        return json(

          {
            success: true
          },

          200,

          {
            "Set-Cookie":
              clearCookie()
          }

        );
      }

      /* =====================================================
         ACCOUNT
      ===================================================== */

      if (
        path === "/api/me"
      ) {

        const user =
          await currentUser(
            request,
            env.DB
          );

        return json({

          loggedIn:
            !!user,

          user:
            user || null

        });
      }

      /* =====================================================
         STATIC FRONTEND
      ===================================================== */

      if (env.ASSETS) {

        return env.ASSETS.fetch(
          request
        );

      }

      return new Response(
        "NOVA is online.",
        {
          headers: {
            "Content-Type":
              "text/plain;charset=UTF-8"
          }
        }
      );

    } catch (error) {

      return json(

        {
          ok: false,

          error:
            error?.message ||
            "Server error."
        },

        500

      );
    }
  }
};
