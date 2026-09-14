export default {
  async fetch(request, env) {

    const url = new URL(request.url);

    // =========================
    // NOVA REAL SEARCH
    // =========================

    if (
      request.method === "POST" &&
      (url.pathname === "/" || url.pathname === "/api/search")
    ) {

      try {

        const body = await request.json();

        const procurementRequest =
          body.request?.trim();

        if (!procurementRequest) {
          return Response.json(
            {
              error: "Please enter what you want to buy."
            },
            { status: 400 }
          );
        }


        // -------------------------
        // Search queries
        // -------------------------

        const queries = [

          procurementRequest,

          `${procurementRequest} supplier manufacturer wholesale`

        ];


        let allResults = [];

        let apiResponses = [];


        // -------------------------
        // Search Yep
        // -------------------------

        for (const searchQuery of queries) {

          const yepResponse = await fetch(
            "https://platform.yep.com/api/search",
            {
              method: "POST",

              headers: {
                "Authorization":
                  `Bearer ${env.YEP_API_KEY}`,

                "Content-Type":
                  "application/json",

                "Accept":
                  "application/json"
              },

              body: JSON.stringify({

                query: searchQuery,

                type: "highlights",

                limit: 20,

                language: ["en"]

              })
            }
          );


          const yepData =
            await yepResponse.json();


          apiResponses.push({

            query: searchQuery,

            status:
              yepResponse.status,

            success:
              yepData.success === true,

            resultCount:
              Array.isArray(yepData.results)
                ? yepData.results.length
                : 0,

            error:
              yepData.error || null

          });


          // API error
          if (!yepResponse.ok) {

            continue;

          }


          // Add results
          if (
            Array.isArray(
              yepData.results
            )
          ) {

            for (
              const item
              of yepData.results
            ) {

              allResults.push({

                title:
                  item.title ||
                  "Untitled result",

                url:
                  item.url ||
                  "",

                snippet:
                  item.highlight ||
                  item.snippet ||
                  item.description ||
                  item.content ||
                  "",

                source:
                  "Yep Search API"

              });

            }

          }

        }


        // -------------------------
        // Remove duplicates
        // -------------------------

        const unique =
          new Map();


        for (
          const item
          of allResults
        ) {

          if (!item.url) {
            continue;
          }


          if (
            !unique.has(item.url)
          ) {

            unique.set(
              item.url,
              item
            );

          }

        }


        const results =
          Array.from(
            unique.values()
          ).slice(0, 40);


        // -------------------------
        // Return results
        // -------------------------

        return Response.json({

          success: true,

          request:
            procurementRequest,

          source:
            "Yep Search API",

          resultCount:
            results.length,

          results:

            results,


          // Compatibility with
          // your old index.html

          yep_response: {

            success: true,

            results:
              results

          },


          // Diagnostic information

          diagnostics: {

            searches:
              apiResponses,

            totalResults:
              results.length

          }

        });


      } catch (error) {

        return Response.json(

          {

            success: false,

            error:
              "NOVA search error",

            details:
              error.message,

            results: [],

            yep_response: {
              results: []
            }

          },

          {
            status: 500
          }

        );

      }

    }


    // =========================
    // WEBSITE
    // =========================

    if (env?.ASSETS) {

      return env.ASSETS.fetch(
        request
      );

    }


    return new Response(
      "NOVA Procurement AI",
      {
        status: 200
      }
    );

  }
};
