const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=UTF-8",
      ...extra
    }
  });
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(
    new RegExp("(?:^|;\\s*)" + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "=([^;]*)")
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function randomToken(bytes = 32) {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return [...arr].map(x => x.toString(16).padStart(2, "0")).join("");
}

async function sha256(text) {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)]
    .map(x => x.toString(16).padStart(2, "0"))
    .join("");
}

async function passwordHash(password, salt) {
  return sha256(`${salt}:${password}`);
}

async function ensureDB(env) {
  if (!env.DB) return;

  await env.DB.batch([
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS purchases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product TEXT,
        supplier TEXT,
        quantity INTEGER,
        unit_price REAL,
        shipping_cost REAL,
        landed_cost REAL,
        supplier_url TEXT,
        created_at TEXT NOT NULL
      )
    `),
    env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS negotiations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        purchase_id INTEGER,
        supplier TEXT,
        offer TEXT,
        reply TEXT,
        analysis TEXT,
        created_at TEXT NOT NULL
      )
    `)
  ]);
}

async function currentUser(request, env) {
  if (!env.DB) return null;

  const token = cookieValue(request, "nova_session");
  if (!token) return null;

  return await env.DB.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token = ?
      AND sessions.expires_at > ?
  `).bind(token, new Date().toISOString()).first();
}

function sessionCookie(token) {
  return `nova_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return `nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/* =========================
   QUANTITY
========================= */

function extractQuantity(text) {
  const s = String(text || "").replace(/,/g, "");

  const patterns = [
    /\b(\d+(?:\.\d+)?)\s*(?:pcs|pieces|units|unit|items|bottles|sets)\b/i,
    /\b(\d+(?:\.\d+)?)\s*(?:kg|tons|ton)\b/i,
    /\bquantity\s*[:=]?\s*(\d+(?:\.\d+)?)/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }

  return null;
}

/* =========================
   PRICE
========================= */

function parsePrice(text) {
  const s = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "");

  const patterns = [
    /(?:US\$|\$)\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(?:US\$|\$)?\s*(\d+(?:\.\d+)?)/i,

    /USD\s*(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(?:USD\s*)?(\d+(?:\.\d+)?)/i,

    /(\d+(?:\.\d+)?)\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*USD/i,

    /(?:price|unit price|price per piece|price\/pc|price\/piece)[^$0-9]{0,30}(?:US\$|\$|USD)?\s*(\d+(?:\.\d+)?)/i,

    /(?:US\$|\$)\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(?:pc|pcs|piece|unit))?/i,

    /(\d+(?:\.\d+)?)\s*USD\s*(?:\/\s*(?:pc|pcs|piece|unit))?/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (!m) continue;

    if (m[2]) {
      const a = Number(m[1]);
      const b = Number(m[2]);

      if (
        Number.isFinite(a) &&
        Number.isFinite(b) &&
        a > 0 &&
        b >= a &&
        b < 100000
      ) {
        return {
          text: `$${a.toFixed(2)} - $${b.toFixed(2)}`,
          unitPrice: (a + b) / 2
        };
      }
    }

    const value = Number(m[1]);

    if (
      Number.isFinite(value) &&
      value > 0 &&
      value < 100000
    ) {
      return {
        text: `$${value.toFixed(2)}`,
        unitPrice: value
      };
    }
  }

  return {
    text: null,
    unitPrice: null
  };
}

/* =========================
   MOQ
========================= */

function parseMOQ(text) {
  const s = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "");

  const patterns = [
    /(?:MOQ|minimum order quantity|minimum order|minimum quantity|minimum qty)\s*(?:is|:|-)?\s*(\d{1,8})/i,

    /(?:MOQ|minimum order quantity|minimum order)[^0-9]{0,50}(\d{1,8})\s*(?:pcs|pieces|units)?/i,

    /(\d{1,8})\s*(?:pcs|pieces|units)\s*(?:MOQ|minimum order)/i
  ];

  for (const p of patterns) {
    const m = s.match(p);
    if (!m) continue;

    const n = Number(m[1]);

    if (
      Number.isInteger(n) &&
      n > 0 &&
      n <= 10000000
    ) {
      return n;
    }
  }

  return null;
}

/* =========================
   LEAD TIME
========================= */

function parseLeadTime(text) {
  const s = String(text || "");

  const patterns = [
    /(\d+)\s*[-–—]\s*(\d+)\s*days?/i,
    /(\d+)\s*to\s*(\d+)\s*days?/i,
    /within\s*(\d+)\s*days?/i,
    /production\s*time[^0-9]{0,20}(\d+)\s*days?/i,
    /lead\s*time[^0-9]{0,20}(\d+)\s*days?/i
  ];

  for (const p of patterns) {
    const m = s.match(p);

    if (!m) continue;

    if (m[2]) {
      return `${m[1]}-${m[2]} days`;
    }

    return `${m[1]} days`;
  }

  return null;
}

/* =========================
   SUPPLIER SIGNAL
========================= */

function supplierSignals(title, url, snippet) {
  const text = `${title} ${url} ${snippet}`.toLowerCase();

  let score = 0;

  if (/manufacturer|factory|manufacturer-direct|factory-direct/.test(text)) {
    score += 30;
  }

  if (/\boem\b/.test(text)) score += 15;
  if (/\bodm\b/.test(text)) score += 10;

  if (/wholesale|bulk|bulk order/.test(text)) {
    score += 15;
  }

  if (/supplier|exporter/.test(text)) {
    score += 10;
  }

  if (/custom|private label|custom logo|logo printing/.test(text)) {
    score += 10;
  }

  return Math.min(score, 100);
}

/* =========================
   PAGE QUALITY
========================= */

function pageTypeScore(title, url, snippet) {
  const text = `${title} ${url} ${snippet}`.toLowerCase();

  let score = 0;

  const good = [
    "manufacturer",
    "factory",
    "supplier",
    "wholesale",
    "bulk",
    "oem",
    "odm",
    "exporter",
    "custom",
    "private label"
  ];

  const bad = [
    "amazon",
    "walmart",
    "etsy",
    "ebay",
    "best buy",
    "retail",
    "review",
    "reviews",
    "blog",
    "guide",
    "article",
    "comparison",
    "definition",
    "wikipedia",
    "gift ideas",
    "promotional gifts"
  ];

  for (const word of good) {
    if (text.includes(word)) score += 7;
  }

  for (const word of bad) {
    if (text.includes(word)) score -= 20;
  }

  return score;
}

/* =========================
   EVIDENCE
========================= */

function evidenceScore(data) {
  let score = 0;

  if (data.unitPrice !== null) score += 30;
  if (data.moq !== null) score += 25;
  if (data.leadTime !== null) score += 15;
  if (data.shippingMentioned) score += 10;

  if (data.supplierSignal >= 20) score += 10;
  if (data.supplierSignal >= 40) score += 10;

  return Math.min(score, 100);
}

/* =========================
   DEAL SCORE
========================= */

function dealScore(data, requestedQuantity) {
  let score = 0;

  /* Supplier quality */
  score += Math.min(data.supplierSignal * 0.30, 30);

  /* Commercial evidence */
  if (data.unitPrice !== null) score += 20;
  if (data.moq !== null) score += 15;
  if (data.leadTime !== null) score += 10;
  if (data.shippingMentioned) score += 5;

  /* MOQ fit */
  if (data.moq !== null && requestedQuantity) {
    if (data.moq <= requestedQuantity) {
      score += 10;
    } else if (data.moq <= requestedQuantity * 2) {
      score += 4;
    } else {
      score -= 15;
    }
  }

  /* Price reasonableness */
  if (data.unitPrice !== null) {
    if (data.unitPrice <= 2) score += 5;
    else if (data.unitPrice <= 5) score += 3;
    else if (data.unitPrice > 100) score -= 5;
  }

  /* Page quality */
  score += Math.max(
    -15,
    Math.min(10, data.pageTypeScore * 0.15)
  );

  return Math.max(
    0,
    Math.min(100, Math.round(score))
  );
}

/* =========================
   SEARCH
========================= */

async function searchSuppliers(requestText, env) {
  if (!env.YEP_API_KEY) {
    throw new Error("YEP_API_KEY is missing");
  }

  const requestedQuantity = extractQuantity(requestText);

  const searchQuery = `
    ${requestText}
    manufacturer factory supplier wholesale exporter
    OEM ODM bulk custom logo private label
    MOQ minimum order quantity
    unit price USD per piece quotation
    production lead time shipping
  `
    .replace(/\s+/g, " ")
    .trim();

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
        type: "highlights",
        limit: 50,
        language: ["en"],
        location: "US"
      })
    }
  );

  if (!response.ok) {
    const errorText = await response.text();

    throw new Error(
      `Yep Search error ${response.status}: ${errorText}`
    );
  }

  const data = await response.json();

  const rawResults = Array.isArray(data.results)
    ? data.results
    : [];

  const results = rawResults
    .map((r) => {
      const title = String(r.title || "");
      const url = String(r.url || "");

      const snippet = String(
        r.snippet ||
        r.description ||
        r.highlight ||
        ""
      );

      const combined = `${title} ${snippet}`;

      const price = parsePrice(combined);
      const moq = parseMOQ(combined);
      const leadTime = parseLeadTime(combined);

      const shippingMentioned =
        /\bshipping\b|\bfreight\b|\bdelivery\b|\bFOB\b|\bCIF\b|\bDDP\b/i
          .test(combined);

      const supplierSignal =
        supplierSignals(
          title,
          url,
          snippet
        );

      const pageScore =
        pageTypeScore(
          title,
          url,
          snippet
        );

      const evidence = evidenceScore({
        unitPrice: price.unitPrice,
        moq,
        leadTime,
        shippingMentioned,
        supplierSignal
      });

      const deal = dealScore(
        {
          unitPrice: price.unitPrice,
          moq,
          leadTime,
          shippingMentioned,
          supplierSignal,
          pageTypeScore: pageScore
        },
        requestedQuantity
      );

      return {
        title,
        url,
        snippet,

        priceText: price.text,
        unitPrice: price.unitPrice,

        moq,
        leadTime,

        shippingMentioned,

        supplierSignal,

        evidenceScore: evidence,
        dealScore: deal,

        requestedQuantity,

        productCost:
          price.unitPrice !== null &&
          requestedQuantity
            ? Number(
                (
                  price.unitPrice *
                  requestedQuantity
                ).toFixed(2)
              )
            : null
      };
    })

    /* Must have a supplier signal */
    .filter((r) =>
      r.url &&
      r.supplierSignal >= 15
    )

    /* Remove obvious non-supplier pages */
    .filter((r) =>
      r.pageTypeScore > -25
    )

    .sort((a, b) => {
      if (b.dealScore !== a.dealScore) {
        return b.dealScore - a.dealScore;
      }

      return b.evidenceScore - a.evidenceScore;
    });

  /* =========================
     REMOVE DUPLICATE DOMAINS
  ========================= */

  const seen = new Set();

  const unique = results.filter((r) => {
    try {
      const domain = new URL(r.url)
        .hostname
        .replace(/^www\./, "")
        .toLowerCase();

      if (seen.has(domain)) {
        return false;
      }

      seen.add(domain);
      return true;

    } catch {
      return true;
    }
  });

  return {
    success: true,
    query: requestText,
    requestedQuantity,
    total: unique.length,
    results: unique.slice(0, 50)
  };
}

/* =========================
   AI NEGOTIATION
========================= */

async function negotiate(body, env) {
  if (!env.AI) {
    throw new Error(
      "Workers AI binding AI is missing"
    );
  }

  const supplier = body.supplier || "";
  const offer = body.offer || "";
  const reply = body.reply || "";

  const prompt = `
You are NOVA, an evidence-first AI procurement analyst.

Analyze ONLY information explicitly provided.

IMPORTANT:
- NEVER invent facts.
- NEVER invent a price.
- NEVER invent MOQ.
- NEVER assume customization is included.
- NEVER assume shipping destination.
- NEVER assume taxes or customs.
- NEVER call a price competitive without evidence.
- If information is missing, write NOT STATED.
- Quantity is NOT MOQ.
- Do not convert assumptions into facts.

Supplier:
${supplier}

Initial offer:
${offer}

Supplier reply:
${reply}

Return exactly these sections:

VERIFIED OFFER

NOT STATED

DEAL ANALYSIS

NEGOTIATION TARGET

COUNTER-OFFER

MESSAGE TO SUPPLIER
`;

  const result = await env.AI.run(
    MODEL,
    {
      messages: [
        {
          role: "system",
          content:
            "You are a strict procurement analyst. Evidence first. Never fabricate."
        },
        {
          role: "user",
          content: prompt
        }
      ]
    }
  );

  return (
    result.response ||
    JSON.stringify(result)
  );
}

/* =========================
   MAIN WORKER
========================= */

export default {
  async fetch(request, env) {
    try {
      await ensureDB(env);

      const url = new URL(request.url);
      const path = url.pathname;

      /* STATIC */
      if (
        request.method === "GET" &&
        !path.startsWith("/api/")
      ) {
        if (env.ASSETS) {
          return env.ASSETS.fetch(request);
        }

        return new Response(
          "NOVA Procurement AI",
          {
            headers: {
              "content-type": "text/plain"
            }
          }
        );
      }

      /* SEARCH */
      if (
        request.method === "POST" &&
        path === "/api/search"
      ) {
        const body = await request.json();

        if (!body.request) {
          return json(
            {
              success: false,
              error: "Request is required"
            },
            400
          );
        }

        const result =
          await searchSuppliers(
            body.request,
            env
          );

        return json(result);
      }

      /* SIGNUP */
      if (
        request.method === "POST" &&
        path === "/api/signup"
      ) {
        const body = await request.json();

        const email = String(
          body.email || ""
        )
          .trim()
          .toLowerCase();

        const password = String(
          body.password || ""
        );

        if (!email || !password) {
          return json(
            {
              success: false,
              error:
                "Email and password are required"
            },
            400
          );
        }

        if (password.length < 6) {
          return json(
            {
              success: false,
              error:
                "Password must be at least 6 characters"
            },
            400
          );
        }

        const existing =
          await env.DB
            .prepare(
              "SELECT id FROM users WHERE email = ?"
            )
            .bind(email)
            .first();

        if (existing) {
          return json(
            {
              success: false,
              error:
                "Account already exists"
            },
            409
          );
        }

        const salt =
          randomToken(16);

        const hash =
          await passwordHash(
            password,
            salt
          );

        const createdAt =
          new Date().toISOString();

        const result =
          await env.DB
            .prepare(`
              INSERT INTO users
              (email, password_hash, password_salt, created_at)
              VALUES (?, ?, ?, ?)
            `)
            .bind(
              email,
              hash,
              salt,
              createdAt
            )
            .run();

        const userId =
          result.meta.last_row_id;

        const token =
          randomToken(32);

        const expires =
          new Date(
            Date.now() +
            7 * 24 * 60 * 60 * 1000
          ).toISOString();

        await env.DB
          .prepare(`
            INSERT INTO sessions
            (token, user_id, expires_at)
            VALUES (?, ?, ?)
          `)
          .bind(
            token,
            userId,
            expires
          )
          .run();

        return json(
          {
            success: true,
            user: {
              id: userId,
              email
            }
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(token)
          }
        );
      }

      /* LOGIN */
      if (
        request.method === "POST" &&
        path === "/api/login"
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
          await env.DB
            .prepare(`
              SELECT *
              FROM users
              WHERE email = ?
            `)
            .bind(email)
            .first();

        if (!user) {
          return json(
            {
              success: false,
              error:
                "Invalid email or password"
            },
            401
          );
        }

        const hash =
          await passwordHash(
            password,
            user.password_salt
          );

        if (
          hash !== user.password_hash
        ) {
          return json(
            {
              success: false,
              error:
                "Invalid email or password"
            },
            401
          );
        }

        const token =
          randomToken(32);

        const expires =
          new Date(
            Date.now() +
            7 * 24 * 60 * 60 * 1000
          ).toISOString();

        await env.DB
          .prepare(`
            INSERT INTO sessions
            (token, user_id, expires_at)
            VALUES (?, ?, ?)
          `)
          .bind(
            token,
            user.id,
            expires
          )
          .run();

        return json(
          {
            success: true,
            user: {
              id: user.id,
              email: user.email
            }
          },
          200,
          {
            "Set-Cookie":
              sessionCookie(token)
          }
        );
      }

      /* LOGOUT */
      if (
        request.method === "POST" &&
        path === "/api/logout"
      ) {
        const token =
          cookieValue(
            request,
            "nova_session"
          );

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
            "Set-Cookie":
              clearSessionCookie()
          }
        );
      }

      /* ME */
      if (
        request.method === "GET" &&
        path === "/api/me"
      ) {
        const user =
          await currentUser(
            request,
            env
          );

        return json({
          success: true,
          loggedIn: !!user,
          user
        });
      }

      /* PURCHASES GET */
      if (
        request.method === "GET" &&
        path === "/api/purchases"
      ) {
        const user =
          await currentUser(
            request,
            env
          );

        if (!user) {
          return json(
            {
              success: false,
              error: "Not logged in"
            },
            401
          );
        }

        const rows =
          await env.DB
            .prepare(`
              SELECT *
              FROM purchases
              WHERE user_id = ?
              ORDER BY id DESC
            `)
            .bind(user.id)
            .all();

        return json({
          success: true,
          purchases:
            rows.results || []
        });
      }

      /* PURCHASE SAVE */
      if (
        request.method === "POST" &&
        path === "/api/purchases"
      ) {
        const user =
          await currentUser(
            request,
            env
          );

        if (!user) {
          return json(
            {
              success: false,
              error: "Not logged in"
            },
            401
          );
        }

        const body =
          await request.json();

        const quantity =
          Number(body.quantity || 0);

        const unitPrice =
          body.unitPrice === null ||
          body.unitPrice === undefined ||
          body.unitPrice === ""
            ? null
            : Number(body.unitPrice);

        const shipping =
          body.shippingCost === null ||
          body.shippingCost === undefined ||
          body.shippingCost === ""
            ? null
            : Number(body.shippingCost);

        const landed =
          body.landedCost === null ||
          body.landedCost === undefined ||
          body.landedCost === ""
            ? null
            : Number(body.landedCost);

        const result =
          await env.DB
            .prepare(`
              INSERT INTO purchases
              (
                user_id,
                product,
                supplier,
                quantity,
                unit_price,
                shipping_cost,
                landed_cost,
                supplier_url,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              user.id,
              body.product || "",
              body.supplier || "",
              quantity || null,
              unitPrice,
              shipping,
              landed,
              body.supplierUrl || "",
              new Date().toISOString()
            )
            .run();

        return json({
          success: true,
          purchaseId:
            result.meta.last_row_id
        });
      }

      /* NEGOTIATION */
      if (
        request.method === "POST" &&
        path === "/api/negotiate"
      ) {
        const user =
          await currentUser(
            request,
            env
          );

        const body =
          await request.json();

        const analysis =
          await negotiate(
            body,
            env
          );

        if (user && env.DB) {
          await env.DB
            .prepare(`
              INSERT INTO negotiations
              (
                user_id,
                purchase_id,
                supplier,
                offer,
                reply,
                analysis,
                created_at
              )
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `)
            .bind(
              user.id,
              body.purchaseId || null,
              body.supplier || "",
              body.offer || "",
              body.reply || "",
              analysis,
              new Date().toISOString()
            )
            .run();
        }

        return json({
          success: true,
          analysis
        });
      }

      return json(
        {
          success: false,
          error: "Not found"
        },
        404
      );

    } catch (error) {
      return json(
        {
          success: false,
          error:
            error?.message ||
            String(error)
        },
        500
      );
    }
  }
};
