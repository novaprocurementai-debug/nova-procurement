export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/api/search")
    ) {
      try {
        const body = await request.json();
        const procurementRequest = body.request?.trim();

        if (!procurementRequest) {
          return Response.json(
            { error: "Please enter what you want to buy." },
            { status: 400 }
          );
        }

        // تحسين طلب البحث ليبحث عن موردين وأسعار حقيقية
        const query =
          `${procurementRequest} supplier manufacturer wholesale price MOQ ` +
          `"minimum order quantity" shipping quotation`;

        const yepResponse = await fetch(
          "https://platform.yep.com/api/search",
          {
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
          }
        );

        const yepData = await yepResponse.json();

        if (!yepResponse.ok) {
          return Response.json(
            {
              error: "Yep search failed",
              details: yepData
            },
            { status: yepResponse.status }
          );
        }

        const results = (yepData.results || []).map((item) => {
          const text = [
            item.title || "",
            item.snippet || "",
            item.description || "",
            item.highlight || ""
          ].join(" ");

          const priceMatch = text.match(
            /(?:US?\$|USD|\$)\s?[\d,.]+(?:\s*[-–]\s*[\d,.]+)?/i
          );

          const moqMatch = text.match(
            /(?:MOQ|minimum order quantity|minimum order)\D{0,20}([\d,]+)/i
          );

          const leadMatch = text.match(
            /(\d+\s*(?:-|–|to)\s*\d+\s*days|\d+\s*days)/i
          );

          return {
            title: item.title || "Untitled supplier result",
            url: item.url || "",
            snippet:
              item.snippet ||
              item.description ||
              item.highlight ||
              "",
            price: priceMatch ? priceMatch[0] : null,
            moq: moqMatch ? moqMatch[1] : null,
            leadTime: leadMatch ? leadMatch[1] : null
          };
        });

        return Response.json({
          success: true,
          request: procurementRequest,
          query,
          source: "Yep real web search",
          results
        });

      } catch (error) {
        return Response.json(
          {
            error: "NOVA search error",
            details: error.message
          },
          { status: 500 }
        );
      }
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("NOVA Procurement AI", { status: 200 });
  }
};
