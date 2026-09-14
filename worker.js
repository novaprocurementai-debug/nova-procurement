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

        // NOVA supplier-focused search
        const searchQuery =
          `${procurementRequest} supplier manufacturer wholesale price MOQ`;

        /*
         * Multiple SearXNG sources.
         * Some public instances disable JSON,
         * so NOVA automatically skips them.
         */
        const instances = [
          "https://priv.au",
          "https://search.mdosch.de",
          "https://searxng.website",
          "https://search.inetol.net",
          "https://search.serpensin.com",
          "https://searx.tiekoetter.com",
          "https://searx.linxx.net",
          "https://search.yuri.llc",
          "https://searxng.shreven.org",
          "https://searxng.deggo.fyi",
          "https://searx.oloke.xyz",
          "https://search.mectov.my.id"
        ];

        /*
         * Search many sources at the same time.
         */
        const searches = instances.map(async (instance) => {
          try {
            const searchUrl =
              `${instance}/search?q=` +
              encodeURIComponent(searchQuery) +
              `&format=json&language=en&categories=general`;

            const response = await fetch(searchUrl, {
              method: "GET",
              headers: {
                "Accept": "application/json",
                "User-Agent": "Mozilla/5.0 NOVA Procurement AI"
              }
            });

            if (!response.ok) {
              return {
                instance,
                success: false,
                results: []
              };
            }

            const contentType =
              response.headers.get("content-type") || "";

            /*
             * Prevent the HTML/JSON error
             * we saw with baresearch.org.
             */
            if (!contentType.toLowerCase().includes("json")) {
              return {
                instance,
                success: false,
                results: []
              };
            }

            const data = await response.json();

            if (!Array.isArray(data.results)) {
              return {
                instance,
                success: false,
                results: []
              };
            }

            return {
              instance,
              success: true,
              results: data.results
            };

          } catch (error) {
            return {
              instance,
              success: false,
              results: []
            };
          }
        });

        const responses = await Promise.all(searches);

        /*
         * Combine successful results.
         */
        let combinedResults = [];

        let successfulSources = [];

        for (const response of responses) {
          if (response.success) {
            successfulSources.push(response.instance);

            for (const item of response.results) {
              combinedResults.push({
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

                source:
                  response.instance
              });
            }
          }
        }

        /*
         * Remove duplicate URLs.
         */
        const unique = new Map();

        for (const item of combinedResults) {
          if (!item.url) {
            continue;
          }

          if (!unique.has(item.url)) {
            unique.set(item.url, item);
          }
        }

        const results = Array.from(unique.values())
          .slice(0, 50);

        /*
         * Return NOVA results.
         */
        return Response.json({
          success: true,

          request: procurementRequest,

          query: searchQuery,

          source: "NOVA Multi-Source Web Search",

          sourcesChecked: instances.length,

          successfulSources: successfulSources.length,

          successfulSourceList: successfulSources,

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

    /*
     * Serve website files.
     */
    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response(
      "NOVA Procurement AI",
      { status: 200 }
    );
  }
};
