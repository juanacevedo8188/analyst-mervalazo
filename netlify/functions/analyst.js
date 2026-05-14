// Netlify Function — proxy seguro para Gemini API (gratis hasta 1500 req/día)

exports.handler = async function(event, context) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
      },
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) {
    return {
      statusCode: 500,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: "GEMINI_API_KEY no configurada en Netlify" }),
    };
  }

  let body;
  try { body = JSON.parse(event.body); } catch(e) {
    return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) };
  }

  const systemPrompt = body.system || "";
  const userMessage = body.messages && body.messages[0] ? body.messages[0].content : "";

  // Gemini 2.0 Flash con grounding (búsqueda web integrada)
  const geminiBody = {
    contents: [
      {
        role: "user",
        parts: [{ text: systemPrompt + "\n\nPregunta del usuario: " + userMessage }]
      }
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1024,
    }
  };

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=" + GEMINI_KEY;

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(geminiBody),
  });

  const data = await res.json();

  if (!res.ok) {
    return {
      statusCode: res.status,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ error: data.error ? data.error.message : "Error Gemini " + res.status }),
    };
  }

  // Extraer texto de la respuesta de Gemini
  let texto = "";
  try {
    texto = data.candidates[0].content.parts[0].text || "";
  } catch(e) {
    texto = "No pude obtener una respuesta.";
  }

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
    body: JSON.stringify({ text: texto }),
  };
};
