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
        body: JSON.stringify({ error: "Please enter a procurement request." })
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        message: "NOVA received your request.",
        request
      })
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Server error." })
    };
  }
};
