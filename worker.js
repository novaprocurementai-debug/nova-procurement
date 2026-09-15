export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/search") {
      try {
        const body = await request.json();
        const requestText = (body.request || "").trim();

        if (!requestText) {
          return Response.json(
            { error: "Enter what you want to buy." },
            { status: 400 }
          );
        }

        const r = await fetch("https://platform.yep.com/api/search", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.YEP_API_KEY}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            query: `${requestText} supplier manufacturer wholesale price MOQ`,
            type: "highlights",
            limit: 50,
            language: ["en"]
          })
        });

        const data = await r.json();

        if (!Array.isArray(data.results)) {
          return Response.json({
            success: false,
            error: "No search results",
            results: []
          });
        }

        const results = data.results
          .filter(x => x.url)
          .map(x => {
            const text =
              `${x.title || ""} ${x.snippet || ""} ${x.description || ""}`;

            const price =
              text.match(/(?:US\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i)?.[0] || null;

            const moq =
              text.match(/(?:MOQ|minimum order(?: quantity)?)[^\d]{0,20}([\d,]+)/i)?.[1] || null;

            const lead =
              text.match(/\b\d+\s*(?:-|–|to)\s*\d+\s*days\b/i)?.[0] || null;

            return {
              title: x.title || "Supplier",
              url: x.url,
              snippet: x.snippet || x.description || "",
              price,
              moq,
              leadTime: lead
            };
          });

        return Response.json({
          success: true,
          request: requestText,
          result_count: results.length,
          results
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
