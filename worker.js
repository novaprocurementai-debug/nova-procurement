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
  const m = c.match(new RegExp("(^|;\\s*)" + name + "=([^;]*)"));
  return m ? decodeURIComponent(m[2]) : null;
}

function token() {
  return crypto.randomUUID() + crypto.randomUUID();
}

async function sha256(t) {
  const h = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(t)
  );
  return [...new Uint8Array(h)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function passwordHash(p, s) {
  return sha256(s + ":" + p);
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
  const tables = [
    `CREATE TABLE IF NOT EXISTS users(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS sessions(
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    )`,

    `CREATE TABLE IF NOT EXISTS suppliers(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      url TEXT UNIQUE,
      country TEXT,
      region TEXT,
      source TEXT,
      product TEXT,
      price REAL,
      currency TEXT,
      moq REAL,
      lead_time TEXT,
      shipping TEXT,
      incoterm TEXT,
      certifications TEXT,
      oem_odm TEXT,
      evidence INTEGER DEFAULT 0,
      confidence INTEGER DEFAULT 0,
      deal_score INTEGER DEFAULT 0,
      verified INTEGER DEFAULT 0,
      verification TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS projects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      product TEXT,
      quantity REAL,
      destination TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS rfqs(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      product TEXT,
      quantity REAL,
      destination TEXT,
      requirements TEXT,
      message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS bids(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      rfq_id INTEGER,
      supplier TEXT,
      supplier_url TEXT,
      unit_price REAL,
      currency TEXT,
      moq REAL,
      lead_time TEXT,
      shipping REAL,
      incoterm TEXT,
      payment_terms TEXT,
      notes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS negotiations(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      supplier TEXT,
      offer TEXT,
      result TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS purchase_orders(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      bid_id INTEGER,
      supplier TEXT,
      product TEXT,
      quantity REAL,
      unit_price REAL,
      total REAL,
      currency TEXT DEFAULT 'USD',
      status TEXT DEFAULT 'draft',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`,

    `CREATE TABLE IF NOT EXISTS purchases(
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
    )`,

    `CREATE TABLE IF NOT EXISTS flash_deals(
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
    )`,

    `CREATE TABLE IF NOT EXISTS procurement_memory(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      supplier TEXT,
      product TEXT,
      note TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`
  ];

  for (const sql of tables) {
    try {
      await db.prepare(sql).run();
    } catch {}
  }

  /*
    Migration for older NOVA databases.
    Adds columns without destroying existing data.
  */

  const migrations = {
    suppliers: [
      ["price", "REAL"],
      ["currency", "TEXT"],
      ["moq", "REAL"],
      ["lead_time", "TEXT"],
      ["shipping", "TEXT"],
      ["incoterm", "TEXT"],
      ["certifications", "TEXT"],
      ["oem_odm", "TEXT"],
      ["confidence", "INTEGER DEFAULT 0"],
      ["verified", "INTEGER DEFAULT 0"],
      ["verification", "TEXT"]
    ],
    flash_deals: [
      ["expires_at", "TEXT"]
    ],
    bids: [
      ["supplier_url", "TEXT"],
      ["unit_price", "REAL"],
      ["currency", "TEXT"],
      ["moq", "REAL"],
      ["lead_time", "TEXT"],
      ["shipping", "REAL"],
      ["incoterm", "TEXT"],
      ["payment_terms", "TEXT"],
      ["notes", "TEXT"]
    ]
  };

  for (const [table, cols] of Object.entries(migrations)) {
    let existing = new Set();

    try {
      const info = await db.prepare(`PRAGMA table_info(${table})`).all();
      existing = new Set((info.results || []).map(x => x.name));
    } catch {}

    for (const [name, type] of cols) {
      if (!existing.has(name)) {
        try {
          await db
            .prepare(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)
            .run();
        } catch {}
      }
    }
  }
}

async function currentUser(req, db) {
  if (!db) return null;

  const t = cookieValue(req, "nova_session");
  if (!t) return null;

  return db.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
    AND sessions.expires_at > ?
  `).bind(t, Date.now()).first();
}

/* =========================
   DATA EXTRACTION
========================= */

function cleanText(t) {
  return String(t || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30000);
}

function parsePrice(t) {
  const s = cleanText(t);

  const patterns = [
    /(?:USD|US\$|\$)\s*([\d,]+(?:\.\d+)?)/i,
    /([\d,]+(?:\.\d+)?)\s*(?:USD|US\$)/i,
    /price\s*(?:from|starting\s*from|:)?\s*(?:USD|US\$|\$)?\s*([\d,]+(?:\.\d+)?)/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function parseMOQ(t) {
  const s = cleanText(t);

  const patterns = [
    /MOQ\s*[:\-]?\s*([\d,]+)/i,
    /minimum\s+order\s+(?:quantity|qty)\s*[:\-]?\s*([\d,]+)/i,
    /minimum\s+order\s*[:\-]?\s*([\d,]+)/i,
    /min(?:imum)?\s+order\s*[:\-]?\s*([\d,]+)/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) {
      const n = Number(m[1].replace(/,/g, ""));
      if (Number.isFinite(n)) return n;
    }
  }

  return null;
}

function parseLead(t) {
  const s = cleanText(t);

  const patterns = [
    /lead\s*time\s*[:\-]?\s*(\d+(?:\s*-\s*\d+)?\s*(?:days?|weeks?|months?))/i,
    /production\s*time\s*[:\-]?\s*(\d+(?:\s*-\s*\d+)?\s*(?:days?|weeks?|months?))/i,
    /(\d+(?:\s*-\s*\d+)?\s*(?:days?|weeks?|months?))\s*(?:production|lead)/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) return m[1];
  }

  return null;
}

function parseIncoterm(t) {
  const s = cleanText(t).toUpperCase();

  const terms = [
    "EXW",
    "FOB",
    "CIF",
    "CFR",
    "DDP",
    "DAP",
    "FCA"
  ];

  for (const x of terms) {
    if (new RegExp("\\b" + x + "\\b", "i").test(s)) {
      return x;
    }
  }

  return null;
}

function parseShipping(t) {
  const s = cleanText(t);

  const patterns = [
    /shipping\s*(?:cost|fee|price)?\s*[:\-]?\s*(?:USD|US\$|\$)\s*([\d,]+(?:\.\d+)?)/i,
    /freight\s*[:\-]?\s*(?:USD|US\$|\$)\s*([\d,]+(?:\.\d+)?)/i
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m) return Number(m[1].replace(/,/g, ""));
  }

  return null;
}

function parseCertifications(t) {
  const s = cleanText(t).toUpperCase();

  const known = [
    "ISO 9001",
    "ISO9001",
    "CE",
    "FDA",
    "BSCI",
    "LFGB",
    "ROHS",
    "REACH",
    "HACCP",
    "GMP",
    "UL"
  ];

  const found = known.filter(x => s.includes(x));

  return found.length ? found.join(", ") : null;
}

function parseOEMODM(t) {
  const s = cleanText(t).toLowerCase();

  const found = [];

  if (s.includes("oem")) found.push("OEM");
  if (s.includes("odm")) found.push("ODM");
  if (s.includes("custom")) found.push("Custom");

  return found.length ? found.join(", ") : null;
}

function supplierSignals(t) {
  const s = cleanText(t).toLowerCase();

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
    (n, w) => n + (s.includes(w) ? 1 : 0),
    0
  );
}

function evidence(t) {
  const s = cleanText(t).toLowerCase();

  let n = 0;

  const signals = [
    ["$", 8],
    ["moq", 10],
    ["minimum order", 10],
    ["shipping", 5],
    ["lead time", 7],
    ["manufacturer", 5],
    ["factory", 5],
    ["oem", 5],
    ["odm", 5],
    ["iso", 3],
    ["certification", 3]
  ];

  for (const [word, value] of signals) {
    if (s.includes(word)) n += value;
  }

  return Math.min(70, n);
}

function dealScore(sig, ev, price, moq) {
  return Math.min(
    100,
    Math.max(
      0,
      45 +
      sig * 3 +
      ev +
      (price !== null ? 5 : 0) +
      (moq !== null ? 5 : 0)
    )
  );
}

function confidence(ev) {
  return Math.min(100, Math.round(ev * 1.4));
}

/* =========================
   YEP SEARCH
========================= */

async function yepSearch(query, location, env, limit = 10) {
  if (!env.YEP_API_KEY) {
    throw new Error("YEP_API_KEY is missing in Cloudflare.");
  }

  const r = await fetch(
    "https://platform.yep.com/api/search",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.YEP_API_KEY}`,
        "Content-Type": "application/json"
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

  const txt = await r.text();

  let d;

  try {
    d = JSON.parse(txt);
  } catch {
    throw new Error(
      `Yep returned invalid response. HTTP ${r.status}`
    );
  }

  if (!r.ok) {
    throw new Error(
      d.error || `Yep HTTP ${r.status}`
    );
  }

  return d;
}

/* =========================
   SUPPLIER PAGE ENRICHMENT
========================= */

async function enrichSupplier(url, fallback) {
  if (!url) return fallback;

  try {
    const controller = new AbortController();

    const timer = setTimeout(
      () => controller.abort(),
      5000
    );

    const r = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; NOVA Procurement Bot/1.0)",
        "Accept":
          "text/html,application/xhtml+xml"
      }
    });

    clearTimeout(timer);

    if (!r.ok) return fallback;

    const html = await r.text();

    if (!html || html.length < 100) {
      return fallback;
    }

    const text = cleanText(
      html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&amp;/gi, "&")
    );

    const price =
      parsePrice(text) ?? fallback.price;

    const moq =
      parseMOQ(text) ?? fallback.moq;

    const leadTime =
      parseLead(text) ?? fallback.leadTime;

    const shipping =
      parseShipping(text) ?? fallback.shipping;

    const incoterm =
      parseIncoterm(text) ?? fallback.incoterm;

    const certifications =
      parseCertifications(text) ??
      fallback.certifications;

    const oem_odm =
      parseOEMODM(text) ??
      fallback.oem_odm;

    const ev = Math.max(
      fallback.evidence || 0,
      evidence(text)
    );

    const sig = Math.max(
      fallback.supplierSignal || 0,
      supplierSignals(text)
    );

    const score = dealScore(
      sig,
      ev,
      price,
      moq
    );

    const conf = confidence(ev);

    const verified =
      price !== null ||
      moq !== null ||
      leadTime !== null;

    return {
      ...fallback,
      price,
      moq,
      leadTime,
      shipping,
      incoterm,
      certifications,
      oem_odm,
      evidence: ev,
      confidence: conf,
      dealScore: score,
      verified,
      verification:
        verified
          ? "Supplier page evidence"
          : "Not verified"
    };

  } catch {
    return fallback;
  }
}

/* =========================
   SUPPLIER SEARCH
========================= */

async function searchSuppliers(
  requestText,
  env,
  db
) {
  const clean = String(requestText || "")
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

  const picks = REGIONS.map(
    ([code]) =>
      yepSearch(base, code, env, 10)
  );

  const settled =
    await Promise.allSettled(picks);

  let results = [];

  for (let i = 0; i < settled.length; i++) {
    const x = settled[i];

    if (x.status !== "fulfilled") continue;

    const raw =
      Array.isArray(x.value.results)
        ? x.value.results
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

      if (!url) continue;

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

      const shipping =
        parseShipping(combined);

      const incoterm =
        parseIncoterm(combined);

      const certifications =
        parseCertifications(combined);

      const oem_odm =
        parseOEMODM(combined);

      const sig =
        supplierSignals(combined);

      const ev =
        evidence(combined);

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
        currency: price !== null ? "USD" : null,
        moq,
        leadTime: lead,
        shipping,
        incoterm,
        certifications,
        oem_odm,
        supplierSignal: sig,
        evidence: ev,
        confidence: conf,
        dealScore: score,
        region: REGIONS[i][1],
        country: REGIONS[i][0],
        verified: false,
        verification: "Not verified"
      });
    }
  }

  /*
    Remove duplicates.
  */

  const unique = [
    ...new Map(
      results.map(
        r => [r.url, r]
      )
    ).values()
  ]
    .sort(
      (a, b) =>
        b.dealScore - a.dealScore
    )
    .slice(0, 30);

  /*
    Enrich the top 15 suppliers.
    This prevents excessive requests and keeps NOVA fast.
  */

  const enriched = [];

  for (const supplier of unique) {
    if (enriched.length < 15) {
      const result =
        await enrichSupplier(
          supplier.url,
          supplier
        );

      enriched.push(result);
    } else {
      enriched.push(supplier);
    }
  }

  /*
    Save supplier intelligence.
  */

  if (db && enriched.length) {
    for (const r of enriched) {
      try {
        await db.prepare(`
          INSERT OR IGNORE INTO suppliers(
            name,
            url,
            country,
            region,
            source,
            product,
            price,
            currency,
            moq,
            lead_time,
            shipping,
            incoterm,
            certifications,
            oem_odm,
            evidence,
            confidence,
            deal_score,
            verified,
            verification
          )
          VALUES(
            ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?
          )
        `).bind(
          r.title,
          r.url,
          r.country,
          r.region,
          "Yep + Supplier Page",
          clean,
          r.price,
          r.currency,
          r.moq,
          r.leadTime,
          r.shipping !== null
            ? String(r.shipping)
            : null,
          r.incoterm,
          r.certifications,
          r.oem_odm,
          r.evidence,
          r.confidence,
          r.dealScore,
          r.verified ? 1 : 0,
          r.verification
        ).run();
      } catch {}
    }
  }

  return {
    ok: true,
    results: enriched,
    total: enriched.length,
    indexed: enriched.length,
    networkTarget: TARGET_NETWORK,
    coverage: [
      ...new Set(
        REGIONS.map(x => x[1])
      )
    ]
  };
}

/* =========================
   AI
========================= */

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

  const r =
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
    r.response ||
    "No AI response generated."
  );
}

async function negotiate(body, env) {
  return ai(
    env,
    `
You are NOVA, an AI procurement negotiation agent.

Never invent supplier facts.
Separate verified facts from assumptions.
Use the supplier offer provided by the user.
Give practical commercial negotiation advice.
`,
    `
Supplier: ${body.supplier || ""}
Offer: ${body.offer || ""}
Quantity: ${body.quantity || ""}
Target: ${body.target || ""}
Supplier reply: ${body.reply || ""}

Return:
1. Offer analysis
2. Target price/range
3. Counteroffer
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Risks
8. Ready-to-send negotiation message
`
  );
}

/* =========================
   LANDED COST
========================= */

function landed(body) {
  const qty =
    Math.max(
      0,
      Number(
        body.quantity ??
        body.qty
      ) || 0
    );

  const unit =
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

  const duty =
    Math.max(
      0,
      Number(
        body.dutyPercent ??
        body.duty_percent
      ) || 0
    );

  const tax =
    Math.max(
      0,
      Number(
        body.taxPercent ??
        body.tax_percent
      ) || 0
    );

  const insurance =
    Math.max(
      0,
      Number(body.insurance) || 0
    );

  const local =
    Math.max(
      0,
      Number(
        body.localDelivery ??
        body.local_delivery
      ) || 0
    );

  const goods =
    qty * unit;

  const dutyAmt =
    goods * duty / 100;

  const taxable =
    goods +
    shipping +
    insurance +
    dutyAmt;

  const taxAmt =
    taxable * tax / 100;

  const total =
    goods +
    shipping +
    insurance +
    dutyAmt +
    taxAmt +
    local;

  return {
    goods,
    shipping,
    insurance,
    duty: dutyAmt,
    tax: taxAmt,
    localDelivery: local,
    total,
    unitLanded:
      qty
        ? total / qty
        : 0,
    status:
      "Estimated — verify freight, customs and taxes before payment"
  };
}

/* =========================
   HTML / SEO
========================= */

function htmlPage(
  title,
  desc,
  body
) {
  return `
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>${title}</title>
<meta name="description"
content="${desc}">
<link rel="canonical"
href="https://nova-procurement.nova-procurement-ai.workers.dev${body.path || "/"}">
</head>
<body style="font-family:Arial;max-width:900px;margin:40px auto;padding:20px">
<h1>${title}</h1>
<p>${desc}</p>
${body.content || ""}
<p><a href="/">Open NOVA</a></p>
</body>
</html>
`;
}

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
    "Find manufacturers and suppliers across China, India, Japan, South Korea, Europe and North America."
  ],
  "/supplier-comparison": [
    "Supplier Comparison | NOVA",
    "Compare supplier evidence, price, MOQ, lead time, risk and deal score."
  ],
  "/china-suppliers": [
    "China Suppliers | NOVA",
    "Discover Chinese manufacturers and wholesale suppliers using AI sourcing."
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
    "Discover submitted factory overstock, clearance and special commercial deals."
  ]
};

/* =========================
   WORKER
========================= */

export default {
  async fetch(request, env) {
    const u =
      new URL(request.url);

    const p =
      u.pathname;

    try {
      if (env.DB) {
        await ensureDB(env.DB);
      }

      /* Robots */

      if (p === "/robots.txt") {
        return new Response(
          `User-agent: *
Allow: /
Sitemap: ${u.origin}/sitemap.xml
`,
          {
            headers: {
              "Content-Type":
                "text/plain"
            }
          }
        );
      }

      /* Sitemap */

      if (p === "/sitemap.xml") {
        const paths = [
          "/",
          ...Object.keys(SEO)
        ];

        return new Response(
          `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${paths
  .map(
    x =>
      `<url><loc>${u.origin}${x}</loc></url>`
  )
  .join("")}
</urlset>`,
          {
            headers: {
              "Content-Type":
                "application/xml"
            }
          }
        );
      }

      /* SEO pages */

      if (SEO[p]) {
        const [title, desc] =
          SEO[p];

        return new Response(
          htmlPage(
            title,
            desc,
            {
              path: p,
              content: `
<h2>What NOVA does</h2>
<p>
Search suppliers, compare evidence,
estimate landed cost, generate RFQs
and negotiate procurement offers.
Missing facts remain marked as
not verified.
</p>`
            }
          ),
          {
            headers: {
              "Content-Type":
                "text/html;charset=UTF-8"
            }
          }
        );
      }

      /* SEARCH */

      if (
        p === "/api/search" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        return json(
          await searchSuppliers(
            b.request,
            env,
            env.DB
          )
        );
      }

      /* NETWORK */

      if (
        p === "/api/network" &&
        request.method === "GET"
      ) {
        const row =
          env.DB
            ? await env.DB
                .prepare(
                  "SELECT COUNT(*) AS count FROM suppliers"
                )
                .first()
            : { count: 0 };

        return json({
          ok: true,
          actualRecords:
            Number(row?.count || 0),
          targetRecords:
            TARGET_NETWORK,
          evidenceRecords:
            Number(row?.count || 0),
          coverage: [
            ...new Set(
              REGIONS.map(x => x[1])
            )
          ],
          status:
            "Live supplier discovery through configured search sources."
        });
      }

      /* SUPPLIERS */

      if (
        p === "/api/suppliers" &&
        request.method === "GET"
      ) {
        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM suppliers
              ORDER BY deal_score DESC, id DESC
              LIMIT 100
            `)
            .all();

        return json({
          suppliers:
            rows.results || []
        });
      }

      /* PROJECT */

      if (
        p === "/api/projects" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB
            .prepare(`
              INSERT INTO projects(
                user_id,
                name,
                product,
                quantity,
                destination
              )
              VALUES(?,?,?,?,?)
            `)
            .bind(
              user?.id || null,
              b.name || "Procurement Project",
              b.product || "",
              Number(b.quantity) || 0,
              b.destination || ""
            )
            .run();

        return json({
          success: true,
          id: r.meta.last_row_id
        });
      }

      /* RFQ */

      if (
        p === "/api/rfq" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const msg =
          await ai(
            env,
            `
You write concise professional procurement RFQs.
Never invent specifications.
`,
            `
Product: ${b.product || ""}
Quantity: ${b.quantity || ""}
Destination: ${b.destination || ""}
Requirements: ${b.requirements || "None"}

Create a ready-to-send RFQ asking for:
unit price,
MOQ,
sample,
production lead time,
Incoterm,
packaging,
shipping to destination,
payment terms,
certifications,
and quotation validity.
`
          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (user && env.DB) {
          await env.DB
            .prepare(`
              INSERT INTO rfqs(
                user_id,
                product,
                quantity,
                destination,
                requirements,
                message
              )
              VALUES(?,?,?,?,?,?)
            `)
            .bind(
              user.id,
              b.product || "",
              Number(b.quantity) || 0,
              b.destination || "",
              b.requirements || "",
              msg
            )
            .run();
        }

        return json({
          success: true,
          message: msg
        });
      }

      /* BIDS */

      if (
        p === "/api/bids" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const r =
          await env.DB
            .prepare(`
              INSERT INTO bids(
                user_id,
                rfq_id,
                supplier,
                supplier_url,
                unit_price,
                currency,
                moq,
                lead_time,
                shipping,
                incoterm,
                payment_terms,
                notes
              )
              VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
            `)
            .bind(
              user?.id || null,
              Number(
                b.rfqId ??
                b.rfq_id
              ) || null,
              b.supplier || "",
              b.supplierUrl ||
                b.supplier_url ||
                "",
              Number(
                b.unitPrice ??
                b.unit_price
              ) || 0,
              b.currency || "USD",
              Number(b.moq) || 0,
              b.leadTime ||
                b.lead_time ||
                "",
              Number(b.shipping) || 0,
              b.incoterm || "",
              b.paymentTerms ||
                b.payment_terms ||
                "",
              b.notes || ""
            )
            .run();

        return json({
          success: true,
          id: r.meta.last_row_id
        });
      }

      /* COMPARE */

      if (
        p === "/api/compare" &&
        (request.method === "POST" ||
          request.method === "GET")
      ) {
        let rows = [];

        if (request.method === "POST") {
          const b =
            await request.json();

          const ids =
            Array.isArray(b.ids)
              ? b.ids
              : [];

          if (ids.length) {
            const placeholders =
              ids.map(() => "?").join(",");

            const r =
              await env.DB
                .prepare(`
                  SELECT *
                  FROM bids
                  WHERE id IN (${placeholders})
                `)
                .bind(...ids)
                .all();

            rows =
              r.results || [];
          }
        } else {
          const r =
            await env.DB
              .prepare(`
                SELECT *
                FROM bids
                ORDER BY id DESC
                LIMIT 50
              `)
              .all();

          rows =
            r.results || [];
        }

        return json({
          success: true,
          bids: rows
        });
      }

      /* LANDED COST */

      if (
        p === "/api/landed-cost" &&
        request.method === "POST"
      ) {
        return json(
          landed(
            await request.json()
          )
        );
      }

      /* NEGOTIATION */

      if (
        p === "/api/negotiate" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        if (
          !b.supplier ||
          !b.offer
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
            b,
            env
          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (user && env.DB) {
          await env.DB
            .prepare(`
              INSERT INTO negotiations(
                user_id,
                supplier,
                offer,
                result
              )
              VALUES(?,?,?,?)
            `)
            .bind(
              user.id,
              b.supplier,
              b.offer,
              result
            )
            .run();
        }

        return json({
          success: true,
          result
        });
      }

      /* PURCHASE ORDER */

      if (
        p === "/api/purchase-order" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        const quantity =
          Number(b.quantity) || 0;

        const unitPrice =
          Number(
            b.unitPrice ??
            b.unit_price
          ) || 0;

        const total =
          quantity *
          unitPrice;

        const r =
          await env.DB
            .prepare(`
              INSERT INTO purchase_orders(
                user_id,
                bid_id,
                supplier,
                product,
                quantity,
                unit_price,
                total,
                currency,
                status
              )
              VALUES(?,?,?,?,?,?,?,?,?)
            `)
            .bind(
              user?.id || null,
              Number(
                b.bidId ??
                b.bid_id
              ) || null,
              b.supplier || "",
              b.product || "",
              quantity,
              unitPrice,
              total,
              b.currency || "USD",
              "draft"
            )
            .run();

        return json({
          success: true,
          id: r.meta.last_row_id,
          status: "draft",
          total
        });
      }

      /* FLASH DEALS */

      if (
        p === "/api/deals" &&
        request.method === "GET"
      ) {
        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM flash_deals
              WHERE status='submitted'
              AND (
                expires_at IS NULL
                OR expires_at > datetime('now')
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

      if (
        p === "/api/deals" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        await env.DB
          .prepare(`
            INSERT INTO flash_deals(
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
            b.company || "",
            b.product || "",
            b.description || "",
            b.country || "",
            Number(b.quantity) || 0,
            Number(b.price) || 0,
            b.currency || "USD",
            Number(b.moq) || 0,
            b.expiresAt ||
              b.expires_at ||
              null,
            b.url || ""
          )
          .run();

        return json({
          success: true,
          status: "submitted"
        });
      }

      /* MEMORY */

      if (
        p === "/api/memory" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {
          return json(
            {
              error:
                "Please login first."
            },
            401
          );
        }

        await env.DB
          .prepare(`
            INSERT INTO procurement_memory(
              user_id,
              supplier,
              product,
              note
            )
            VALUES(?,?,?,?)
          `)
          .bind(
            user.id,
            b.supplier || "",
            b.product || "",
            b.note || ""
          )
          .run();

        return json({
          success: true
        });
      }

      if (
        p === "/api/memory" &&
        request.method === "GET"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {
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
              FROM procurement_memory
              WHERE user_id=?
              ORDER BY id DESC
            `)
            .bind(user.id)
            .all();

        return json({
          memory:
            rows.results || []
        });
      }

      /* SIGNUP */

      if (
        p === "/api/signup" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const email =
          String(
            b.email || ""
          )
            .trim()
            .toLowerCase();

        const password =
          String(
            b.password || ""
          );

        if (
          !email ||
          password.length < 6
        ) {
          return json(
            {
              error:
                "Valid email and password of at least 6 characters are required."
            },
            400
          );
        }

        const exists =
          await env.DB
            .prepare(
              "SELECT id FROM users WHERE email=?"
            )
            .bind(email)
            .first();

        if (exists) {
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

        const r =
          await env.DB
            .prepare(`
              INSERT INTO users(
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

        const t =
          token();

        await env.DB
          .prepare(`
            INSERT INTO sessions(
              token,
              user_id,
              expires_at
            )
            VALUES(?,?,?)
          `)
          .bind(
            t,
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
              sessionCookie(t)
          }
        );
      }

      /* LOGIN */

      if (
        p === "/api/login" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const email =
          String(
            b.email || ""
          )
            .trim()
            .toLowerCase();

        const password =
          String(
            b.password || ""
          );

        const user =
          await env.DB
            .prepare(
              "SELECT * FROM users WHERE email=?"
            )
            .bind(email)
            .first();

        if (
          !user ||
          await passwordHash(
            password,
            user.salt
          ) !==
            user.password_hash
        ) {
          return json(
            {
              error:
                "Invalid email or password."
            },
            401
          );
        }

        const t =
          token();

        await env.DB
          .prepare(`
            INSERT INTO sessions(
              token,
              user_id,
              expires_at
            )
            VALUES(?,?,?)
          `)
          .bind(
            t,
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
              sessionCookie(t)
          }
        );
      }

      /* LOGOUT */

      if (
        p === "/api/logout"
      ) {
        const t =
          cookieValue(
            request,
            "nova_session"
          );

        if (t) {
          await env.DB
            .prepare(
              "DELETE FROM sessions WHERE token=?"
            )
            .bind(t)
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

      /* ME */

      if (
        p === "/api/me"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        return json({
          loggedIn: !!user,
          user:
            user || null
        });
      }

      /* PURCHASES */

      if (
        p === "/api/purchases" &&
        request.method === "POST"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {
          return json(
            {
              error:
                "Please login first."
            },
            401
          );
        }

        const b =
          await request.json();

        await env.DB
          .prepare(`
            INSERT INTO purchases(
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
            b.product || "",
            b.supplier || "",
            Number(b.quantity) || 0,
            Number(
              b.unitPrice ??
              b.unit_price
            ) || 0,
            Number(b.shipping) || 0,
            Number(
              b.landedCost ??
              b.landed_cost
            ) || 0,
            b.supplierUrl ||
              b.supplier_url ||
              ""
          )
          .run();

        return json({
          success: true
        });
      }

      if (
        p === "/api/purchases" &&
        request.method === "GET"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        if (!user) {
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

      /* HEALTH */

      if (
        p === "/api/health"
      ) {
        return json({
          ok: true,
          nova: "online",
          database:
            !!env.DB,
          ai:
            !!env.AI,
          yep:
            !!env.YEP_API_KEY
        });
      }

      /* FRONTEND */

      return env.ASSETS.fetch(
        request
      );

    } catch (e) {
      return json(
        {
          ok: false,
          error:
            e?.message ||
            "Server error."
        },
        500
      );
    }
  }
};
