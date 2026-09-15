const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      ...extraHeaders
    }
  });
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    new RegExp("(^|;\\s*)" + name + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[2]) : null;
}

function randomToken() {
  return crypto.randomUUID() + crypto.randomUUID();
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function passwordHash(password, salt) {
  return sha256(salt + ":" + password);
}

async function ensureDB(db) {
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
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
      CREATE TABLE IF NOT EXISTS negotiations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        supplier TEXT,
        offer TEXT,
        result TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `)
  ]);
}

async function currentUser(request, db) {
  if (!db) return null;

  const token = cookieValue(request, "nova_session");
  if (!token) return null;

  return await db.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
    AND sessions.expires_at > ?
  `).bind(token, Date.now()).first();
}

function sessionCookie(token) {
  return `nova_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function parsePrice(text) {
  const match = String(text || "").match(/\$\s?(\d+(?:\.\d+)?)/);
  return match ? Number(match[1]) : null;
}

function parseMOQ(text) {
  const match = String(text || "").match(
    /(?:MOQ|minimum order quantity|min(?:imum)? order)\D{0,30}([\d,]+)/i
  );

  return match ? Number(match[1].replace(/,/g, "")) : null;
}

function parseLeadTime(text) {
  const match = String(text || "").match(
    /(\d+(?:\s*-\s*\d+)?)\s*(?:days|day|weeks|week)/i
  );

  return match ? match[0] : null;
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
    (score, word) => score + (s.includes(word) ? 1 : 0),
    0
  );
}

function evidenceScore(text) {
  const s = String(text || "").toLowerCase();
  let score = 0;

  if (s.includes("$")) score += 10;
  if (s.includes("moq")) score += 10;
  if (s.includes("minimum order")) score += 10;
  if (s.includes("shipping")) score += 5;
  if (s.includes("lead time")) score += 5;
  if (s.includes("manufacturer")) score += 5;
  if (s.includes("factory")) score += 5;
  if (s.includes("oem")) score += 5;
  if (s.includes("odm")) score += 5;

  return Math.min(score, 50);
}

function dealScore(supplierSignal, evidence, price, moq) {
  let score = 50;

  score += supplierSignal * 3;
  score += evidence;

  if (price !== null) score += 5;
  if (moq !== null) score += 5;

  return Math.min(100, score);
}

async function searchSuppliers(requestText, env) {

  if (!env.YEP_API_KEY) {
    return {
      ok: false,
      error: "YEP_API_KEY is missing in Cloudflare."
    };
  }

  const cleanRequest = String(requestText || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 700);

  const searchQuery = `
    ${cleanRequest}
    manufacturer supplier factory wholesale
    OEM ODM exporter bulk custom logo
    MOQ minimum order quantity
    unit price USD quotation
    production lead time shipping
  `.replace(/\s+/g, " ").trim();

  try {

    const response = await fetch(
      "https://platform.yep.com/api/search",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${env.YEP_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          query: searchQuery,
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
      return {
        ok: false,
        error: `Yep returned invalid response. HTTP ${response.status}`
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: data.error || `Yep HTTP ${response.status}`,
        request_id: data.request_id || null
      };
    }

    const rawResults = Array.isArray(data.results)
      ? data.results
      : [];

    const results = rawResults
      .map((r, index) => {

        const title =
          r.title ||
          r.name ||
          `Supplier ${index + 1}`;

        const url =
          r.url ||
          r.link ||
          "";

        const snippet =
          r.snippet ||
          r.description ||
          r.text ||
          "";

        const combined = `${title} ${snippet}`;

        const price = parsePrice(combined);
        const moq = parseMOQ(combined);
        const leadTime = parseLeadTime(combined);
        const supplierSignal = supplierSignals(combined);
        const evidence = evidenceScore(combined);

        return {
          title,
          url,
          snippet,
          price,
          moq,
          leadTime,
          shipping: null,
          supplierSignal,
          evidence,
          dealScore: dealScore(
            supplierSignal,
            evidence,
            price,
            moq
          ),
          productCost: price
        };
      })
      .filter(r => r.url);

    return {
      ok: true,
      results,
      total: results.length,
      query: data.query || searchQuery,
      yepSuccess: data.success === true,
      request_id: data.request_id || null
    };

  } catch (error) {

    return {
      ok: false,
      error: `Connection to Yep failed: ${error.message}`
    };
  }
}

async function negotiate(supplier, offer, env) {

  const prompt = `
You are NOVA, an AI procurement negotiation agent.

Supplier: ${supplier}
Current supplier offer: ${offer}

Give:
1. Target price
2. Suggested counteroffer
3. Negotiation message
4. MOQ strategy
5. Shipping strategy
6. Payment strategy
7. Main risks
8. Final recommendation

Do not invent supplier facts.
`;

  const result = await env.AI.run(MODEL, {
    messages: [
      {
        role: "system",
        content: "You are NOVA, an expert procurement and sourcing AI."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    max_tokens: 1000
  });

  return result.response || "No negotiation response generated.";
}

export default {

  async fetch(request, env) {

    const url = new URL(request.url);
    const path = url.pathname;

    try {

      if (env.DB) {
        await ensureDB(env.DB);
      }

      // SEARCH
      if (
        path === "/api/search" &&
        request.method === "POST"
      ) {

        const body = await request.json();

        const requestText =
          String(body.request || "").trim();

        if (!requestText) {
          return json({
            ok: false,
            error: "Please enter a procurement request."
          }, 400);
        }

        const result =
          await searchSuppliers(requestText, env);

        /*
          مهم:
          نعيد 200 حتى يستطيع الموقع عرض رسالة الخطأ الحقيقية
          بدل Search failed فقط.
        */

        return json(result, 200);
      }

      // SIGNUP
      if (
        path === "/api/signup" &&
        request.method === "POST"
      ) {

        const body = await request.json();

        const email =
          String(body.email || "").trim().toLowerCase();

        const password =
          String(body.password || "");

        if (!email || !password) {
          return json({
            error: "Email and password are required."
          }, 400);
        }

        if (password.length < 6) {
          return json({
            error: "Password must be at least 6 characters."
          }, 400);
        }

        const exists = await env.DB
          .prepare("SELECT id FROM users WHERE email = ?")
          .bind(email)
          .first();

        if (exists) {
          return json({
            error: "Account already exists."
          }, 409);
        }

        const salt = randomToken();
        const hash =
          await passwordHash(password, salt);

        const result = await env.DB
          .prepare(`
            INSERT INTO users
            (email, password_hash, salt)
            VALUES (?, ?, ?)
          `)
          .bind(email, hash, salt)
          .run();

        const token = randomToken();

        await env.DB
          .prepare(`
            INSERT INTO sessions
            (token, user_id, expires_at)
            VALUES (?, ?, ?)
          `)
          .bind(
            token,
            result.meta.last_row_id,
            Date.now() + 604800000
          )
          .run();

        return json(
          {
            success: true,
            email
          },
          200,
          {
            "Set-Cookie": sessionCookie(token)
          }
        );
      }

      // LOGIN
      if (
        path === "/api/login" &&
        request.method === "POST"
      ) {

        const body = await request.json();

        const email =
          String(body.email || "").trim().toLowerCase();

        const password =
          String(body.password || "");

        const user = await env.DB
          .prepare(`
            SELECT id, email, password_hash, salt
            FROM users
            WHERE email = ?
          `)
          .bind(email)
          .first();

        if (!user) {
          return json({
            error: "Invalid email or password."
          }, 401);
        }

        const hash =
          await passwordHash(password, user.salt);

        if (hash !== user.password_hash) {
          return json({
            error: "Invalid email or password."
          }, 401);
        }

        const token = randomToken();

        await env.DB
          .prepare(`
            INSERT INTO sessions
            (token, user_id, expires_at)
            VALUES (?, ?, ?)
          `)
          .bind(
            token,
            user.id,
            Date.now() + 604800000
          )
          .run();

        return json(
          {
            success: true,
            email: user.email
          },
          200,
          {
            "Set-Cookie": sessionCookie(token)
          }
        );
      }

      // LOGOUT
      if (path === "/api/logout") {

        const token =
          cookieValue(request, "nova_session");

        if (token && env.DB) {
          await env.DB
            .prepare(
              "DELETE FROM sessions WHERE token = ?"
            )
            .bind(token)
            .run();
        }

        return json(
          { success: true },
          200,
          {
            "Set-Cookie": clearSessionCookie()
          }
        );
      }

      // ME
      if (path === "/api/me") {

        const user =
          await currentUser(request, env.DB);

        return json({
          loggedIn: !!user,
          user: user || null
        });
      }

      // SAVE PURCHASE
      if (
        path === "/api/purchases" &&
        request.method === "POST"
      ) {

        const user =
          await currentUser(request, env.DB);

        if (!user) {
          return json({
            error: "Please login first."
          }, 401);
        }

        const body = await request.json();

        await env.DB
          .prepare(`
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
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            user.id,
            body.product || "",
            body.supplier || "",
            Number(body.quantity) || 0,
            Number(body.unitPrice) || 0,
            Number(body.shipping) || 0,
            Number(body.landedCost) || 0,
            body.supplierUrl || ""
          )
          .run();

        return json({ success: true });
      }

      // GET PURCHASES
      if (
        path === "/api/purchases" &&
        request.method === "GET"
      ) {

        const user =
          await currentUser(request, env.DB);

        if (!user) {
          return json({
            error: "Please login first."
          }, 401);
        }

        const rows = await env.DB
          .prepare(`
            SELECT *
            FROM purchases
            WHERE user_id = ?
            ORDER BY id DESC
          `)
          .bind(user.id)
          .all();

        return json({
          purchases: rows.results || []
        });
      }

      // NEGOTIATION
      if (
        path === "/api/negotiate" &&
        request.method === "POST"
      ) {

        const body = await request.json();

        const supplier =
          String(body.supplier || "").trim();

        const offer =
          String(body.offer || "").trim();

        if (!supplier || !offer) {
          return json({
            error: "Supplier and offer are required."
          }, 400);
        }

        const result =
          await negotiate(supplier, offer, env);

        const user =
          await currentUser(request, env.DB);

        if (user) {
          await env.DB
            .prepare(`
              INSERT INTO negotiations
              (user_id, supplier, offer, result)
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              user.id,
              supplier,
              offer,
              result
            )
            .run();
        }

        return json({
          success: true,
          result
        });
      }

      return env.ASSETS.fetch(request);

    } catch (error) {

      return json({
        ok: false,
        error: error.message || "Server error."
      }, 500);
    }
  }
};
