export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/api/search") {
      try {
        const body = await request.json();
        const requestText = (body.request || "").trim();

        if (!requestText)
          return Response.json({ error: "Enter what you want to buy." }, { status: 400 });

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

        if (!Array.isArray(data.results))
          return Response.json({ success: false, results: [] });

        const results = data.results.filter(x => x.url).map(x => {
          const text = `${x.title || ""} ${x.snippet || ""} ${x.description || ""}`;

          const price = text.match(/(?:US\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i)?.[0] || null;
          const moq = text.match(/(?:MOQ|minimum order(?: quantity)?)[^\d]{0,20}([\d,]+)/i)?.[1] || null;
          const leadTime = text.match(/\b\d+\s*(?:-|–|to)\s*\d+\s*days\b/i)?.[0] || null;

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
          { success: false, error: e.message, results: [] },
          { status: 500 }
        );
      }
    }

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
Do NOT call information "missing" if it is explicitly stated anywhere in the reply.
Extract exact facts before giving advice.
Never invent numbers.

Analyze these fields separately:

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
List only facts actually stated by the supplier.

2. MISSING INFORMATION
List only information that is genuinely absent.

3. DEAL ANALYSIS
Explain whether the offer looks attractive, but do not claim it is the cheapest unless there is evidence.

4. NEGOTIATION TARGET
Suggest a reasonable negotiation approach.
If there is not enough information for a numeric target, say so.

5. COUNTER-OFFER
Give a practical proposed counter-offer.

6. MESSAGE TO SUPPLIER
Write a professional message ready to send.

Be concise and factual.
`;

        const ai = await env.AI.run(
          "@cf/meta/llama-3.1-8b-instruct-fast",
          {
            messages: [
              {
                role: "system",
                content: "You are NOVA, an evidence-first global procurement negotiation agent. Accuracy is more important than guessing."
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
        return Response.json({
          success: false,
          error: e.message
        }, { status: 500 });
      }
    }

    if (env.ASSETS)
      return env.ASSETS.fetch(request);

    return new Response("NOVA Procurement AI");
  }
};
