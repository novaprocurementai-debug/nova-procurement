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
            {
              error: "Please enter what you want to buy."
            },
            { status: 400 }
          );
        }

        // NOVA creates a supplier-focused search query
        const searchQuery =
          `${procurementRequest} supplier manufacturer wholesale`;

        // SearXNG public search engine
        const searchUrl =
          "https://searx.tiekoetter.com/search?q=" +
          encodeURIComponent(searchQuery) +
          "&format=json&language=en&categories=general";

        const searchResponse = await fetch(searchUrl, {
          method: "GET",
          headers: {
            "Accept": "application/json",
            "User-Agent": "NOVA Procurement AI"
          }
        });

        if (!searchResponse.ok) {
          return Response.json(
            {
              success: false,
              error: "Search engine failed",
              status: searchResponse.status
            },
            { status: 502 }
          );
        }

        const searchData = await searchResponse.json();

        const rawResults = Array.isArray(searchData.results)
          ? searchData.results
          : [];

        const results = rawResults
          .slice(0, 20)
          .map((item) => {
            return {
              title:
                item.title ||
                "Untitled result",

              url:
                item.url ||
                "",

              snippet:
                item.content ||
                item.snippet ||
                "",

              engine:
                item.engine ||
                "Web search"
            };
          });

        return Response.json({
          success: true,

          request: procurementRequest,

          query: searchQuery,

          source: "SearXNG web search",

          resultCount: results.length,

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

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "NOVA Procurement AI",
      { status: 200 }
    );
  }
};
