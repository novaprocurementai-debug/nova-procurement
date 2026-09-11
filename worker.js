export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return new Response("NOVA Procurement AI", { status: 200 });
    }

    try {
      const { request: procurementRequest } = await request.json();

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
        { error: "Server error." },
        { status: 500 }
      );
    }
  }
};
