exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const { request } = JSON.parse(event.body || "{}");

    if (!request || !request.trim()) {
      return {
        statusCode: 400,
        body: JSON.stringify({
          error: "Please enter a procurement request."
        })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        request: request,

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
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Server error."
      })
    };
  }
};
