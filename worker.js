export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    /* REAL SUPPLIER SEARCH */
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
            results: []
          });
        }

        const results = data.results
          .filter(x => x.url)
          .map(x => {
            const text =
              `${x.title || ""} ${x.snippet || ""} ${x.description || ""}`;

            const price =
              text.match(
                /(?:US\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i
              )?.[0] || null;

            const moq =
              text.match(
                /(?:MOQ|minimum order(?: quantity)?)[^\d]{0,20}([\d,]+)/i
              )?.[1] || null;

            const leadTime =
              text.match(
                /\b\d+\s*(?:-|–|to)\s*\d+\s*days\b/i
              )?.[0] || null;

            let score = 50;

            if (price) score += 20;
            if (moq) score += 15;
            if (leadTime) score += 15;

            return {
              title: x.title || "Supplier",
              url: x.url,
              snippet: x.snippet || x.description || "",
              price,
              moq,
              leadTime,
              dealScore: score
            };
          });

        results.sort((a, b) => b.dealScore - a.dealScore);

        return Response.json({
          success: true,
          request: requestText,
          result_count: results.length,
          results
        });

      } catch (e) {
        return Response.json(
          {
            success: false,
            error: e.message,
            results: []
          },
          { status: 500 }
        );
      }
    }

    /* REAL AI NEGOTIATION */
    if (request.method === "POST" && url.pathname === "/api/negotiate") {
      try {
        const body = await request.json();

        const product = body.product || "";
        const supplier = body.supplier || "";
        const offer = body.offer || "";
        const reply = body.supplierReply || "";

        const prompt = `
You are NOVA, an AI procurement negotiation agent.

Buyer product:
${product}

Supplier:
${supplier}

Supplier offer:
${offer}

Supplier reply:
${reply}

Analyze the supplier's response.

Return a concise procurement analysis with:

1. Offer assessment
2. Missing information
3. Negotiation leverage
4. Recommended target
5. Recommended counter-offer
6. Professional message to send to the supplier

Do not invent prices, shipping costs, MOQ, delivery dates, or facts that are not provided.
Clearly say when information is unknown.
`;

        const ai = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content:
                  "You are a professional global procurement negotiation assistant."
              },
              {
                role: "user",
                content: prompt
              }
            ]
          }
        );

        return Response.json({
          success: true,
          analysis: ai.response || ""
        });

      } catch (e) {
        return Response.json(
          {
            success: false,
            error: e.message
          },
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
