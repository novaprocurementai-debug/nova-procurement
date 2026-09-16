const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

/* =========================================================
   BASIC HELPERS
========================================================= */

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
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
   SESSION HELPERS
========================================================= */

function getCookie(request, name) {
  const cookie =
    request.headers.get("Cookie") || "";

  const parts = cookie.split(";");

  for (const part of parts) {
    const [key, ...rest] =
      part.trim().split("=");

    if (key === name) {
      return decodeURIComponent(
        rest.join("=")
      );
    }
  }

  return null;
}

function sessionCookie(id, maxAge = 60 * 60 * 24 * 30) {
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
   EVIDENCE / DEAL SCORING
========================================================= */

function evidenceScore(text) {
  const value =
    String(text || "").toLowerCase();

  let score = 0;

  if (
    value.includes("supplier") ||
    value.includes("factory") ||
    value.includes("manufacturer")
  ) {
    score += 10;
  }

  if (
    value.includes("wholesale") ||
    value.includes("bulk")
  ) {
    score += 10;
  }

  if (
    value.includes("oem") ||
    value.includes("odm") ||
    value.includes("custom")
  ) {
    score += 10;
  }

  if (
    value.includes("moq") ||
    value.includes("minimum order")
  ) {
    score += 10;
  }

  if (
    value.includes("price") ||
    value.includes("usd") ||
    value.includes("$") ||
    value.includes("quotation")
  ) {
    score += 10;
  }

  if (
    value.includes("lead time") ||
    value.includes("shipping") ||
    value.includes("delivery")
  ) {
    score += 10;
  }

  return Math.min(score, 50);
}

function dealScore(text) {
  const value =
    String(text || "").toLowerCase();

  let score = 0;

  if (
    value.includes("factory") ||
    value.includes("manufacturer")
  ) {
    score += 15;
  }

  if (
    value.includes("wholesale") ||
    value.includes("bulk")
  ) {
    score += 10;
  }

  if (
    value.includes("oem") ||
    value.includes("odm")
  ) {
    score += 5;
  }

  if (
    value.includes("custom") ||
    value.includes("custom logo")
  ) {
    score += 5;
  }

  return Math.min(score, 35);
}

function countryFromText(text) {
  const value =
    String(text || "").toLowerCase();

  if (
    value.includes("china") ||
    value.includes("shenzhen") ||
    value.includes("guangzhou") ||
    value.includes("yiwu") ||
    value.includes("ningbo")
  ) {
    return "China";
  }

  if (
    value.includes("india") ||
    value.includes("delhi") ||
    value.includes("mumbai") ||
    value.includes("bangalore")
  ) {
    return "India";
  }

  if (
    value.includes("japan") ||
    value.includes("tokyo") ||
    value.includes("osaka")
  ) {
    return "Japan";
  }

  if (
    value.includes("south korea") ||
    value.includes("korea") ||
    value.includes("seoul")
  ) {
    return "South Korea";
  }

  if (
    value.includes("germany") ||
    value.includes("france") ||
    value.includes("italy") ||
    value.includes("spain") ||
    value.includes("netherlands") ||
    value.includes("europe")
  ) {
    return "Europe";
  }

  if (
    value.includes("usa") ||
    value.includes("united states") ||
    value.includes("america")
  ) {
    return "North America";
  }

  return "Global";
}

/* =========================================================
   NORMALIZE SEARCH RESULTS
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
   RFQ BUILDER
   Exact buyer information is preserved.
========================================================= */

async function generateRFQ(
  env,
  product,
  quantity,
  destination,
  requirements
) {

  /*
    AI is used only to improve the commercial wording.
    The exact buyer data is inserted separately so the AI
    cannot replace Dubai, UAE or change the quantity.
  */

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

Do NOT change or repeat the buyer's product,
quantity, destination or specifications.

Do NOT invent facts.

Do NOT use placeholders.

Return 4 to 6 concise bullet points only.

Focus on:
- best unit price
- MOQ
- production lead time
- sample availability
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
      `- Best unit price based on the requested quantity
- MOQ and available quantity discounts
- Production lead time
- Sample availability and cost
- Payment terms
- Shipping terms and Incoterms`;
  }

  /*
    Remove accidental placeholder text if AI produces it.
  */

  commercialQuestions =
    String(commercialQuestions || "")
      .replace(
        /\[Insert[^\]]*\]/gi,
        ""
      )
      .trim();

  const rfq = `Dear Supplier,

REQUEST FOR QUOTATION (RFQ)

We are looking for a reliable manufacturer or supplier and would like to receive your best commercial quotation for the following requirement.

PRODUCT
${product}

QUANTITY
${quantity} units

DESTINATION
${destination}

PRODUCT SPECIFICATIONS
${requirements || "Please quote according to the product description above and clearly state the specifications of the offered product."}

CUSTOMIZATION
Please confirm whether customization is available and clearly specify any additional cost, minimum quantity and production requirements.

PACKAGING
Please provide your available packaging options and confirm whether individual packaging can be provided according to the requested requirements.

PRICE REQUEST
Please provide your best competitive unit price based on the requested quantity.

Please provide a clear price breakdown where applicable, including:
- Unit price
- Packaging cost
- Customization cost
- Sample cost
- Any other applicable charges

MOQ
Please confirm your minimum order quantity.

PRODUCTION LEAD TIME
Please confirm the production lead time after order confirmation and artwork/specification approval, where applicable.

SAMPLE
Please confirm sample availability, sample cost and sample lead time.

CERTIFICATIONS / COMPLIANCE
Please provide all relevant certifications and compliance documents applicable to the offered product.

SHIPPING
Please provide available shipping options to:

${destination}

Please also state your available Incoterms, such as EXW, FOB, CIF, DDP or other applicable terms.

PAYMENT TERMS
Please provide your available payment terms and accepted payment methods.

QUOTATION VALIDITY
Please clearly state the validity period of your quotation.

SUPPLIER INFORMATION
Please include your:
- Company name
- Factory/manufacturer status
- Company location
- Years of experience
- Main export markets
- Product catalogue or website
- Relevant certifications

ADDITIONAL COMMERCIAL QUESTIONS
${commercialQuestions}

Please provide a complete quotation with all applicable costs and conditions so we can evaluate the offer accurately.

We look forward to receiving your best quotation and building a long-term business relationship.

Best regards,

NOVA Procurement
AI Purchasing Agent
`;

  return rfq.trim();
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

      /* -----------------------------------------------------
         DATABASE
      ----------------------------------------------------- */

      await ensureDatabase(env);

      /* -----------------------------------------------------
         CORS / OPTIONS
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
              SELECT
                id,
                email
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

        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: user.id,
              email: user.email
            }
          }),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store",
              "Set-Cookie":
                sessionCookie(sessionId)
            }
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

        return new Response(
          JSON.stringify({
            ok: true
          }),
          {
            status: 200,
            headers: {
              "Content-Type":
                "application/json",
              "Cache-Control":
                "no-store",
              "Set-Cookie":
                clearSessionCookie()
            }
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
            user: {
              id: user.id,
              email: user.email
            }
          });

        } catch {

          return json({
            ok: false,
            user: null
          });
        }
      }

      /* =====================================================
         GLOBAL PROCUREMENT NETWORK
      ===================================================== */

      if (
        path === "/api/network" &&
        request.method === "GET"
      ) {

        return json({
          ok: true,
          actualRecords: 20,
          targetRecords: 20000000,

          coverage: [
            "China",
            "India",
            "Japan",
            "South Korea",
            "Europe",
            "North America"
          ],

          status:
            "Live supplier discovery through external search sources."
        });
      }

      /* =====================================================
         SUPPLIER SEARCH
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
         AI RFQ
      ===================================================== */

      if (
        path === "/api/rfq" &&
        request.method === "POST"
      ) {

        const data =
          await getBody(request);

        const product =
          clean(
            data.product,
            1000
          );

        const quantity =
          num(data.quantity);

        const destination =
          clean(
            data.destination,
            300
          );

        const requirements =
          clean(
            data.requirements,
            3000
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
         AI NEGOTIATION
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

        const goal =
          clean(
            data.goal ||
            data.target ||
            "",
            3000
          );

        if (!offer) {
          return json(
            {
              error:
                "Supplier offer is required."
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

Analyze the supplier offer and create a professional,
firm but respectful negotiation response.

Protect the buyer's commercial interests.

Do not invent supplier facts.

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

Write a message ready to send to the supplier.
`
              },

              {
                role: "user",

                content: `
Supplier:
${supplier || "Supplier"}

Supplier Offer:
${offer}

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
            reply,
            "generated",
            now()
          )
          .run();

        return json({
          ok: true,
          reply,
          result: "generated"
        });
      }

      /* =====================================================
         FLASH DEALS - GET
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

        const deals =
          result?.results || [];

        if (!deals.length) {
          return json({
            ok: true,
            deals: [],
            message:
              "No submitted deals yet."
          });
        }

        return json({
          ok: true,
          deals
        });
      }

      /* =====================================================
         FLASH DEALS - POST
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
         PURCHASE HISTORY - GET
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
         PURCHASE HISTORY - POST
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
          clean(
            data.product,
            1000
          );

        const supplier =
          clean(
            data.supplier,
            1000
          );

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
         STATIC WEBSITE
      ===================================================== */

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return new Response(
        "NOVA is running.",
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
