const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/* =========================================================
   NOVA 2.0 — AI PROCUREMENT BACKEND
========================================================= */

/* =========================================================
   BASIC HELPERS
========================================================= */

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

async function getBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function clean(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function now() {
  return Date.now();
}

/* =========================================================
   PASSWORD HASH
========================================================= */

async function hashPassword(password) {
  const data = new TextEncoder().encode(String(password));

  const hash =
    await crypto.subtle.digest("SHA-256", data);

  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

/* =========================================================
   SESSION
========================================================= */

function getCookie(request, name) {
  const cookie =
    request.headers.get("Cookie") || "";

  for (const part of cookie.split(";")) {
    const [key, ...rest] =
      part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

function sessionCookie(
  id,
  maxAge = 60 * 60 * 24 * 30
) {
  return [
    `nova_session=${encodeURIComponent(id)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

function clearSessionCookie() {
  return [
    "nova_session=",
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "Secure",
    "SameSite=Lax"
  ].join("; ");
}

/* =========================================================
   DATABASE
========================================================= */

async function ensureDatabase(env) {

  if (!env.DB) {
    throw new Error(
      "D1 database binding DB is not configured."
    );
  }

  await env.DB.batch([

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `),

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
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
      CREATE TABLE IF NOT EXISTS negotiations (
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
      CREATE TABLE IF NOT EXISTS deals (
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

    /* -----------------------------------------------------
       SUPPLIER INTELLIGENCE
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS suppliers (
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
      CREATE TABLE IF NOT EXISTS supplier_evidence (
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

    /* -----------------------------------------------------
       PROCUREMENT PROJECTS
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS procurement_projects (
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

    /* -----------------------------------------------------
       RFQS
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS rfqs (
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

    /* -----------------------------------------------------
       SUPPLIER BIDS
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS bids (
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

    /* -----------------------------------------------------
       PURCHASE ORDERS
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS purchase_orders (
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

    /* -----------------------------------------------------
       PROCUREMENT MEMORY
    ----------------------------------------------------- */

    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS procurement_memory (
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

async function requireAuth(request, env) {

  const sessionId =
    getCookie(request, "nova_session");

  if (!sessionId) {
    throw new Error("Authentication required.");
  }

  const result =
    await env.DB
      .prepare(`
        SELECT
          sessions.id,
          sessions.user_id,
          sessions.expires_at,
          users.email
        FROM sessions
        JOIN users
          ON users.id = sessions.user_id
        WHERE sessions.id = ?
        LIMIT 1
      `)
      .bind(sessionId)
      .first();

  if (!result) {
    throw new Error("Authentication required.");
  }

  if (Number(result.expires_at) < now()) {

    await env.DB
      .prepare(
        "DELETE FROM sessions WHERE id = ?"
      )
      .bind(sessionId)
      .run();

    throw new Error("Session expired.");
  }

  return {
    id: result.user_id,
    email: result.email,
    sessionId
  };
}

/* =========================================================
   SEARCH EXTRACTION
========================================================= */

function extractPrice(text) {

  const value = String(text || "");

  const patterns = [
    /\$\s?(\d+(?:\.\d+)?)/i,
    /USD\s?(\d+(?:\.\d+)?)/i,
    /(\d+(?:\.\d+)?)\s?USD/i,
    /price\s*[:\-]?\s*\$?\s?(\d+(?:\.\d+)?)/i,
    /unit\s*price\s*[:\-]?\s*\$?\s?(\d+(?:\.\d+)?)/i
  ];

  for (const pattern of patterns) {

    const match = value.match(pattern);

    if (match) {

      const n = Number(match[1]);

      if (Number.isFinite(n)) {
        return n;
      }
    }
  }

  return null;
}

function extractMOQ(text) {

  const value = String(text || "");

  const patterns = [
    /MOQ\s*[:\-]?\s*(\d[\d,]*)/i,
    /minimum\s+order\s+(?:quantity)?\s*[:\-]?\s*(\d[\d,]*)/i,
    /minimum\s+quantity\s*[:\-]?\s*(\d[\d,]*)/i,
    /(\d[\d,]*)\s*(?:pcs|pieces|units)\s+MOQ/i
  ];

  for (const pattern of patterns) {

    const match = value.match(pattern);

    if (match) {

      const n =
        Number(match[1].replace(/,/g, ""));

      if (Number.isFinite(n)) {
        return n;
      }
    }
  }

  return null;
}

function extractLead(text) {

  const value = String(text || "");

  const patterns = [
    /(\d+)\s*[-–]?\s*(\d+)?\s*days?/i,
    /lead\s*time\s*[:\-]?\s*(\d+)/i,
    /production\s*time\s*[:\-]?\s*(\d+)/i
  ];

  for (const pattern of patterns) {

    const match = value.match(pattern);

    if (match) {

      if (match[2]) {
        return `${match[1]}-${match[2]} days`;
      }

      return `${match[1]} days`;
    }
  }

  return null;
}

/* =========================================================
   EVIDENCE
========================================================= */

function evidenceScore(text) {

  const value =
    String(text || "").toLowerCase();

  let score = 0;

  if (
    value.includes("supplier") ||
    value.includes("factory") ||
    value.includes("manufacturer")
  ) score += 10;

  if (
    value.includes("wholesale") ||
    value.includes("bulk")
  ) score += 10;

  if (
    value.includes("oem") ||
    value.includes("odm") ||
    value.includes("custom")
  ) score += 10;

  if (
    value.includes("moq") ||
    value.includes("minimum order")
  ) score += 10;

  if (
    value.includes("price") ||
    value.includes("usd") ||
    value.includes("$") ||
    value.includes("quotation")
  ) score += 10;

  if (
    value.includes("lead time") ||
    value.includes("shipping") ||
    value.includes("delivery")
  ) score += 10;

  return Math.min(score, 50);
}

/* =========================================================
   DEAL SCORE
========================================================= */

function dealScore(text) {

  const value =
    String(text || "").toLowerCase();

  let score = 0;

  if (
    value.includes("factory") ||
    value.includes("manufacturer")
  ) score += 15;

  if (
    value.includes("wholesale") ||
    value.includes("bulk")
  ) score += 10;

  if (
    value.includes("oem") ||
    value.includes("odm")
  ) score += 5;

  if (
    value.includes("custom") ||
    value.includes("custom logo")
  ) score += 5;

  return Math.min(score, 35);
}

/* =========================================================
   COUNTRY
========================================================= */

function countryFromText(text) {

  const value =
    String(text || "").toLowerCase();

  if (
    value.includes("china") ||
    value.includes("shenzhen") ||
    value.includes("guangzhou") ||
    value.includes("yiwu") ||
    value.includes("ningbo")
  ) return "China";

  if (
    value.includes("india") ||
    value.includes("delhi") ||
    value.includes("mumbai") ||
    value.includes("bangalore")
  ) return "India";

  if (
    value.includes("japan") ||
    value.includes("tokyo") ||
    value.includes("osaka")
  ) return "Japan";

  if (
    value.includes("south korea") ||
    value.includes("korea") ||
    value.includes("seoul")
  ) return "South Korea";

  if (
    value.includes("germany") ||
    value.includes("france") ||
    value.includes("italy") ||
    value.includes("spain") ||
    value.includes("netherlands") ||
    value.includes("europe")
  ) return "Europe";

  if (
    value.includes("usa") ||
    value.includes("united states") ||
    value.includes("america")
  ) return "North America";

  return "Global";
}

/* =========================================================
   NORMALIZE SEARCH RESULT
========================================================= */

function normalizeSearchResult(item) {

  const title =
    clean(
      item?.title ||
      item?.name ||
      item?.headline ||
      "",
      500
    );

  const url =
    clean(
      item?.url ||
      item?.link ||
      "",
      2000
    );

  const snippet =
    clean(
      item?.snippet ||
      item?.description ||
      item?.content ||
      "",
      3000
    );

  const combined =
    `${title} ${snippet}`;

  const evidence =
    evidenceScore(combined);

  const score =
    dealScore(combined);

  const confidence =
    Math.min(
      98,
      Math.round(evidence * 1.7)
    );

  return {
    title,
    url,
    snippet,
    country: countryFromText(combined),
    region: countryFromText(combined),
    price: extractPrice(combined),
    moq: extractMOQ(combined),
    leadTime: extractLead(combined),
    evidence,
    confidence,
    dealScore: score
  };
}

/* =========================================================
   YEP SEARCH
========================================================= */

async function yepSearch(env, query) {

  if (!env.YEP_API_KEY) {
    throw new Error(
      "YEP_API_KEY is not configured."
    );
  }

  const response =
    await fetch(
      "https://platform.yep.com/api/search",
      {
        method: "POST",

        headers: {
          "Authorization":
            `Bearer ${env.YEP_API_KEY}`,
          "Content-Type":
            "application/json"
        },

        body: JSON.stringify({
          query,
          type: "basic",
          limit: 20,
          language: ["en"],
          location: "US"
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
      `Yep search returned invalid JSON (${response.status}).`
    );
  }

  if (!response.ok) {

    throw new Error(
      data?.error ||
      data?.message ||
      `Yep search failed (${response.status}).`
    );
  }

  return data;
}

/* =========================================================
   WORKERS AI
========================================================= */

async function runAI(env, messages) {

  if (!env.AI) {
    throw new Error(
      "Workers AI is not configured."
    );
  }

  const result =
    await env.AI.run(
      MODEL,
      {
        messages,
        max_tokens: 1200,
        temperature: 0.2
      }
    );

  return (
    result?.response ||
    result?.result?.response ||
    JSON.stringify(result)
  );
}

/* =========================================================
   RFQ GENERATOR
========================================================= */

async function generateRFQ(
  env,
  product,
  quantity,
  destination,
  requirements
) {

  let commercialQuestions = "";

  try {

    commercialQuestions =
      await runAI(
        env,
        [
          {
            role: "system",

            content: `
You are NOVA, a professional procurement specialist.

Generate only a short list of useful commercial questions
for a factory or supplier.

Do not change buyer product, quantity or destination.

Do not invent facts.

Return 4 to 6 concise bullet points.

Focus on:
- best unit price
- MOQ
- production lead time
- sample
- payment terms
- shipping / Incoterms
- quotation validity
`
          },

          {
            role: "user",

            content: `
Product:
${product}

Quantity:
${quantity}

Destination:
${destination}

Requirements:
${requirements}
`
          }
        ]
      );

  } catch {

    commercialQuestions =
      `- Best unit price based on requested quantity
- MOQ and quantity discounts
- Production lead time
- Sample availability and cost
- Payment terms
- Shipping terms and Incoterms`;
  }

  commercialQuestions =
    String(commercialQuestions || "")
      .replace(/\[Insert[^\]]*\]/gi, "")
      .trim();

  return `
Dear Supplier,

REQUEST FOR QUOTATION (RFQ)

We are looking for a reliable manufacturer or supplier and would like to receive your best commercial quotation.

PRODUCT
${product}

QUANTITY
${quantity} units

DESTINATION
${destination}

PRODUCT SPECIFICATIONS
${requirements || "Please quote according to the product description above and clearly state the specifications of the offered product."}

CUSTOMIZATION
Please confirm whether customization is available and specify any additional cost, minimum quantity and production requirements.

PACKAGING
Please provide available packaging options and any applicable packaging costs.

PRICE REQUEST
Please provide your best competitive unit price based on the requested quantity.

Please provide:
- Unit price
- Packaging cost
- Customization cost
- Sample cost
- Any other applicable charges

MOQ
Please confirm your minimum order quantity.

PRODUCTION LEAD TIME
Please confirm production lead time after order confirmation.

SAMPLE
Please confirm sample availability, sample cost and sample lead time.

CERTIFICATIONS / COMPLIANCE
Please provide relevant certifications and compliance documents.

SHIPPING
Please provide shipping options to:

${destination}

Please state available Incoterms including EXW, FOB, CIF, DDP or other applicable terms.

PAYMENT TERMS
Please provide available payment terms and accepted payment methods.

QUOTATION VALIDITY
Please state quotation validity.

SUPPLIER INFORMATION
Please include:
- Company name
- Manufacturer/factory status
- Company location
- Years of experience
- Main export markets
- Product catalogue or website
- Relevant certifications

ADDITIONAL COMMERCIAL QUESTIONS
${commercialQuestions}

Please provide a complete quotation with all applicable costs and conditions.

We look forward to receiving your best quotation.

Best regards,

NOVA Procurement
AI Purchasing Agent
`.trim();
}

/* =========================================================
   SUPPLIER SCORE
========================================================= */

function calculateSupplierScore({
  evidence = 0,
  risk = 50,
  price = null,
  moq = null,
  leadTime = null
}) {

  let score = 0;

  score += Math.min(40, Number(evidence) || 0);

  score += Math.max(
    0,
    Math.min(30, 30 - Number(risk) * 0.3)
  );

  if (price !== null) {
    score += 15;
  }

  if (moq !== null) {
    score += 5;
  }

  if (leadTime) {
    score += 5;
  }

  return Math.round(
    Math.max(0, Math.min(100, score))
  );
}

/* =========================================================
   BID SCORE
========================================================= */

function calculateBidScore(data) {

  const price =
    num(data.unit_price);

  const shipping =
    num(data.shipping);

  const duty =
    num(data.duty);

  const tax =
    num(data.tax);

  const landed =
    num(
      data.landed_cost,
      price + shipping + duty + tax
    );

  let score = 50;

  if (landed > 0) {
    score += Math.max(
      0,
      Math.min(
        30,
        30 - landed
      )
    );
  }

  if (data.moq !== null && data.moq !== undefined) {
    score += 5;
  }

  if (data.lead_time) {
    score += 5;
  }

  if (data.payment_terms) {
    score += 5;
  }

  if (data.incoterm) {
    score += 5;
  }

  return Math.round(
    Math.max(0, Math.min(100, score))
  );
}

/* =========================================================
   MAIN WORKER
========================================================= */

export default {

  async fetch(request, env) {

    const url =
      new URL(request.url);

    const path =
      url.pathname;

    try {

      await ensureDatabase(env);

      /* -----------------------------------------------------
         OPTIONS
      ----------------------------------------------------- */

      if (request.method === "OPTIONS") {

        return new Response(null, {
          status: 204,

          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods":
              "GET,POST,OPTIONS",
            "Access-Control-Allow-Headers":
              "Content-Type"
          }
        });
      }

      /* =====================================================
         SIGN UP
      ===================================================== */

      if (
        path === "/api/signup" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const email =
          clean(data.email, 320)
            .toLowerCase();

        const password =
          String(data.password || "");

        if (!email || !password) {
          return json(
            {
              error:
                "Email and password are required."
            },
            400
          );
        }

        if (password.length < 6) {
          return json(
            {
              error:
                "Password must be at least 6 characters."
            },
            400
          );
        }

        const existing =
          await env.DB
            .prepare(
              "SELECT id FROM users WHERE email = ? LIMIT 1"
            )
            .bind(email)
            .first();

        if (existing) {
          return json(
            {
              error:
                "An account with this email already exists."
            },
            409
          );
        }

        const passwordHash =
          await hashPassword(password);

        const createdAt =
          now();

        const result =
          await env.DB
            .prepare(`
              INSERT INTO users
              (email, password_hash, created_at)
              VALUES (?, ?, ?)
            `)
            .bind(
              email,
              passwordHash,
              createdAt
            )
            .run();

        return json({
          ok: true,
          user: {
            id: result.meta.last_row_id,
            email
          }
        });
      }

      /* =====================================================
         LOGIN
      ===================================================== */

      if (
        path === "/api/login" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const email =
          clean(data.email, 320)
            .toLowerCase();

        const password =
          String(data.password || "");

        if (!email || !password) {
          return json(
            {
              error:
                "Email and password are required."
            },
            400
          );
        }

        const passwordHash =
          await hashPassword(password);

        const user =
          await env.DB
            .prepare(`
              SELECT id, email
              FROM users
              WHERE email = ?
              AND password_hash = ?
              LIMIT 1
            `)
            .bind(
              email,
              passwordHash
            )
            .first();

        if (!user) {
          return json(
            {
              error:
                "Invalid email or password."
            },
            401
          );
        }

        const sessionId =
          crypto.randomUUID();

        const createdAt =
          now();

        const expiresAt =
          createdAt +
          1000 * 60 * 60 * 24 * 30;

        await env.DB
          .prepare(`
            INSERT INTO sessions
            (id, user_id, expires_at, created_at)
            VALUES (?, ?, ?, ?)
          `)
          .bind(
            sessionId,
            user.id,
            expiresAt,
            createdAt
          )
          .run();

        return json(
          {
            ok: true,
            user: {
              id: user.id,
              email: user.email
            }
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(sessionId)
          }
        );
      }

      /* =====================================================
         LOGOUT
      ===================================================== */

      if (
        path === "/api/logout" &&
        request.method === "POST"
      ) {

        const sessionId =
          getCookie(
            request,
            "nova_session"
          );

        if (sessionId) {

          await env.DB
            .prepare(
              "DELETE FROM sessions WHERE id = ?"
            )
            .bind(sessionId)
            .run();
        }

        return json(
          { ok: true },
          200,
          {
            "Set-Cookie":
              clearSessionCookie()
          }
        );
      }

      /* =====================================================
         CURRENT USER
      ===================================================== */

      if (
        path === "/api/me" &&
        request.method === "GET"
      ) {

        try {

          const user =
            await requireAuth(
              request,
              env
            );

          return json({
            ok: true,
            loggedIn: true,
            user: {
              id: user.id,
              email: user.email
            }
          });

        } catch {

          return json({
            ok: true,
            loggedIn: false,
            user: null
          });
        }
      }

      /* =====================================================
         NETWORK
      ===================================================== */

      if (
        path === "/api/network" &&
        request.method === "GET"
      ) {

        const supplierCount =
          await env.DB
            .prepare(
              "SELECT COUNT(*) AS count FROM suppliers"
            )
            .first();

        const evidenceCount =
          await env.DB
            .prepare(
              "SELECT COUNT(*) AS count FROM supplier_evidence"
            )
            .first();

        return json({
          ok: true,

          actualRecords:
            Number(supplierCount?.count || 0),

          targetRecords: 20000000,

          evidenceRecords:
            Number(evidenceCount?.count || 0),

          coverage: [
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

      if (
        path === "/api/search" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const cleanRequest =
          clean(
            data.query ||
            data.product ||
            data.request,
            2000
          );

        if (!cleanRequest) {
          return json(
            {
              error:
                "Search query is required."
            },
            400
          );
        }

        const searchQuery = `
          ${cleanRequest}
          manufacturer supplier factory wholesale
          OEM ODM exporter bulk custom logo
          MOQ minimum order quantity
          unit price USD quotation
          production lead time shipping
        `
          .replace(/\s+/g, " ")
          .trim();

        const dataFromYep =
          await yepSearch(
            env,
            searchQuery
          );

        const rawResults =
          Array.isArray(
            dataFromYep?.results
          )
            ? dataFromYep.results
            : [];

        const results =
          rawResults
            .map(normalizeSearchResult)
            .filter(
              item =>
                item.title ||
                item.url ||
                item.snippet
            );

        results.sort(
          (a, b) =>
            (b.dealScore - a.dealScore) ||
            (b.evidence - a.evidence) ||
            (b.confidence - a.confidence)
        );

        /* -----------------------------------------------------
           SAVE SUPPLIER INTELLIGENCE
        ----------------------------------------------------- */

        for (const item of results) {

          if (!item.title) continue;

          const existing =
            await env.DB
              .prepare(`
                SELECT id
                FROM suppliers
                WHERE name = ?
                AND website = ?
                LIMIT 1
              `)
              .bind(
                item.title,
                item.url
              )
              .first();

          let supplierId;

          if (existing) {

            supplierId =
              existing.id;

            await env.DB
              .prepare(`
                UPDATE suppliers
                SET
                  country = ?,
                  description = ?,
                  evidence_score = ?,
                  supplier_score = ?,
                  updated_at = ?
                WHERE id = ?
              `)
              .bind(
                item.country,
                item.snippet,
                item.evidence,
                calculateSupplierScore({
                  evidence: item.evidence,
                  risk: 50,
                  price: item.price,
                  moq: item.moq,
                  leadTime: item.leadTime
                }),
                now(),
                supplierId
              )
              .run();

          } else {

            const inserted =
              await env.DB
                .prepare(`
                  INSERT INTO suppliers
                  (
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
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `)
                .bind(
                  item.title,
                  item.country,
                  item.url,
                  item.snippet,
                  "Yep",
                  "not_verified",
                  item.evidence,
                  50,
                  calculateSupplierScore({
                    evidence: item.evidence,
                    risk: 50,
                    price: item.price,
                    moq: item.moq,
                    leadTime: item.leadTime
                  }),
                  now(),
                  now()
                )
                .run();

            supplierId =
              inserted.meta.last_row_id;
          }

          await env.DB
            .prepare(`
              INSERT INTO supplier_evidence
              (
                supplier_id,
                evidence_type,
                source_url,
                evidence_text,
                score,
                verified,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              supplierId,
              "search_result",
              item.url,
              item.snippet,
              item.evidence,
              0,
              now()
            )
            .run();
        }

        return json({
          ok: true,
          results,
          total: results.length,
          query: searchQuery,
          yepSuccess: true,
          request_id:
            dataFromYep?.request_id || null
        });
      }

      /* =====================================================
         SUPPLIER INTELLIGENCE — GET
      ===================================================== */

      if (
        path === "/api/suppliers" &&
        request.method === "GET"
      ) {

        const limit =
          Math.min(
            100,
            Math.max(
              1,
              num(
                url.searchParams.get("limit"),
                50
              )
            )
          );

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
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
              FROM suppliers
              ORDER BY supplier_score DESC, id DESC
              LIMIT ?
            `)
            .bind(limit)
            .all();

        return json({
          ok: true,
          suppliers:
            result?.results || []
        });
      }

      /* =====================================================
         SUPPLIER INTELLIGENCE — CREATE / UPDATE
      ===================================================== */

      if (
        path === "/api/supplier" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const name =
          clean(data.name, 500);

        const country =
          clean(data.country, 300);

        const website =
          clean(data.website, 2000);

        const description =
          clean(data.description, 3000);

        if (!name) {
          return json(
            {
              error:
                "Supplier name required."
            },
            400
          );
        }

        const evidence =
          num(data.evidence);

        const risk =
          num(data.risk, 50);

        const verificationStatus =
          clean(
            data.verificationStatus ||
            "not_verified",
            100
          );

        const score =
          calculateSupplierScore({
            evidence,
            risk,
            price:
              data.price == null
                ? null
                : num(data.price),
            moq:
              data.moq == null
                ? null
                : num(data.moq),
            leadTime:
              data.leadTime || null
          });

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO suppliers
              (
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
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              name,
              country,
              website,
              description,
              clean(data.source || "manual", 100),
              verificationStatus,
              evidence,
              risk,
              score,
              now(),
              now()
            )
            .run();

        return json({
          ok: true,
          supplierId:
            inserted.meta.last_row_id,
          supplierScore: score
        });
      }

      /* =====================================================
         PROJECT CREATE
      ===================================================== */

      if (
        path === "/api/projects" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        const name =
          clean(
            data.name ||
            data.product ||
            "Procurement Project",
            500
          );

        const product =
          clean(data.product, 1000);

        const quantity =
          num(data.quantity);

        const destination =
          clean(data.destination, 500);

        const requirements =
          clean(data.requirements, 5000);

        if (!product) {
          return json(
            {
              error:
                "Product required."
            },
            400
          );
        }

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO procurement_projects
              (
                user_id,
                name,
                product,
                quantity,
                destination,
                requirements,
                status,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              user?.id || null,
              name,
              product,
              quantity,
              destination,
              requirements,
              "active",
              now(),
              now()
            )
            .run();

        return json({
          ok: true,
          projectId:
            inserted.meta.last_row_id,
          status: "active"
        });
      }

      /* =====================================================
         PROJECTS GET
      ===================================================== */

      if (
        path === "/api/projects" &&
        request.method === "GET"
      ) {

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        let result;

        if (user) {

          result =
            await env.DB
              .prepare(`
                SELECT *
                FROM procurement_projects
                WHERE user_id = ?
                OR user_id IS NULL
                ORDER BY id DESC
                LIMIT 100
              `)
              .bind(user.id)
              .all();

        } else {

          result =
            await env.DB
              .prepare(`
                SELECT *
                FROM procurement_projects
                WHERE user_id IS NULL
                ORDER BY id DESC
                LIMIT 100
              `)
              .all();
        }

        return json({
          ok: true,
          projects:
            result?.results || []
        });
      }

      /* =====================================================
         AI RFQ
      ===================================================== */

      if (
        path === "/api/rfq" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const product =
          clean(data.product, 1000);

        const quantity =
          num(data.quantity);

        const destination =
          clean(data.destination, 300);

        const requirements =
          clean(data.requirements, 3000);

        if (!product) {
          return json(
            {
              error:
                "Product required."
            },
            400
          );
        }

        if (quantity <= 0) {
          return json(
            {
              error:
                "Valid quantity required."
            },
            400
          );
        }

        if (!destination) {
          return json(
            {
              error:
                "Destination required."
            },
            400
          );
        }

        const message =
          await generateRFQ(
            env,
            product,
            quantity,
            destination,
            requirements
          );

        return json({
          ok: true,
          message
        });
      }

      /* =====================================================
         RFQ CREATE + SAVE
      ===================================================== */

      if (
        path === "/api/rfq/create" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        const product =
          clean(data.product, 1000);

        const quantity =
          num(data.quantity);

        const destination =
          clean(data.destination, 500);

        const requirements =
          clean(data.requirements, 5000);

        const projectId =
          data.projectId
            ? num(data.projectId)
            : null;

        if (!product || quantity <= 0) {
          return json(
            {
              error:
                "Product and valid quantity required."
            },
            400
          );
        }

        const message =
          await generateRFQ(
            env,
            product,
            quantity,
            destination,
            requirements
          );

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO rfqs
              (
                project_id,
                user_id,
                product,
                quantity,
                destination,
                requirements,
                message,
                status,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              projectId,
              user?.id || null,
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
          ok: true,
          rfqId:
            inserted.meta.last_row_id,
          message,
          status: "draft"
        });
      }

      /* =====================================================
         LANDED COST
      ===================================================== */

      if (
        path === "/api/landed-cost" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const quantity =
          num(data.quantity);

        const unitPrice =
          num(data.unitPrice);

        const shipping =
          num(data.shipping);

        const dutyPercent =
          num(data.dutyPercent);

        const taxPercent =
          num(data.taxPercent);

        const localDelivery =
          num(data.localDelivery);

        if (
          quantity <= 0 ||
          unitPrice < 0
        ) {
          return json(
            {
              error:
                "Quantity and unit price must be valid."
            },
            400
          );
        }

        const goods =
          quantity * unitPrice;

        const duty =
          goods *
          (dutyPercent / 100);

        const taxableBase =
          goods +
          shipping +
          duty;

        const tax =
          taxableBase *
          (taxPercent / 100);

        const total =
          goods +
          shipping +
          duty +
          tax +
          localDelivery;

        const unitLanded =
          total / quantity;

        return json({
          ok: true,
          quantity,
          unitPrice,
          goods,
          shipping,
          duty,
          tax,
          localDelivery,
          total,
          unitLanded,
          status:
            "Estimated landed cost. Actual customs, taxes, shipping and fees must be verified for the destination."
        });
      }

      /* =====================================================
         BIDS — CREATE
      ===================================================== */

      if (
        path === "/api/bids" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const projectId =
          data.projectId
            ? num(data.projectId)
            : null;

        const supplierId =
          data.supplierId
            ? num(data.supplierId)
            : null;

        const supplierName =
          clean(
            data.supplierName ||
            data.supplier ||
            "",
            500
          );

        const unitPrice =
          num(data.unitPrice);

        const quantity =
          num(data.quantity);

        const moq =
          num(data.moq);

        const shipping =
          num(data.shipping);

        const duty =
          num(data.duty);

        const tax =
          num(data.tax);

        const landedCost =
          num(
            data.landedCost,
            unitPrice + shipping + duty + tax
          );

        const leadTime =
          clean(data.leadTime, 200);

        const paymentTerms =
          clean(data.paymentTerms, 500);

        const incoterm =
          clean(data.incoterm, 100);

        const qualityNotes =
          clean(data.qualityNotes, 3000);

        const offerText =
          clean(data.offerText, 5000);

        if (!supplierName) {
          return json(
            {
              error:
                "Supplier name required."
            },
            400
          );
        }

        if (unitPrice < 0) {
          return json(
            {
              error:
                "Valid unit price required."
            },
            400
          );
        }

        const comparisonScore =
          calculateBidScore({
            unit_price: unitPrice,
            shipping,
            duty,
            tax,
            landed_cost: landedCost,
            moq,
            lead_time: leadTime,
            payment_terms: paymentTerms,
            incoterm
          });

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO bids
              (
                project_id,
                supplier_id,
                supplier_name,
                unit_price,
                quantity,
                moq,
                shipping,
                duty,
                tax,
                landed_cost,
                lead_time,
                payment_terms,
                incoterm,
                quality_notes,
                offer_text,
                comparison_score,
                status,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              projectId,
              supplierId,
              supplierName,
              unitPrice,
              quantity,
              moq,
              shipping,
              duty,
              tax,
              landedCost,
              leadTime,
              paymentTerms,
              incoterm,
              qualityNotes,
              offerText,
              comparisonScore,
              "submitted",
              now(),
              now()
            )
            .run();

        return json({
          ok: true,
          bidId:
            inserted.meta.last_row_id,
          comparisonScore
        });
      }

      /* =====================================================
         BIDS — COMPARE
      ===================================================== */

      if (
        path === "/api/bids/compare" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const projectId =
          num(data.projectId);

        if (!projectId) {
          return json(
            {
              error:
                "Project ID required."
            },
            400
          );
        }

        const result =
          await env.DB
            .prepare(`
              SELECT
                *
              FROM bids
              WHERE project_id = ?
              ORDER BY
                comparison_score DESC,
                landed_cost ASC,
                id ASC
            `)
            .bind(projectId)
            .all();

        const bids =
          result?.results || [];

        return json({
          ok: true,
          projectId,
          count: bids.length,
          bids,
          note:
            "Comparison score is a decision-support heuristic, not independent supplier verification."
        });
      }

      /* =====================================================
         AWARD BID
      ===================================================== */

      if (
        path === "/api/award" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const bidId =
          num(data.bidId);

        if (!bidId) {
          return json(
            {
              error:
                "Bid ID required."
            },
            400
          );
        }

        const bid =
          await env.DB
            .prepare(`
              SELECT *
              FROM bids
              WHERE id = ?
              LIMIT 1
            `)
            .bind(bidId)
            .first();

        if (!bid) {
          return json(
            {
              error:
                "Bid not found."
            },
            404
          );
        }

        await env.DB.batch([

          env.DB
            .prepare(`
              UPDATE bids
              SET status = 'awarded',
                  updated_at = ?
              WHERE id = ?
            `)
            .bind(
              now(),
              bidId
            ),

          env.DB
            .prepare(`
              UPDATE bids
              SET status = 'not_awarded',
                  updated_at = ?
              WHERE project_id = ?
              AND id != ?
              AND status = 'submitted'
            `)
            .bind(
              now(),
              bid.project_id,
              bidId
            )

        ]);

        return json({
          ok: true,
          bidId,
          status: "awarded",
          supplier:
            bid.supplier_name,
          note:
            "Award recorded from the buyer's action."
        });
      }

      /* =====================================================
         PURCHASE ORDER CREATE
      ===================================================== */

      if (
        path === "/api/purchase-orders" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        const bidId =
          num(data.bidId);

        if (!bidId) {
          return json(
            {
              error:
                "Bid ID required."
            },
            400
          );
        }

        const bid =
          await env.DB
            .prepare(`
              SELECT *
              FROM bids
              WHERE id = ?
              LIMIT 1
            `)
            .bind(bidId)
            .first();

        if (!bid) {
          return json(
            {
              error:
                "Bid not found."
            },
            404
          );
        }

        const project =
          bid.project_id
            ? await env.DB
                .prepare(`
                  SELECT *
                  FROM procurement_projects
                  WHERE id = ?
                  LIMIT 1
                `)
                .bind(bid.project_id)
                .first()
            : null;

        const poNumber =
          `NOVA-${new Date().getUTCFullYear()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;

        const totalValue =
          num(bid.quantity) *
          num(bid.unit_price);

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO purchase_orders
              (
                project_id,
                bid_id,
                user_id,
                po_number,
                supplier_name,
                product,
                quantity,
                unit_price,
                total_value,
                currency,
                destination,
                payment_terms,
                incoterm,
                status,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              bid.project_id || null,
              bidId,
              user?.id || null,
              poNumber,
              bid.supplier_name,
              project?.product || "",
              bid.quantity,
              bid.unit_price,
              totalValue,
              "USD",
              project?.destination || "",
              bid.payment_terms || "",
              bid.incoterm || "",
              "draft",
              now()
            )
            .run();

        return json({
          ok: true,
          purchaseOrderId:
            inserted.meta.last_row_id,
          poNumber,
          status: "draft",
          totalValue,
          note:
            "Draft purchase order generated. External order execution is not performed automatically."
        });
      }

      /* =====================================================
         PURCHASE ORDERS GET
      ===================================================== */

      if (
        path === "/api/purchase-orders" &&
        request.method === "GET"
      ) {

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        let result;

        if (user) {

          result =
            await env.DB
              .prepare(`
                SELECT *
                FROM purchase_orders
                WHERE user_id = ?
                OR user_id IS NULL
                ORDER BY id DESC
                LIMIT 100
              `)
              .bind(user.id)
              .all();

        } else {

          result =
            await env.DB
              .prepare(`
                SELECT *
                FROM purchase_orders
                WHERE user_id IS NULL
                ORDER BY id DESC
                LIMIT 100
              `)
              .all();
        }

        return json({
          ok: true,
          purchaseOrders:
            result?.results || []
        });
      }

      /* =====================================================
         PROCUREMENT MEMORY — SAVE
      ===================================================== */

      if (
        path === "/api/memory" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        let user;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          return json(
            {
              error:
                "Authentication required."
            },
            401
          );
        }

        const projectId =
          data.projectId
            ? num(data.projectId)
            : null;

        const memoryType =
          clean(
            data.type ||
            data.memoryType ||
            "preference",
            100
          );

        const memoryKey =
          clean(
            data.key ||
            data.memoryKey ||
            "",
            300
          );

        const memoryValue =
          clean(
            data.value ||
            data.memoryValue ||
            "",
            5000
          );

        if (!memoryKey || !memoryValue) {
          return json(
            {
              error:
                "Memory key and value required."
            },
            400
          );
        }

        const existing =
          await env.DB
            .prepare(`
              SELECT id
              FROM procurement_memory
              WHERE user_id = ?
              AND memory_key = ?
              LIMIT 1
            `)
            .bind(
              user.id,
              memoryKey
            )
            .first();

        if (existing) {

          await env.DB
            .prepare(`
              UPDATE procurement_memory
              SET
                project_id = ?,
                memory_type = ?,
                memory_value = ?,
                updated_at = ?
              WHERE id = ?
            `)
            .bind(
              projectId,
              memoryType,
              memoryValue,
              now(),
              existing.id
            )
            .run();

          return json({
            ok: true,
            memoryId: existing.id,
            updated: true
          });
        }

        const inserted =
          await env.DB
            .prepare(`
              INSERT INTO procurement_memory
              (
                user_id,
                project_id,
                memory_type,
                memory_key,
                memory_value,
                created_at,
                updated_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              user.id,
              projectId,
              memoryType,
              memoryKey,
              memoryValue,
              now(),
              now()
            )
            .run();

        return json({
          ok: true,
          memoryId:
            inserted.meta.last_row_id,
          updated: false
        });
      }

      /* =====================================================
         PROCUREMENT MEMORY — GET
      ===================================================== */

      if (
        path === "/api/memory" &&
        request.method === "GET"
      ) {

        let user;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          return json(
            {
              error:
                "Authentication required."
            },
            401
          );
        }

        const result =
          await env.DB
            .prepare(`
              SELECT *
              FROM procurement_memory
              WHERE user_id = ?
              ORDER BY updated_at DESC
              LIMIT 200
            `)
            .bind(user.id)
            .all();

        return json({
          ok: true,
          memory:
            result?.results || []
        });
      }

      /* =====================================================
         NEGOTIATION
      ===================================================== */

      if (
        path === "/api/negotiate" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const supplier =
          clean(
            data.supplier,
            1000
          );

        const offer =
          clean(
            data.offer,
            5000
          );

        const supplierReply =
          clean(
            data.reply ||
            data.supplierReply ||
            "",
            5000
          );

        const goal =
          clean(
            data.goal ||
            data.target ||
            "",
            3000
          );

        if (!offer && !supplierReply) {
          return json(
            {
              error:
                "Supplier offer or reply is required."
            },
            400
          );
        }

        const reply =
          await runAI(
            env,
            [
              {
                role: "system",

                content: `
You are NOVA, an expert global procurement negotiation agent.

Analyze the supplier's commercial offer and reply.

Create a professional negotiation response ready to send.

Protect the buyer's interests.

Do not invent supplier facts.
Do not claim verification that did not occur.
Do not make unrealistic claims.

Focus on:
- price
- MOQ
- payment terms
- lead time
- shipping
- quality
- samples
- long-term business potential

Return:
1. Brief analysis
2. Recommended negotiation position
3. Supplier message ready to send
`
              },

              {
                role: "user",

                content: `
Supplier:
${supplier || "Supplier"}

Original Offer:
${offer || "Not provided"}

Supplier Reply:
${supplierReply || "Not provided"}

Buyer's Goal:
${goal || "Obtain the strongest commercially reasonable offer."}
`
              }
            ]
          );

        let user = null;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          user = null;
        }

        await env.DB
          .prepare(`
            INSERT INTO negotiations
            (
              user_id,
              supplier,
              offer,
              reply,
              result,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?)
          `)
          .bind(
            user?.id || null,
            supplier,
            offer,
            supplierReply,
            reply,
            now()
          )
          .run();

        return json({
          ok: true,
          reply,
          result: reply,
          status: "generated"
        });
      }

      /* =====================================================
         NEGOTIATION HISTORY
      ===================================================== */

      if (
        path === "/api/negotiations" &&
        request.method === "GET"
      ) {

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                supplier,
                offer,
                reply,
                result,
                created_at
              FROM negotiations
              ORDER BY id DESC
              LIMIT 100
            `)
            .all();

        return json({
          ok: true,
          negotiations:
            result?.results || []
        });
      }

      /* =====================================================
         FLASH DEALS GET
      ===================================================== */

      if (
        path === "/api/deals" &&
        request.method === "GET"
      ) {

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                company,
                product,
                country,
                quantity,
                price,
                moq,
                description,
                url,
                status,
                created_at
              FROM deals
              ORDER BY id DESC
              LIMIT 100
            `)
            .all();

        return json({
          ok: true,
          deals:
            result?.results || [],
          message:
            result?.results?.length
              ? undefined
              : "No submitted deals yet."
        });
      }

      /* =====================================================
         FLASH DEALS POST
      ===================================================== */

      if (
        path === "/api/deals" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const company =
          clean(
            data.company ||
            data.supplier ||
            "",
            500
          );

        const product =
          clean(
            data.product ||
            "",
            1000
          );

        const country =
          clean(
            data.country ||
            "",
            300
          );

        const quantity =
          num(data.quantity);

        const price =
          num(data.price);

        const moq =
          num(data.moq);

        const description =
          clean(
            data.description ||
            data.snippet ||
            "",
            3000
          );

        const urlValue =
          clean(
            data.url ||
            "",
            2000
          );

        if (!product) {
          return json(
            {
              error:
                "Product required."
            },
            400
          );
        }

        await env.DB
          .prepare(`
            INSERT INTO deals
            (
              company,
              product,
              country,
              quantity,
              price,
              moq,
              description,
              url,
              status,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            company,
            product,
            country,
            quantity,
            price,
            moq,
            description,
            urlValue,
            "submitted",
            now()
          )
          .run();

        return json({
          ok: true,
          status: "submitted",
          message:
            "Deal submitted successfully."
        });
      }

      /* =====================================================
         PURCHASE HISTORY GET
      ===================================================== */

      if (
        path === "/api/purchases" &&
        request.method === "GET"
      ) {

        let user;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          return json(
            {
              error:
                "Authentication required."
            },
            401
          );
        }

        const result =
          await env.DB
            .prepare(`
              SELECT
                id,
                product,
                supplier,
                quantity,
                unit_price,
                landed_cost,
                created_at
              FROM purchases
              WHERE user_id = ?
              ORDER BY id DESC
              LIMIT 100
            `)
            .bind(user.id)
            .all();

        return json({
          ok: true,
          purchases:
            result?.results || []
        });
      }

      /* =====================================================
         PURCHASE HISTORY POST
      ===================================================== */

      if (
        path === "/api/purchases" &&
        request.method === "POST"
      ) {

        let user;

        try {
          user =
            await requireAuth(
              request,
              env
            );
        } catch {
          return json(
            {
              error:
                "Authentication required."
            },
            401
          );
        }

        const data =
          await getBody(request);

        const product =
          clean(data.product, 1000);

        const supplier =
          clean(data.supplier, 1000);

        const quantity =
          num(data.quantity);

        const unitPrice =
          num(data.unitPrice);

        const landedCost =
          num(data.landedCost);

        if (!product) {
          return json(
            {
              error:
                "Product required."
            },
            400
          );
        }

        await env.DB
          .prepare(`
            INSERT INTO purchases
            (
              user_id,
              product,
              supplier,
              quantity,
              unit_price,
              landed_cost,
              created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            user.id,
            product,
            supplier,
            quantity,
            unitPrice,
            landedCost,
            now()
          )
          .run();

        return json({
          ok: true,
          message:
            "Purchase saved successfully."
        });
      }

      /* =====================================================
         SYSTEM STATUS
      ===================================================== */

      if (
        path === "/api/status" &&
        request.method === "GET"
      ) {

        const checks = {
          database: Boolean(env.DB),
          ai: Boolean(env.AI),
          yep: Boolean(env.YEP_API_KEY)
        };

        return json({
          ok:
            checks.database &&
            checks.ai &&
            checks.yep,

          nova: "2.0",

          modules: {
            supplierIntelligence: true,
            supplierEvidence: true,
            supplierRiskFramework: true,
            procurementProjects: true,
            rfqManagement: true,
            bidManagement: true,
            bidComparison: true,
            purchaseOrders: true,
            procurementMemory: true,
            aiNegotiation: true,
            landedCost: true
          },

          integrations: {
            yepSearch:
              checks.yep,
            cloudflareAI:
              checks.ai,
            cloudflareD1:
              checks.database
          }
        });
      }

      /* =====================================================
         STATIC WEBSITE
      ===================================================== */

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "NOVA Procurement AI is running.",
        {
          status: 200,
          headers: {
            "Content-Type":
              "text/plain"
          }
        }
      );

    } catch (error) {

      console.error(error);

      return json(
        {
          ok: false,
          error:
            error?.message ||
            "Internal server error."
        },
        500
      );
    }
  }
};
