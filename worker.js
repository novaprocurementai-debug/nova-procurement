export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/search") {
      try {
        const body = await request.json();
        const requestText = (body.request || "").trim();

        if (!requestText) {
          return Response.json(
            { error: "Please enter what you want to buy." },
            { status: 400 }
          );
        }

        const queries = [
          `${requestText} supplier wholesale manufacturer`,
          `${requestText} Alibaba supplier wholesale`,
          `${requestText} factory manufacturer price MOQ`
        ];

        const allResults = [];

        for (const query of queries) {
          const r = await fetch("https://platform.yep.com/api/search", {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.YEP_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query,
              type: "basic",
              limit: 20,
              language: ["en"]
            })
          });

          const data = await r.json();

          if (Array.isArray(data.results)) {
            allResults.push(...data.results);
          }
        }

        const unique = [];
        const seen = new Set();

        for (const item of allResults) {
          if (!item.url || seen.has(item.url)) continue;
          seen.add(item.url);

          unique.push({
            title: item.title || "Supplier",
            url: item.url,
            snippet: item.snippet || item.description || ""
          });
        }

        return Response.json({
          success: true,
          request: requestText,
          results: unique.slice(0, 50),
          result_count: unique.length,
          source: "Yep"
        });

      } catch (e) {
        return Response.json(
          { success: false, error: e.message, results: [] },
          { status: 500 }
        );
      }
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("NOVA Procurement AI");
  }
};
