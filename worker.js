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

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      ...extra
    }
  });
}

function cookie(req, name) {
  const c = req.headers.get("Cookie") || "";
  const m = c.match(new RegExp("(^|;\\s*)" + name + "=([^;]*)"));
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

/* =========================
   DATABASE
========================= */

async function ensureDB(db) {
  if (!db) throw new Error("D1 binding DB is not configured.");

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
        verification_status TEXT DEFAULT 'Not verified',
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
      CREATE TABLE IF NOT EXISTS projects(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        name TEXT,
        product TEXT,
        quantity REAL,
        destination TEXT,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS bids(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER,
        supplier_id INTEGER,
        supplier TEXT,
        unit_price REAL,
        quantity REAL,
        shipping REAL,
        lead_time_days REAL,
        moq REAL,
        currency TEXT DEFAULT 'USD',
        notes TEXT,
        status TEXT DEFAULT 'submitted',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),

    db.prepare(`
      CREATE TABLE IF NOT EXISTS purchase_orders(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        project_id INTEGER,
        supplier_id INTEGER,
        supplier TEXT,
        product TEXT,
        quantity REAL,
        unit_price REAL,
        currency TEXT DEFAULT 'USD',
        notes TEXT,
        status TEXT DEFAULT 'draft',
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
    `)
  ]);

  await migrateSuppliers(db);
}

async function tableColumns(db, table) {
  const r = await db.prepare(`PRAGMA table_info(${table})`).all();
  return new Set((r.results || []).map(x => x.name));
}

async function migrateSuppliers(db) {
  const columns = await tableColumns(db, "suppliers");

  const required = {
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
    verification_status: "TEXT DEFAULT 'Not verified'"
  };

  for (const [name, type] of Object.entries(required)) {
    if (!columns.has(name)) {
      await db.prepare(
        `ALTER TABLE suppliers ADD COLUMN ${name} ${type}`
      ).run();
    }
  }
}

/* =========================
   USER
========================= */

async function currentUser(req, db) {
  if (!db) return null;

  const t = cookie(req, "nova_session");
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
   SUPPLIER INTELLIGENCE
========================= */

function parsePrice(text) {
  const m = String(text || "").match(
    /(?:USD|US\$|\$)\s?(\d+(?:\.\d+)?)/i
  );
  return m ? Number(m[1]) : null;
}

function parseMOQ(text) {
  const m = String(text || "").match(
    /(?:MOQ|minimum order quantity|min(?:imum)? order)\D{0,40}([\d,]+)/i
  );
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

function parseLead(text) {
  const m = String(text || "").match(
    /(\d+(?:\s*-\s*\d+)?)\s*(days?|weeks?)/i
  );
  return m ? m[0] : null;
}

function supplierSignals(text) {
  const s = String(text || "").toLowerCase();

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

function evidenceScore(text) {
  const s = String(text || "").toLowerCase();

  const words = [
    ["$", 10],
    ["moq", 10],
    ["minimum order", 10],
    ["shipping", 5],
    ["lead time", 5],
    ["manufacturer", 5],
    ["factory", 5],
    ["oem", 5],
    ["odm", 5]
  ];

  let n = 0;

  for (const [w, v] of words) {
    if (s.includes(w)) n += v;
  }

  return Math.min(50, n);
}

function dealScore(signal, evidence, price, moq) {
  return Math.min(
    100,
    Math.max(
      0,
      50 +
      signal * 3 +
      evidence +
      (price !== null ? 5 : 0) +
      (moq !== null ? 5 : 0)
    )
  );
}

function confidence(evidence) {
  return Math.min(100, Math.round(evidence * 1.6));
}

/* =========================
   YEP
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

  const text = await r.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Yep returned invalid response. HTTP ${r.status}`);
  }

  if (!r.ok) {
    throw new Error(
      data.error || `Yep HTTP ${r.status}`
    );
  }

  return data;
}

/* =========================
   SEARCH + SAVE
========================= */

async function saveSupplier(db, r) {
  const existing = await db.prepare(
    "SELECT id FROM suppliers WHERE url = ? LIMIT 1"
  ).bind(r.url).first();

  if (existing) {
    await db.prepare(`
      UPDATE suppliers
      SET name=?,
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
          verification_status=?
      WHERE id=?
    `).bind(
      r.title,
      r.country,
      r.region,
      "Yep",
      r.product,
      r.evidence,
      r.dealScore,
      r.price,
      r.moq,
      r.leadTime,
      r.confidence,
      "Not verified",
      existing.id
    ).run();

    return;
  }

  await db.prepare(`
    INSERT INTO suppliers(
      name,url,country,region,source,product,
      evidence,deal_score,price,moq,lead_time,
      confidence,verification_status
    )
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    r.title,
    r.url,
    r.country,
    r.region,
    "Yep",
    r.product,
    r.evidence,
    r.dealScore,
    r.price,
    r.moq,
    r.leadTime,
    r.confidence,
    "Not verified"
  ).run();
}

async function searchSuppliers(requestText, env, db) {
  const clean = String(requestText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);

  if (!clean) {
    throw new Error("Please enter a procurement request.");
  }

  const base =
    `${clean} manufacturer factory supplier wholesale ` +
    `OEM ODM exporter bulk custom MOQ price quotation ` +
    `production lead time shipping`;

  const jobs = REGIONS.map(([code]) =>
    yepSearch(base, code, env, 10)
  );

  const settled = await Promise.allSettled(jobs);

  const results = [];

  for (let i = 0; i < settled.length; i++) {
    const x = settled[i];

    if (x.status !== "fulfilled") continue;

    const raw = Array.isArray(x.value.results)
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

      const price = parsePrice(combined);
      const moq = parseMOQ(combined);
      const lead = parseLead(combined);
      const signal = supplierSignals(combined);
      const evidence = evidenceScore(combined);
      const score = dealScore(
        signal,
        evidence,
        price,
        moq
      );

      results.push({
        title,
        url,
        snippet,
        price,
        moq,
        leadTime: lead,
        shipping: null,
        supplierSignal: signal,
        evidence,
        confidence: confidence(evidence),
        dealScore: score,
        region: REGIONS[i][1],
        country: REGIONS[i][0],
        product: clean,
        verified: false,
        verification: "Not verified"
      });
    }
  }

  const unique = [
    ...new Map(
      results.map(x => [x.url, x])
    ).values()
  ]
    .sort((a, b) => b.dealScore - a.dealScore)
    .slice(0, 60);

  if (db && unique.length) {
    for (const r of unique) {
      try {
        await saveSupplier(db, r);
      } catch (e) {
        console.log("Supplier save skipped:", e.message);
      }
    }
  }

  return {
    ok: true,
    results: unique,
    total: unique.length,
    networkTarget: TARGET_NETWORK
  };
}

/* =========================
   AI
========================= */

async function ai(env, system, user, max_tokens = 900) {
  if (!env.AI) {
    throw new Error("Workers AI binding AI is missing.");
  }

  const r = await env.AI.run(
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

  return r.response ||
    "No AI response generated.";
}

/* =========================
   LANDED COST
========================= */

function landed(body) {
  const quantity =
    Math.max(0, Number(body.quantity) || 0);

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

  const goods = quantity * unitPrice;

  const dutyAmount =
    goods * dutyPercent / 100;

  const taxable =
    goods +
    shipping +
    dutyAmount;

  const taxAmount =
    taxable * taxPercent / 100;

  const total =
    goods +
    shipping +
    dutyAmount +
    taxAmount +
    localDelivery;

  return {
    goods,
    shipping,
    duty: dutyAmount,
    tax: taxAmount,
    localDelivery,
    total,
    unitLanded:
      quantity ? total / quantity : 0,
    status:
      "Estimated — verify freight, customs and taxes before payment"
  };
}

/* =========================
   HTML
========================= */

function page(title, description) {
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

/* =========================
   MAIN
========================= */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (!env.DB) {
        if (path.startsWith("/api/")) {
          return json({
            ok: false,
            error: "D1 binding DB is not configured."
          }, 500);
        }
      } else {
        await ensureDB(env.DB);
      }

      /* HEALTH */

      if (path === "/api/health") {
        let supplierCount = 0;

        if (env.DB) {
          const row = await env.DB
            .prepare("SELECT COUNT(*) AS count FROM suppliers")
            .first();

          supplierCount =
            Number(row?.count || 0);
        }

        return json({
          ok: true,
          nova: "online",
          db: !!env.DB,
          ai: !!env.AI,
          yep: !!env.YEP_API_KEY,
          supplierRecords: supplierCount,
          target: TARGET_NETWORK
        });
      }

      /* NETWORK */

      if (
        path === "/api/network" &&
        request.method === "GET"
      ) {
        const row = await env.DB
          .prepare(
            "SELECT COUNT(*) AS count FROM suppliers"
          )
          .first();

        return json({
          ok: true,
          actualRecords:
            Number(row?.count || 0),
          targetRecords:
            TARGET_NETWORK,
          coverage: [
            ...new Set(
              REGIONS.map(x => x[1])
            )
          ]
        });
      }

      /* SEARCH */

      if (
        path === "/api/search" &&
        request.method === "POST"
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

      /* SUPPLIERS */

      if (
        path === "/api/suppliers" &&
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
          ok: true,
          suppliers:
            rows.results || []
        });
      }

      /* LANDED COST */

      if (
        path === "/api/landed-cost" &&
        request.method === "POST"
      ) {
        return json(
          landed(await request.json())
        );
      }

      /* RFQ */

      if (
        path === "/api/rfq" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        if (!body.product) {
          return json({
            error: "Product is required."
          }, 400);
        }

        const message =
          await ai(
            env,
            "You are NOVA, a professional procurement RFQ generator. Never invent specifications.",
            `Product: ${body.product}
Quantity: ${body.quantity || ""}
Destination: ${body.destination || ""}
Requirements: ${body.requirements || "None"}

Create a ready-to-send RFQ requesting:
unit price,
MOQ,
sample cost,
production lead time,
Incoterm,
packaging,
shipping,
payment terms,
certifications,
price validity.`
          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (user) {
          await env.DB.prepare(`
            INSERT INTO rfqs(
              user_id,product,quantity,
              destination,requirements,message
            )
            VALUES(?,?,?,?,?,?)
          `).bind(
            user.id,
            body.product,
            Number(body.quantity) || 0,
            body.destination || "",
            body.requirements || "",
            message
          ).run();
        }

        return json({
          ok: true,
          success: true,
          message
        });
      }

      /* NEGOTIATION */

      if (
        path === "/api/negotiate" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        if (!body.supplier) {
          return json({
            error: "Supplier is required."
          }, 400);
        }

        if (!body.offer && !body.message) {
          return json({
            error: "Offer is required."
          }, 400);
        }

        const offer =
          body.offer ||
          body.message ||
          "";

        const result =
          await ai(
            env,
            `You are NOVA, an evidence-first procurement negotiation agent.
Never invent supplier facts.
Clearly separate verified facts from assumptions.`,
            `Supplier: ${body.supplier}

Current offer:
${offer}

Supplier reply:
${body.reply || "Not provided"}

Return:
1. Offer analysis
2. Target price/range
3. Counteroffer
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Risks
8. Ready-to-send negotiation message`
          );

        const user =
          await currentUser(
            request,
            env.DB
          );

        if (user) {
          await env.DB.prepare(`
            INSERT INTO negotiations(
              user_id,supplier,offer,result
            )
            VALUES(?,?,?,?)
          `).bind(
            user.id,
            body.supplier,
            offer,
            result
          ).run();
        }

        return json({
          ok: true,
          success: true,
          result
        });
      }

      /* FLASH DEALS - FIXED */

      if (
        path === "/api/deals" &&
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
          ok: true,
          deals:
            rows.results || []
        });
      }

      if (
        path === "/api/deals" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const user =
          await currentUser(
            request,
            env.DB
          );

        await env.DB.prepare(`
          INSERT INTO flash_deals(
            user_id,company,product,
            description,country,quantity,
            price,currency,moq,
            expires_at,url
          )
          VALUES(?,?,?,?,?,?,?,?,?,?,?)
        `).bind(
          user?.id || null,
          body.company || "",
          body.product || "",
          body.description || "",
          body.country || "",
          Number(body.quantity) || 0,
          Number(body.price) || 0,
          body.currency || "USD",
          Number(body.moq) || 0,
          body.expiresAt || null,
          body.url || ""
        ).run();

        return json({
          ok: true,
          success: true,
          status: "submitted"
        });
      }

      /* ACCOUNT */

      if (
        path === "/api/signup" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const email =
          String(body.email || "")
            .trim()
            .toLowerCase();

        const password =
          String(body.password || "");

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
          await env.DB.prepare(
            "SELECT id FROM users WHERE email=?"
          ).bind(email).first();

        if (exists) {
          return json({
            error:
              "Account already exists."
          }, 409);
        }

        const salt = token();

        const hash =
          await passwordHash(
            password,
            salt
          );

        const r =
          await env.DB.prepare(`
            INSERT INTO users(
              email,password_hash,salt
            )
            VALUES(?,?,?)
          `).bind(
            email,
            hash,
            salt
          ).run();

        const session =
          token();

        await env.DB.prepare(`
          INSERT INTO sessions(
            token,user_id,expires_at
          )
          VALUES(?,?,?)
        `).bind(
          session,
          r.meta.last_row_id,
          Date.now() + 604800000
        ).run();

        return json(
          {
            ok: true,
            success: true,
            email
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(session)
          }
        );
      }

      if (
        path === "/api/login" &&
        request.method === "POST"
      ) {
        const body =
          await request.json();

        const email =
          String(body.email || "")
            .trim()
            .toLowerCase();

        const password =
          String(body.password || "");

        const user =
          await env.DB.prepare(
            "SELECT * FROM users WHERE email=?"
          ).bind(email).first();

        if (
          !user ||
          await passwordHash(
            password,
            user.salt
          ) !== user.password_hash
        ) {
          return json({
            error:
              "Invalid email or password."
          }, 401);
        }

        const session =
          token();

        await env.DB.prepare(`
          INSERT INTO sessions(
            token,user_id,expires_at
          )
          VALUES(?,?,?)
        `).bind(
          session,
          user.id,
          Date.now() + 604800000
        ).run();

        return json(
          {
            ok: true,
            success: true,
            email
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(session)
          }
        );
      }

      if (
        path === "/api/logout"
      ) {
        const t =
          cookie(
            request,
            "nova_session"
          );

        if (t) {
          await env.DB.prepare(
            "DELETE FROM sessions WHERE token=?"
          ).bind(t).run();
        }

        return json(
          {
            ok: true,
            success: true
          },
          200,
          {
            "Set-Cookie":
              clearCookie()
          }
        );
      }

      if (
        path === "/api/me"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        return json({
          ok: true,
          loggedIn: !!user,
          user: user || null
        });
      }

      /* PURCHASE HISTORY */

      if (
        path === "/api/purchases" &&
        request.method === "GET"
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
          await env.DB.prepare(`
            SELECT *
            FROM purchases
            WHERE user_id=?
            ORDER BY id DESC
          `).bind(user.id).all();

        return json({
          ok: true,
          purchases:
            rows.results || []
        });
      }

      if (
        path === "/api/purchases" &&
        request.method === "POST"
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
          INSERT INTO purchases(
            user_id,product,supplier,
            quantity,unit_price,shipping,
            landed_cost,supplier_url
          )
          VALUES(?,?,?,?,?,?,?,?)
        `).bind(
          user.id,
          body.product || "",
          body.supplier || "",
          Number(body.quantity) || 0,
          Number(
            body.unitPrice ??
            body.unit_price
          ) || 0,
          Number(body.shipping) || 0,
          Number(
            body.landedCost ??
            body.landed_cost
          ) || 0,
          body.supplierUrl ||
          body.supplier_url ||
          ""
        ).run();

        return json({
          ok: true,
          success: true
        });
      }

      /* PROJECTS */

      if (
        path === "/api/projects" &&
        request.method === "POST"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        const body =
          await request.json();

        const r =
          await env.DB.prepare(`
            INSERT INTO projects(
              user_id,name,product,
              quantity,destination
            )
            VALUES(?,?,?,?,?)
          `).bind(
            user?.id || null,
            body.name ||
              body.product ||
              "Procurement Project",
            body.product || "",
            Number(body.quantity) || 0,
            body.destination || ""
          ).run();

        return json({
          ok: true,
          success: true,
          projectId:
            r.meta.last_row_id
        });
      }

      if (
        path === "/api/projects" &&
        request.method === "GET"
      ) {
        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM projects
              ORDER BY id DESC
            `)
            .all();

        return json({
          ok: true,
          projects:
            rows.results || []
        });
      }

      /* BIDS */

      if (
        path === "/api/bids" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const projectId =
          b.projectId ??
          b.project_id;

        const supplierId =
          b.supplierId ??
          b.supplier_id;

        await env.DB.prepare(`
          INSERT INTO bids(
            project_id,supplier_id,
            supplier,unit_price,
            quantity,shipping,
            lead_time_days,moq,
            currency,notes
          )
          VALUES(?,?,?,?,?,?,?,?,?,?)
        `).bind(
          Number(projectId) || null,
          Number(supplierId) || null,
          b.supplier || "",
          Number(
            b.unitPrice ??
            b.unit_price
          ) || 0,
          Number(b.quantity) || 0,
          Number(b.shipping) || 0,
          Number(
            b.leadTimeDays ??
            b.lead_time_days
          ) || 0,
          Number(b.moq) || 0,
          b.currency || "USD",
          b.notes || ""
        ).run();

        return json({
          ok: true,
          success: true
        });
      }

      if (
        path === "/api/bids/compare" &&
        request.method === "GET"
      ) {
        const projectId =
          url.searchParams.get(
            "project_id"
          );

        const rows =
          await env.DB.prepare(`
            SELECT *
            FROM bids
            WHERE project_id=?
            ORDER BY unit_price ASC
          `).bind(
            projectId
          ).all();

        return json({
          ok: true,
          bids:
            rows.results || []
        });
      }

      /* AWARD */

      if (
        path === "/api/bids/award" &&
        request.method === "POST"
      ) {
        const b =
          await request.json();

        const bidId =
          b.bidId ??
          b.bid_id;

        await env.DB.prepare(`
          UPDATE bids
          SET status='awarded'
          WHERE id=?
        `).bind(
          bidId
        ).run();

        return json({
          ok: true,
          success: true,
          status: "awarded"
        });
      }

      /* PURCHASE ORDER */

      if (
        path === "/api/purchase-orders" &&
        request.method === "POST"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        const b =
          await request.json();

        let data = {
          projectId:
            b.projectId ??
            b.project_id,
          supplierId:
            b.supplierId ??
            b.supplier_id,
          supplier:
            b.supplier || "",
          product:
            b.product || "",
          quantity:
            Number(b.quantity) || 0,
          unitPrice:
            Number(
              b.unitPrice ??
              b.unit_price
            ) || 0,
          currency:
            b.currency || "USD",
          notes:
            b.notes || ""
        };

        const bidId =
          b.bidId ??
          b.bid_id;

        if (bidId) {
          const bid =
            await env.DB.prepare(
              "SELECT * FROM bids WHERE id=?"
            ).bind(bidId).first();

          if (bid) {
            data = {
              projectId:
                bid.project_id,
              supplierId:
                bid.supplier_id,
              supplier:
                bid.supplier || "",
              product:
                b.product || "",
              quantity:
                Number(
                  b.quantity ||
                  bid.quantity
                ) || 0,
              unitPrice:
                Number(
                  b.unitPrice ??
                  bid.unit_price
                ) || 0,
              currency:
                b.currency ||
                bid.currency ||
                "USD",
              notes:
                b.notes ||
                bid.notes ||
                ""
            };
          }
        }

        const r =
          await env.DB.prepare(`
            INSERT INTO purchase_orders(
              user_id,project_id,
              supplier_id,supplier,
              product,quantity,
              unit_price,currency,
              notes,status
            )
            VALUES(?,?,?,?,?,?,?,?,?,'draft')
          `).bind(
            user?.id || null,
            data.projectId || null,
            data.supplierId || null,
            data.supplier,
            data.product,
            data.quantity,
            data.unitPrice,
            data.currency,
            data.notes
          ).run();

        return json({
          ok: true,
          success: true,
          purchaseOrderId:
            r.meta.last_row_id,
          status: "draft",
          approvalRequired: true
        });
      }

      /* MEMORY */

      if (
        path === "/api/memory" &&
        request.method === "POST"
      ) {
        const user =
          await currentUser(
            request,
            env.DB
          );

        const b =
          await request.json();

        await env.DB.prepare(`
          INSERT INTO procurement_memory(
            user_id,product,
            supplier,outcome,memory
          )
          VALUES(?,?,?,?,?)
        `).bind(
          user?.id || null,
          b.product || "",
          b.supplier || "",
          b.outcome || "",
          b.memory || ""
        ).run();

        return json({
          ok: true,
          success: true
        });
      }

      if (
        path === "/api/memory" &&
        request.method === "GET"
      ) {
        const rows =
          await env.DB.prepare(`
            SELECT *
            FROM procurement_memory
            ORDER BY id DESC
            LIMIT 100
          `).all();

        return json({
          ok: true,
          memory:
            rows.results || []
        });
      }

      /* SEO */

      const seo = {
        "/ai-procurement":
          [
            "AI Procurement | NOVA",
            "AI purchasing agent."
          ],
        "/ai-sourcing":
          [
            "AI Sourcing | NOVA",
            "Global supplier discovery."
          ],
        "/supplier-finder":
          [
            "Supplier Finder | NOVA",
            "Find global manufacturers."
          ],
        "/supplier-comparison":
          [
            "Supplier Comparison | NOVA",
            "Compare supplier intelligence."
          ],
        "/china-suppliers":
          [
            "China Suppliers | NOVA",
            "Discover Chinese manufacturers."
          ],
        "/wholesale-suppliers":
          [
            "Wholesale Suppliers | NOVA",
            "Find global wholesalers."
          ],
        "/ai-purchasing-agent":
          [
            "AI Purchasing Agent | NOVA",
            "AI procurement workflow."
          ],
        "/flash-deals":
          [
            "Factory Flash Deals | NOVA",
            "Commercial supplier deals."
          ]
      };

      if (seo[path]) {
        return new Response(
          page(
            seo[path][0],
            seo[path][1]
          ),
          {
            headers: {
              "Content-Type":
                "text/html;charset=UTF-8"
            }
          }
        );
      }

      if (path === "/robots.txt") {
        return new Response(
          `User-agent: *
Allow: /
Sitemap: ${url.origin}/sitemap.xml`
        );
      }

      if (path === "/sitemap.xml") {
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
  x => `<url><loc>${url.origin}${x}</loc></url>`
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

      return env.ASSETS.fetch(request);

    } catch (error) {
      return json({
        ok: false,
        error:
          error?.message ||
          "Server error."
      }, 500);
    }
  }
};
