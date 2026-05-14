// Netlify Function — scraping de rendimientos.co + análisis con Gemini

exports.handler = async function(event, context) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Allow-Methods": "POST, OPTIONS" }, body: "" };
  }
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method Not Allowed" };

  const GEMINI_KEY = process.env.GEMINI_API_KEY;
  if (!GEMINI_KEY) return { statusCode: 500, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: "GEMINI_API_KEY no configurada en Netlify" }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, body: JSON.stringify({ error: "Body inválido" }) }; }

  const systemPrompt = body.system || "";
  const userMessage = body.messages && body.messages[0] ? body.messages[0].content : "";
  const q = userMessage.toLowerCase();

  // ── DETECTAR QUÉ DATOS NECESITA Y SCRAPEAR EN TIEMPO REAL ──────────────
  let datosEnVivo = "";

  try {
    // Siempre traer dólar (es liviano y casi siempre relevante)
    const dolarRes = await fetch("https://dolarapi.com/v1/dolares");
    const dolarData = await dolarRes.json();
    const dolarTexto = dolarData.map(d =>
      d.casa + ": compra $" + d.compra + " venta $" + d.venta
    ).join(" | ");
    datosEnVivo += "\n\nDÓLAR EN TIEMPO REAL (dolarapi.com):\n" + dolarTexto;

    // Riesgo país
    const rpRes = await fetch("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo");
    const rpData = await rpRes.json();
    datosEnVivo += "\n\nRIESGO PAÍS ACTUAL: " + rpData.valor + " bps (fecha: " + rpData.fecha + ")";

    // Si pregunta sobre letras, LECAPs, BONCAPs, TNA, rendimientos
    if (q.includes("lecap") || q.includes("boncap") || q.includes("letra") || q.includes("tna") ||
        q.includes("tir") || q.includes("rendimiento") || q.includes("vencimiento") || q.includes("tesoro")) {
      
      // Traer letras desde argentinadatos
      const letrasRes = await fetch("https://api.argentinadatos.com/v1/finanzas/letras");
      if (letrasRes.ok) {
        const letrasData = await letrasRes.json();
        if (Array.isArray(letrasData) && letrasData.length > 0) {
          const letrasTexto = letrasData.slice(0, 20).map(l =>
            (l.ticker || l.nombre || "") + " | vto: " + (l.vencimiento || l.fechaVencimiento || "") +
            " | TNA: " + (l.tna || l.rendimiento || "") + "% | precio: " + (l.precio || l.precioMercado || "")
          ).join("\n");
          datosEnVivo += "\n\nLETRAS DEL TESORO EN TIEMPO REAL (argentinadatos.com):\n" + letrasTexto;
        }
      }

      // También traer FCI renta fija
      const fciRes = await fetch("https://api.argentinadatos.com/v1/finanzas/fci/rentaFija/ultimos");
      if (fciRes.ok) {
        const fciData = await fciRes.json();
        // Agrupar por fondo, tomar último
        const fondosMap = {};
        fciData.forEach(f => {
          if (!fondosMap[f.fondo] || fondosMap[f.fondo].fecha < f.fecha) fondosMap[f.fondo] = f;
        });
        const top10 = Object.values(fondosMap)
          .sort((a, b) => (b.tna || 0) - (a.tna || 0))
          .slice(0, 10)
          .map(f => f.fondo + " | TNA: " + ((f.tna || 0) * 100).toFixed(2) + "% | TEA: " + ((f.tea || 0) * 100).toFixed(2) + "%")
          .join("\n");
        datosEnVivo += "\n\nFCI RENTA FIJA TOP 10 POR TNA:\n" + top10;
      }
    }

    // Si pregunta sobre billeteras, cuentas remuneradas
    if (q.includes("billetera") || q.includes("cuenta remunerada") || q.includes("mercado pago") ||
        q.includes("ualá") || q.includes("uala") || q.includes("lemon") || q.includes("personal pay") ||
        q.includes("belo") || q.includes("donde poner") || q.includes("paga mas") || q.includes("mejor tna")) {
      
      const mmRes = await fetch("https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/ultimos");
      if (mmRes.ok) {
        const mmData = await mmRes.json();
        const fondosMap = {};
        mmData.forEach(f => {
          if (!fondosMap[f.fondo] || fondosMap[f.fondo].fecha < f.fecha) fondosMap[f.fondo] = f;
        });
        const top15 = Object.values(fondosMap)
          .sort((a, b) => (b.tna || 0) - (a.tna || 0))
          .slice(0, 15)
          .map((f, i) => (i + 1) + ". " + f.fondo + " | TNA: " + ((f.tna || 0) * 100).toFixed(2) + "% | TEA: " + ((f.tea || 0) * 100).toFixed(2) + "%")
          .join("\n");
        datosEnVivo += "\n\nBILLETERAS / FCI MERCADO DE DINERO - RANKING POR TNA (datos hoy):\n" + top15;
      }
    }

    // Si pregunta sobre bonos soberanos
    if (q.includes("al30") || q.includes("gd30") || q.includes("ae38") || q.includes("gd46") ||
        q.includes("bono") || q.includes("paridad") || q.includes("soberano")) {
      
      const bonosRes = await fetch("https://api.argentinadatos.com/v1/finanzas/bonos");
      if (bonosRes.ok) {
        const bonosData = await bonosRes.json();
        if (Array.isArray(bonosData) && bonosData.length > 0) {
          const bonosTexto = bonosData.slice(0, 15).map(b =>
            (b.ticker || b.nombre || "") + " | precio: " + (b.precio || "") +
            " | TIR: " + (b.tir || b.rendimiento || "") + "% | paridad: " + (b.paridad || "") + "%"
          ).join("\n");
          datosEnVivo += "\n\nBONOS SOBERANOS EN TIEMPO REAL:\n" + bonosTexto;
        }
      }
    }

  } catch(e) {
    datosEnVivo += "\n\n(No se pudieron obtener algunos datos en tiempo real: " + e.message + ")";
  }

  // ── LLAMAR A GEMINI CON LOS DATOS EN CONTEXTO ──────────────────────────
  const promptFinal = systemPrompt +
    "\n\n== DATOS EN TIEMPO REAL OBTENIDOS AHORA ==" +
    datosEnVivo +
    "\n\n== FIN DE DATOS EN TIEMPO REAL ==" +
    "\n\nUsá estos datos para responder con precisión. Si el dato que necesitás está arriba, usalo directamente. No digas que no tenés información si está en los datos de arriba.";

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_KEY;

  const geminiBody = {
    contents: [{ role: "user", parts: [{ text: promptFinal + "\n\nPregunta del usuario: " + userMessage }] }],
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048 }
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(geminiBody),
  });

  const data = await res.json();

  if (!res.ok) {
    return { statusCode: res.status, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: data.error ? data.error.message : "Error Gemini " + res.status }) };
  }

  let texto = "";
  try { texto = data.candidates[0].content.parts[0].text || ""; } catch(e) { texto = "No pude obtener una respuesta."; }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({ text: texto })
  };
};
