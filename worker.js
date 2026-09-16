const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function clean(value, max = 10000) {
  return String(value ?? "").trim().slice(0, max);
}

function number(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function extractPrice(text) {
  const s = String(text || "");
  const patterns = [
    /\$\s?(\d+(?:\.\d{1,2})?)/,
    /USD\s?(\d+(?:\.\d{1,2})?)/i,
    /(\d+(?:\.\d{1,2})?)\s?USD/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m) return Number(m[1]);
  }

  return null;
}

function extractMOQ(text) {
  const s = String(text || "");

  const patterns = [
    /MOQ\s*[:\-]?\s*([\d,]+)/i,
    /minimum order(?: quantity)?\s*[:\-]?\s*([\d,]+)/i,
    /min(?:imum)?\s*order\s*[:\-]?\s*([\d,]+)/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m) return Number(m[1].replace(/,/g, ""));
  }

  return null;
}

function extractLead(text) {
  const s = String(text || "");

  const patterns = [
    /(\d+\s*(?:-\s*\d+)?\s*(?:days?|weeks?))/i,
    /(lead time[^.]{0,80})/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m) return m[1].trim();
  }

  return "Not verified";
}

function evidenceScore(item) {
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();

  let score = 0;

  if (/manufacturer|factory|supplier|wholesale/.test(text)) score += 10;
  if (/oem|odm|custom/.test(text)) score += 10;
  if (/moq|minimum order/.test(text)) score += 10;
  if (/price|\$|usd/.test(text)) score += 10;
  if (/lead time|production|shipping|delivery/.test(text)) score += 10;

  return Math.min(50, score);
}

function dealScore(item) {
  const evidence = evidenceScore(item);
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();

  let score = evidence;

  if (/factory|manufacturer/.test(text)) score += 15;
  if (/wholesale|bulk/.test(text)) score += 10;
  if (/oem|odm/.test(text)) score += 5;
  if (/custom/.test(text)) score += 5;

  return Math.min(100, score);
}

function confidence(item) {
  const e = evidenceScore(item);
  return Math.min(98, Math.round(e * 1.7));
}

function countryFromText(item) {
  const text = `${item.title || ""} ${item.snippet || ""}`.toLowerCase();

  if (/china|chinese|zhejiang|shenzhen|guangzhou|wuhan/.test(text))
    return "China";

  if (/india|indian/.test(text))
    return "India";

  if (/japan|japanese/.test(text))
    return "Japan";

  if (/korea|korean/.test(text))
    return "South Korea";

  if (/germany|france|italy|spain|europe/.test(text))
    return "Europe";

  if (/usa|united states|american/.test(text))
    return "United States";

  return "Not verified";
}

function normalizeSearchResult(item) {
  const title = item.title || item.name || "Supplier result";
  const snippet =
    item.snippet ||
    item.description ||
    item.content ||
    "";

  const url =
    item.url ||
    item.link ||
    item.href ||
    "#";

  const combined = `${title} ${snippet}`;

  const price = extractPrice(combined);
  const moq = extractMOQ(combined);

  const evidence = evidenceScore({
    title,
    snippet
  });

  return {
    title,
    url,
    snippet,
    country: countryFromText({ title, snippet }),
    region: countryFromText({ title, snippet }),
    price,
    moq,
    leadTime: extractLead(combined),
    evidence,
    confidence: confidence({ title, snippet }),
    dealScore: dealScore({ title, snippet })
  };
}

async function yepSearch(env, query) {
  if (!env.YEP_API_KEY) {
    throw new Error("YEP_API_KEY is not configured.");
  }

  const response = await fetch(
    "https://platform.yep.com/api/search",
    {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.YEP_API_KEY}`,
        "Content-Type": "application/json"
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

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Yep search returned invalid JSON (${response.status}).`);
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

async function requireAuth(request, env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/nova_session=([^;]+)/);

  if (!match) return null;

  const session = await env.DB.prepare(`
    SELECT
      sessions.id,
      sessions.user_id,
      sessions.expires_at,
      users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.id = ?
  `).bind(match[1]).first();

  if (!session) return null;

  if (
    session.expires_at &&
    Number(session.expires_at) < Date.now()
  ) {
    return null;
  }

  return {
    id: session.user_id,
    email: session.email
  };
}

async function hashPassword(password) {
  const data = new TextEncoder().encode(password);

  const hash = await crypto.subtle.digest(
    "SHA-256",
    data
  );

  return [...new Uint8Array(hash)]
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureDatabase(env) {
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

async function ai(env, messages) {
  if (!env.AI) {
    throw new Error("Workers AI is not configured.");
  }

  const result = await env.AI.run(MODEL, {
    messages,
    max_tokens: 1200,
    temperature: 0.2
  });

  return (
    result?.response ||
    result?.result?.response ||
    JSON.stringify(result)
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (env.DB) {
        await ensureDatabase(env);
      }

      /* =========================
         ACCOUNT
      ========================= */

      if (path === "/api/signup" && request.method === "POST") {
        const data = await body(request);

        const email = clean(data.email, 200).toLowerCase();
        const password = clean(data.password, 200);

        if (!email || !email.includes("@")) {
          return json({ error: "Valid email required." }, 400);
        }

        if (password.length < 6) {
          return json(
            { error: "Password must be at least 6 characters." },
            400
          );
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(email).first();

        if (existing) {
          return json(
            { error: "Account already exists." },
            409
          );
        }

        const passwordHash = await hashPassword(password);

        const result = await env.DB.prepare(`
          INSERT INTO users
          (email, password_hash, created_at)
          VALUES (?, ?, ?)
        `).bind(
          email,
          passwordHash,
          Date.now()
        ).run();

        return json({
          ok: true,
          id: result.meta.last_row_id,
          email
        });
      }

      if (path === "/api/login" && request.method === "POST") {
        const data = await body(request);

        const email = clean(data.email, 200).toLowerCase();
        const password = clean(data.password, 200);

        const user = await env.DB.prepare(`
          SELECT id, email, password_hash
          FROM users
          WHERE email = ?
        `).bind(email).first();

        if (!user) {
          return json({ error: "Invalid email or password." }, 401);
        }

        const passwordHash = await hashPassword(password);

        if (passwordHash !== user.password_hash) {
          return json({ error: "Invalid email or password." }, 401);
        }

        const sessionId = crypto.randomUUID();
        const expiresAt =
          Date.now() + 7 * 24 * 60 * 60 * 1000;

        await env.DB.prepare(`
          INSERT INTO sessions
          (id, user_id, expires_at, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(
          sessionId,
          user.id,
          expiresAt,
          Date.now()
        ).run();

        return new Response(
          JSON.stringify({
            ok: true,
            email: user.email
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie":
                `nova_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`
            }
          }
        );
      }

      if (path === "/api/logout" && request.method === "POST") {
        const cookie = request.headers.get("Cookie") || "";
        const match = cookie.match(/nova_session=([^;]+)/);

        if (match) {
          await env.DB.prepare(
            "DELETE FROM sessions WHERE id = ?"
          ).bind(match[1]).run();
        }

        return new Response(
          JSON.stringify({ ok: true }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie":
                "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0"
            }
          }
        );
      }

      if (path === "/api/me" && request.method === "GET") {
        const user = await requireAuth(request, env);

        return json({
          loggedIn: !!user,
          user: user
            ? {
                id: user.id,
                email: user.email
              }
            : null
        });
      }

      /* =========================
         NETWORK STATUS
      ========================= */

      if (path === "/api/network" && request.method === "GET") {
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
          status: "Live supplier discovery through external search sources."
        });
      }

      /* =========================
         SUPPLIER SEARCH
      ========================= */

      if (path === "/api/search" && request.method === "POST") {
        const data = await body(request);

        const cleanRequest = clean(data.request, 2000);

        if (!cleanRequest) {
          return json(
            { error: "Procurement request required." },
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
        `.replace(/\s+/g, " ").trim();

        const yep = await yepSearch(env, searchQuery);

        const rawResults = Array.isArray(yep.results)
          ? yep.results
          : [];

        const results = rawResults
          .map(normalizeSearchResult)
          .slice(0, 20);

        return json({
          ok: true,
          total: results.length,
          results,
          query: searchQuery,
          yepSuccess: yep.yepSuccess ?? true,
          request_id: yep.request_id ?? null
        });
      }

      /* =========================
         RFQ
      ========================= */

      if (path === "/api/rfq" && request.method === "POST") {
        const data = await body(request);

        const product = clean(data.product, 1000);
        const quantity = number(data.quantity);
        const destination = clean(data.destination, 300);
        const requirements = clean(data.requirements, 3000);

        if (!product) {
          return json(
            { error: "Product required." },
            400
          );
        }

        const message = await ai(env, [
          {
            role: "system",
            content:
              "You are NOVA, a professional global procurement agent. Create concise, commercially strong RFQs for factories and suppliers. Include specifications, quantity, destination, price request, MOQ, lead time, payment terms, packaging, certifications, samples, shipping terms and validity. Never invent missing product facts."
          },
          {
            role: "user",
            content: `
Product: ${product}
Quantity: ${quantity}
Destination: ${destination}
Requirements: ${requirements}

Create a professional supplier RFQ ready to send.
            `
          }
        ]);

        return json({
          ok: true,
          message
        });
      }

      /* =========================
         LANDED COST
      ========================= */

      if (
        path === "/api/landed-cost" &&
        request.method === "POST"
      ) {
        const quantity = number((await body(request)).quantity);
        const data = await bodyFromRequestCache;

        return json(data);
      }

      /* =========================
         NEGOTIATION
      ========================= */

      if (
        path === "/api/negotiate" &&
        request.method === "POST"
      ) {
        const data = await body(request);

        const supplier = clean(data.supplier, 1000);
        const offer = clean(data.offer, 5000);
        const reply = clean(data.reply, 5000);

        if (!offer) {
          return json(
            { error: "Supplier offer required." },
            400
          );
        }

        const result = await ai(env, [
          {
            role: "system",
            content:
              "You are NOVA's procurement negotiation agent. Analyze supplier offers commercially. Identify weaknesses, missing facts, negotiation leverage, target price logic, MOQ opportunities, shipping/payment improvements, and write a professional counter-offer. Never invent market facts or claim verification without evidence."
          },
          {
            role: "user",
            content: `
Supplier: ${supplier}
Current offer:
${offer}

Supplier reply:
${reply}

Return:
1. Offer analysis
2. Missing information
3. Negotiation strategy
4. Suggested target
5. Professional counter-offer message
            `
          }
        ]);

        const user = await requireAuth(request, env);

        if (env.DB) {
          await env.DB.prepare(`
            INSERT INTO negotiations
            (user_id, supplier, offer, reply, result, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).bind(
            user?.id ?? null,
            supplier,
            offer,
            reply,
            result,
            Date.now()
          ).run();
        }

        return json({
          ok: true,
          result
        });
      }

      /* =========================
         FLASH DEALS
      ========================= */

      if (path === "/api/deals" && request.method === "GET") {
        const result = await env.DB.prepare(`
          SELECT *
          FROM deals
          ORDER BY created_at DESC
          LIMIT 100
        `).all();

        return json({
          ok: true,
          deals: result.results || []
        });
      }

      if (path === "/api/deals" && request.method === "POST") {
        const data = await body(request);

        const company = clean(data.company, 500);
        const product = clean(data.product, 1000);
        const country = clean(data.country, 200);
        const quantity = number(data.quantity);
        const price = number(data.price);
        const moq = number(data.moq);
        const description = clean(data.description, 3000);
        const sourceUrl = clean(data.url, 2000);

        if (!company || !product) {
          return json(
            { error: "Company and product are required." },
            400
          );
        }

        const result = await env.DB.prepare(`
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
        `).bind(
          company,
          product,
          country,
          quantity,
          price,
          moq,
          description,
          sourceUrl,
          "submitted",
          Date.now()
        ).run();

        return json({
          ok: true,
          id: result.meta.last_row_id,
          status: "submitted"
        });
      }

      /* =========================
         PURCHASE HISTORY
      ========================= */

      if (
        path === "/api/purchases" &&
        request.method === "GET"
      ) {
        const user = await requireAuth(request, env);

        if (!user) {
          return json({
            ok: true,
            purchases: [],
            message: "Login required to view purchase history."
          });
        }

        const result = await env.DB.prepare(`
          SELECT *
          FROM purchases
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT 100
        `).bind(user.id).all();

        return json({
          ok: true,
          purchases: result.results || []
        });
      }

      if (
        path === "/api/purchases" &&
        request.method === "POST"
      ) {
        const user = await requireAuth(request, env);

        if (!user) {
          return json(
            { error: "Login required." },
            401
          );
        }

        const data = await body(request);

        const product = clean(data.product, 1000);
        const supplier = clean(data.supplier, 1000);
        const quantity = number(data.quantity);
        const unitPrice = number(data.unit_price);
        const landedCost = number(data.landed_cost);

        await env.DB.prepare(`
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
        `).bind(
          user.id,
          product,
          supplier,
          quantity,
          unitPrice,
          landedCost,
          Date.now()
        ).run();

        return json({
          ok: true
        });
      }

      /* =========================
         STATIC ASSETS
      ========================= */

      if (env.ASSETS) {
        return env.ASSETS.fetch(request);
      }

      return json(
        {
          error: "Not found",
          path
        },
        404
      );

    } catch (error) {
      console.error(error);

      return json(
        {
          error: error?.message || "Server error"
        },
        500
      );
    }
  }
};
