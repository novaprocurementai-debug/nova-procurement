const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";

function json(data, status = 200) {
  return Response.json(data, { status });
}

function cookieValue(request, name) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
  return match ? decodeURIComponent(match[1]) : null;
}

function randomToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return [...bytes].map(x => x.toString(16).padStart(2, "0")).join("");
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

async function ensureDB(env) {
  if (!env.DB) throw new Error("D1 binding DB is not available.");

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      product TEXT NOT NULL,
      supplier TEXT,
      supplier_url TEXT,
      quantity REAL,
      unit_price REAL,
      shipping_cost REAL,
      landed_cost REAL,
      deal_score REAL,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS negotiations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      purchase_id INTEGER,
      supplier_reply TEXT,
      ai_analysis TEXT,
      created_at TEXT NOT NULL
    )
  `).run();
}

async function currentUser(request, env) {
  if (!env.DB) return null;

  const token = cookieValue(request, "nova_session");
  if (!token) return null;

  const tokenHash = await sha256(token);

  const row = await env.DB.prepare(`
    SELECT users.id, users.email
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.expires_at > ?
  `).bind(tokenHash, new Date().toISOString()).first();

  return row || null;
}

function sessionCookie(token) {
  return `nova_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=604800`;
}

function clearSessionCookie() {
  return "nova_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
}

function extractNumber(value) {
  if (value === null || value === undefined) return null;
  const m = String(value).replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

function extractQuantity(text) {
  const patterns = [
    /(?:quantity|qty|order|buy|need|want)\D{0,25}([\d,]+)/i,
    /([\d,]+)\s*(?:units|pcs|pieces|items|bottles|sets)/i
  ];

  for (const p of patterns) {
    const m = String(text).match(p);
    if (m) return Number(m[1].replace(/,/g, ""));
  }

  return null;
}

function parseSinglePrice(text) {
  const m = String(text).match(
    /(?:US\$|USD|\$)\s?([\d,.]+)(?!\s*[-–])/i
  );
  return m ? Number(m[1].replace(/,/g, "")) : null;
}

function evidenceScore(item) {
  let score = 0;
  const evidence = [];

  if (item.url) {
    score += 15;
    evidence.push("source");
  }

  if (item.price) {
    score += 25;
    evidence.push("price");
  }

  if (item.moq) {
    score += 20;
    evidence.push("MOQ");
  }

  if (item.leadTime) {
    score += 15;
    evidence.push("lead time");
  }

  if (item.shippingMentioned) {
    score += 15;
    evidence.push("shipping");
  }

  if (item.snippet && item.snippet.length > 100) {
    score += 10;
    evidence.push("details");
  }

  return {
    score: Math.min(score, 100),
    evidence
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // =========================
    // SEARCH
    // =========================

    if (request.method === "POST" && url.pathname === "/api/search") {
      try {
        const body = await request.json();
        const requestText = (body.request || "").trim();

        if (!requestText) {
          return json({
            success: false,
            error: "Enter what you want to buy.",
            results: []
          }, 400);
        }

        const quantity =
          Number(body.quantity) ||
          extractQuantity(requestText);

        const r = await fetch("https://platform.yep.com/api/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.YEP_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: `${requestText} supplier manufacturer wholesale price MOQ shipping`,
            type: "highlights",
            limit: 50,
            language: ["en"]
          })
        });

        const data = await r.json();

        if (!Array.isArray(data.results)) {
          return json({
            success: false,
            results: [],
            error: "Search provider returned no results."
          });
        }

        const results = data.results
          .filter(x => x.url)
          .map(x => {
            const text =
              `${x.title || ""} ${x.snippet || ""} ${x.description || ""}`;

            const priceText =
              text.match(
                /(?:US\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i
              )?.[0] || null;

            const unitPrice = parseSinglePrice(text);

            const moq =
              text.match(
                /(?:MOQ|minimum order(?: quantity)?)[^\d]{0,20}([\d,]+)/i
              )?.[1] || null;

            const leadTime =
              text.match(
                /\b\d+\s*(?:-|–|to)\s*\d+\s*days\b/i
              )?.[0] || null;

            const shippingMentioned =
              /\b(shipping|freight|delivery|FOB|CIF|DDP|EXW)\b/i.test(text);

            const productCost =
              unitPrice !== null && quantity
                ? Number((unitPrice * quantity).toFixed(2))
                : null;

            const evidence = evidenceScore({
              url: x.url,
              price: priceText,
              moq,
              leadTime,
              shippingMentioned,
              snippet: x.snippet || x.description || ""
            });

            return {
              title: x.title || "Supplier",
              url: x.url,
              snippet: x.snippet || x.description || "",
              price: priceText,
              unitPrice,
              moq,
              leadTime,
              dealScore: evidence.score,
              scoreEvidence: evidence.evidence,

              // A — Landed Cost
              quantity,
              productCost,
              shippingCost: null,
              landedCost: null,
              landedCostStatus:
                productCost !== null
                  ? "Product cost calculated. Shipping/customs not verified."
                  : "Not enough verified price/quantity data."
            };
          });

        results.sort((a, b) => b.dealScore - a.dealScore);

        return json({
          success: true,
          request: requestText,
          quantity,
          result_count: results.length,
          results
        });

      } catch (e) {
        return json({
          success: false,
          error: e.message,
          results: []
        }, 500);
      }
    }

    // =========================
    // SIGN UP
    // =========================

    if (request.method === "POST" && url.pathname === "/api/signup") {
      try {
        await ensureDB(env);

        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
          return json({ success: false, error: "Invalid email." }, 400);
        }

        if (password.length < 8) {
          return json({
            success: false,
            error: "Password must be at least 8 characters."
          }, 400);
        }

        const existing = await env.DB.prepare(
          "SELECT id FROM users WHERE email = ?"
        ).bind(email).first();

        if (existing) {
          return json({
            success: false,
            error: "Account already exists."
          }, 409);
        }

        const salt = randomToken();
        const hash = await passwordHash(password, salt);
        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
          INSERT INTO users
          (email, password_hash, salt, created_at)
          VALUES (?, ?, ?, ?)
        `).bind(email, hash, salt, now).run();

        const token = randomToken();
        const tokenHash = await sha256(token);

        const expires = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString();

        await env.DB.prepare(`
          INSERT INTO sessions
          (user_id, token_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `).bind(
          result.meta.last_row_id,
          tokenHash,
          now,
          expires
        ).run();

        return new Response(
          JSON.stringify({
            success: true,
            user: { email }
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": sessionCookie(token)
            }
          }
        );

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // LOGIN
    // =========================

    if (request.method === "POST" && url.pathname === "/api/login") {
      try {
        await ensureDB(env);

        const body = await request.json();
        const email = String(body.email || "").trim().toLowerCase();
        const password = String(body.password || "");

        const user = await env.DB.prepare(`
          SELECT id, email, password_hash, salt
          FROM users
          WHERE email = ?
        `).bind(email).first();

        if (!user) {
          return json({
            success: false,
            error: "Invalid email or password."
          }, 401);
        }

        const hash = await passwordHash(password, user.salt);

        if (hash !== user.password_hash) {
          return json({
            success: false,
            error: "Invalid email or password."
          }, 401);
        }

        const token = randomToken();
        const tokenHash = await sha256(token);
        const now = new Date().toISOString();

        const expires = new Date(
          Date.now() + 7 * 24 * 60 * 60 * 1000
        ).toISOString();

        await env.DB.prepare(`
          INSERT INTO sessions
          (user_id, token_hash, created_at, expires_at)
          VALUES (?, ?, ?, ?)
        `).bind(
          user.id,
          tokenHash,
          now,
          expires
        ).run();

        return new Response(
          JSON.stringify({
            success: true,
            user: { email: user.email }
          }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": sessionCookie(token)
            }
          }
        );

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // LOGOUT
    // =========================

    if (request.method === "POST" && url.pathname === "/api/logout") {
      try {
        await ensureDB(env);

        const token = cookieValue(request, "nova_session");

        if (token) {
          const tokenHash = await sha256(token);

          await env.DB.prepare(
            "DELETE FROM sessions WHERE token_hash = ?"
          ).bind(tokenHash).run();
        }

        return new Response(
          JSON.stringify({ success: true }),
          {
            headers: {
              "Content-Type": "application/json",
              "Set-Cookie": clearSessionCookie()
            }
          }
        );

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // CURRENT USER
    // =========================

    if (request.method === "GET" && url.pathname === "/api/me") {
      try {
        await ensureDB(env);

        const user = await currentUser(request, env);

        return json({
          success: true,
          loggedIn: !!user,
          user: user
            ? { id: user.id, email: user.email }
            : null
        });

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // SAVE PURCHASE
    // =========================

    if (request.method === "POST" && url.pathname === "/api/purchases") {
      try {
        await ensureDB(env);

        const user = await currentUser(request, env);

        if (!user) {
          return json({
            success: false,
            error: "Login required."
          }, 401);
        }

        const body = await request.json();
        const now = new Date().toISOString();

        const result = await env.DB.prepare(`
          INSERT INTO purchases
          (
            user_id,
            product,
            supplier,
            supplier_url,
            quantity,
            unit_price,
            shipping_cost,
            landed_cost,
            deal_score,
            status,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          user.id,
          body.product || "",
          body.supplier || "",
          body.supplierUrl || "",
          body.quantity ?? null,
          body.unitPrice ?? null,
          body.shippingCost ?? null,
          body.landedCost ?? null,
          body.dealScore ?? null,
          "active",
          now,
          now
        ).run();

        return json({
          success: true,
          purchaseId: result.meta.last_row_id
        });

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // PURCHASE HISTORY
    // =========================

    if (request.method === "GET" && url.pathname === "/api/purchases") {
      try {
        await ensureDB(env);

        const user = await currentUser(request, env);

        if (!user) {
          return json({
            success: false,
            error: "Login required."
          }, 401);
        }

        const rows = await env.DB.prepare(`
          SELECT *
          FROM purchases
          WHERE user_id = ?
          ORDER BY created_at DESC
        `).bind(user.id).all();

        return json({
          success: true,
          purchases: rows.results || []
        });

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // NEGOTIATION + AI + SAVE
    // =========================

    if (request.method === "POST" && url.pathname === "/api/negotiate") {
      try {
        const body = await request.json();

        const prompt = `
You are NOVA, a professional procurement AI.

BUYER REQUEST:
${body.product || ""}

SUPPLIER:
${body.supplier || ""}

SUPPLIER OFFER:
${body.offer || ""}

FULL SUPPLIER REPLY:
${body.supplierReply || ""}

IMPORTANT:
Read the supplier reply carefully.
Do NOT call information "missing" if it is explicitly stated.
Extract exact facts before advice.
Never invent numbers.

Analyze separately:

- Unit price
- Quantity
- MOQ
- Shipping cost
- Destination
- Production time
- Delivery time
- Payment terms
- Customization/logo cost
- Certifications
- Warranty
- Other fees

Then provide:

1. VERIFIED OFFER
Only facts actually stated.

2. MISSING INFORMATION
Only genuinely absent information.

3. DEAL ANALYSIS
Evidence-based assessment.

4. NEGOTIATION TARGET
Reasonable negotiation strategy.
Never invent unsupported numbers.

5. COUNTER-OFFER
Practical counter-offer when possible.

6. MESSAGE TO SUPPLIER
Professional ready-to-send message.

Be concise and factual.
`;

        const ai = await env.AI.run(MODEL, {
          messages: [
            {
              role: "system",
              content:
                "You are NOVA, an evidence-first procurement negotiation agent. Accuracy is more important than guessing."
            },
            {
              role: "user",
              content: prompt
            }
          ]
        });

        const analysis = ai.response || "";

        // C — save negotiation when logged in
        if (env.DB) {
          await ensureDB(env);

          const user = await currentUser(request, env);

          if (user) {
            await env.DB.prepare(`
              INSERT INTO negotiations
              (
                user_id,
                purchase_id,
                supplier_reply,
                ai_analysis,
                created_at
              )
              VALUES (?, ?, ?, ?, ?)
            `).bind(
              user.id,
              body.purchaseId || null,
              body.supplierReply || "",
              analysis,
              new Date().toISOString()
            ).run();
          }
        }

        return json({
          success: true,
          analysis
        });

      } catch (e) {
        return json({
          success: false,
          error: e.message
        }, 500);
      }
    }

    // =========================
    // STATIC WEBSITE
    // =========================

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("NOVA Procurement AI");
  }
};
