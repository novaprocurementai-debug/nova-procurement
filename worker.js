export default {
  async fetch(request, env) {

    const url = new URL(request.url);

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

        const searchQuery =
          `${procurementRequest} supplier manufacturer wholesale price MOQ`;

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


        const searches = instances.map(
          async (instance) => {

            try {

              const searchUrl =
                `${instance}/search?q=` +
                encodeURIComponent(searchQuery) +
                `&format=json&language=en&categories=general`;


              const response =
                await fetch(searchUrl, {

                  method: "GET",

                  headers: {
                    "Accept": "application/json",
                    "User-Agent":
                      "Mozilla/5.0 NOVA Procurement AI"
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
                response.headers.get(
                  "content-type"
                ) || "";


              if (
                !contentType
                  .toLowerCase()
                  .includes("json")
              ) {

                return {
                  instance,
                  success: false,
                  results: []
                };

              }


              const data =
                await response.json();


              if (
                !Array.isArray(
                  data.results
                )
              ) {

                return {
                  instance,
                  success: false,
                  results: []
                };

              }


              return {

                instance,

                success: true,

                results:
                  data.results

              };

            } catch (error) {

              return {

                instance,

                success: false,

                results: []

              };

            }

          }
        );


        const responses =
          await Promise.all(searches);


        let combinedResults = [];

        let successfulSources = [];


        for (
          const response
          of responses
        ) {

          if (!response.success) {
            continue;
          }


          successfulSources.push(
            response.instance
          );


          for (
            const item
            of response.results
          ) {

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
                item.description ||
                "",

              source:
                response.instance

            });

          }

        }


        // Remove duplicate URLs

        const unique =
          new Map();


        for (
          const item
          of combinedResults
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
          ).slice(0, 50);


        /*
          IMPORTANT:

          We return results in TWO places.

          1. data.results
             for the new NOVA page.

          2. data.yep_response.results
             for the old NOVA page.

          This makes both versions work.
        */


        return Response.json({

          success: true,

          request:
            procurementRequest,

          query:
            searchQuery,

          source:
            "NOVA Multi-Source Web Search",

          sourcesChecked:
            instances.length,

          successfulSources:
            successfulSources.length,

          successfulSourceList:
            successfulSources,

          resultCount:
            results.length,

          results:
            results,

          yep_response: {

            success: true,

            query:
              searchQuery,

            results:
              results

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


    // Website files

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
