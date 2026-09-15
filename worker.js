export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/search") {
      try {
        const body = await request.json();
        const requestText = (body.request || "").trim();

        if (!requestText)
          return Response.json({ error: "Enter what you want to buy." }, { status: 400 });

        const queries = [
          `${requestText} supplier wholesale manufacturer price MOQ`,
          `${requestText} factory supplier wholesale`,
          `${requestText} manufacturer MOQ price`
        ];

        const all = [];

        for (const query of queries) {
          const r = await fetch("https://platform.yep.com/api/search", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.YEP_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query,
              type: "highlights",
              limit: 20,
              language: ["en"]
            })
          });

          const data = await r.json();
          if (Array.isArray(data.results)) all.push(...data.results);
        }

        const seen = new Set();
        const results = [];

        for (const x of all) {
          if (!x.url || seen.has(x.url)) continue;
          seen.add(x.url);

          const text = `${x.title || ""} ${x.snippet || ""} ${x.description || ""}`;

          const price =
            text.match(/(?:US\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i)?.[0] || null;

          const moq =
            text.match(/(?:MOQ|minimum order(?: quantity)?)[^\d]{0,20}([\d,]+)/i)?.[1] || null;

          const lead =
            text.match(/\b\d+\s*(?:-|–|to)\s*\d+\s*days\b/i)?.[0] ||
            text.match(/\b\d+\s*days\b/i)?.[0] || null;

          let score = 50;
          if (price) score += 20;
          if (moq) score += 15;
          if (lead) score += 15;

          results.push({
            title: x.title || "Supplier",
            url: x.url,
            snippet: x.snippet || x.description || "",
            price,
            moq,
            leadTime: lead,
            dealScore: Math.min(score, 100)
          });
        }

        results.sort((a, b) => b.dealScore - a.dealScore);

        return Response.json({
          success: true,
          request: requestText,
          result_count: results.length,
          bestDeal: results[0] || null,
          results: results.slice(0, 50)
        });

      } catch (e) {
        return Response.json(
          { success: false, error: e.message, results: [] },
          { status: 500 }
        );
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);

    return new Response("NOVA Procurement AI");
  }
};
