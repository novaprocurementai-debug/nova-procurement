export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      request.method === "POST" &&
      (
        url.pathname === "/" ||
        url.pathname === "/api/search" ||
        url.pathname === "/.netlify/functions/search"
      )
    ) {
      try {
        const body = await request.json();
        const procurementRequest = body.request;

        if (!procurementRequest || !procurementRequest.trim()) {
          return Response.json(
            { error: "Please enter a procurement request." },
            { status: 400 }
          );
        }

        return Response.json({
          success: true,
          request: procurementRequest,

          deal: {
            score: 91,
            targetPrice: "$2.20–$2.50",
            estimatedLandedCost: "$2.74",
            moq: "5,000 units",
            leadTime: "25–35 days",
            risk: "Low",
            estimatedSavings: "$4,300",
            recommendation: "Best Value Deal",

            reasons: [
              "Competitive unit price",
              "Reasonable MOQ",
              "Good estimated landed cost",
              "Balanced lead time and supplier risk"
            ]
          }
        });

      } catch (error) {
        return Response.json(
          {
            error: "Server error.",
            details: error.message
          },
          { status: 500 }
        );
      }
    }

    return env.ASSETS.fetch(request);
  }
};
