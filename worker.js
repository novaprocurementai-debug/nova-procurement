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

        const yepResponse = await fetch(
          "https://platform.yep.com/api/search",
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${env.YEP_API_KEY}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              query: procurementRequest,
              type: "basic",
              limit: 10,
              language: ["en"]
            })
          }
        );

        const yepData = await yepResponse.json();

        return Response.json({
          nova: true,
          request: procurementRequest,
          yep_status: yepResponse.status,
          yep_response: yepData
        });

      } catch (error) {
        return Response.json(
          {
            error: "NOVA ERROR",
            details: error.message
          },
          { status: 500 }
        );
      }
    }

    if (env?.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("NOVA Procurement AI");
  }
};
