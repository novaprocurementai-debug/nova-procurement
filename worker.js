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

        const searchQuery =
          `${procurementRequest} supplier manufacturer wholesale`;

        // NOVA tries several SearXNG instances
        const instances = [
          "https://searx.tiekoetter.com",
          "https://searxng.site",
          "https://baresearch.org"
        ];

        let lastError = null;

        for (const instance of instances) {
          try {
            const searchUrl =
              `${instance}/search?q=` +
              encodeURIComponent(searchQuery) +
              `&format=json&language=en&categories=general`;

            const searchResponse = await fetch(searchUrl, {
              method: "GET",
              headers: {
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 NOVA Procurement AI"
              }
            });

            if (!searchResponse.ok) {
              lastError =
                `${instance} returned HTTP ${searchResponse.status}`;
              continue;
            }

            const searchData = await searchResponse.json();

            const rawResults = Array.isArray(searchData.results)
              ? searchData.results
              : [];

            if (rawResults.length === 0) {
              lastError =
                `${instance} returned 0 results`;
              continue;
            }

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
              source: "SearXNG real web search",
              searchEngine: instance,
              resultCount: results.length,
              results: results
            });
          } catch (error) {
            lastError =
              `${instance}: ${error.message}`;
          }
        }

        return Response.json(
          {
            success: false,
            error: "All search engines failed",
            details: lastError
          },
          { status: 502 }
        );

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
