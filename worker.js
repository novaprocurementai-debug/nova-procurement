export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // NOVA real search API
    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/api/search")
    ) {
      try {
        const body = await request.json();
        const procurementRequest = body.request?.trim();

        if (!procurementRequest) {
          return Response.json(
            {
              error: "Please enter what you want to buy."
            },
            { status: 400 }
          );
        }

        // البحث المباشر أولاً، مع كلمات تساعد على إيجاد الموردين
        const query =
          `${procurementRequest} supplier wholesale manufacturer`;

        const yepResponse = await fetch(
          "https://platform.yep.com/api/search",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.YEP_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query: query,
              type: "basic",
              limit: 20,
              language: ["en"]
            })
          }
        );

        const yepData = await yepResponse.json();

        // إذا كان Yep أعاد خطأ
        if (!yepResponse.ok) {
          return Response.json(
            {
              success: false,
              error: "Yep search failed",
              status: yepResponse.status,
              details: yepData
            },
            { status: yepResponse.status }
          );
        }

        const rawResults = Array.isArray(yepData.results)
          ? yepData.results
          : [];

        // تحويل نتائج Yep إلى نتائج NOVA
        const results = rawResults.map((item) => {
          return {
            title:
              item.title ||
              item.name ||
              "Untitled supplier result",

            url:
              item.url ||
              item.link ||
              "",

            snippet:
              item.snippet ||
              item.description ||
              item.content ||
              item.text ||
              ""
          };
        });

        return Response.json({
          success: true,

          request: procurementRequest,

          query: query,

          source: "Yep real web search",

          yepResultCount: rawResults.length,

          results: results
        });

      } catch (error) {
        return Response.json(
          {
            success: false,
            error: "NOVA search error",
            details: error.message
          },
          { status: 500 }
        );
      }
    }

    // ملفات الموقع
    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "NOVA Procurement AI",
      { status: 200 }
    );
  }
};
