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

  let datosEnVivo = "";

  // Helper para fetch con timeout
  async function fetchConTimeout(url, ms = 5000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      return await res.json();
    } catch(e) {
      clearTimeout(timeout);
      return null;
    }
  }

  try {
    // ── DÓLAR (siempre) ───────────────────────────────────────────────────
    const dolarData = await fetchConTimeout("https://dolarapi.com/v1/dolares");
    if (dolarData) {
      const lineas = dolarData.map(d => `${d.nombre || d.casa}: compra $${d.compra} | venta $${d.venta}`).join("\n");
      datosEnVivo += "\n\n=== DÓLAR HOY (dolarapi.com) ===\n" + lineas;
      // Calcular brecha
      const oficial = dolarData.find(d => d.casa === "oficial");
      const blue = dolarData.find(d => d.casa === "blue");
      const ccl = dolarData.find(d => d.casa === "ccl");
      const mep = dolarData.find(d => d.casa === "mep");
      if (oficial && blue) {
        datosEnVivo += `\nBrecha Blue/Oficial: ${((blue.venta/oficial.venta-1)*100).toFixed(1)}%`;
      }
      if (oficial && ccl) {
        datosEnVivo += ` | Brecha CCL/Oficial: ${((ccl.venta/oficial.venta-1)*100).toFixed(1)}%`;
      }
    }

    // ── RIESGO PAÍS (siempre) ─────────────────────────────────────────────
    const rpData = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo");
    if (rpData) {
      datosEnVivo += `\n\n=== RIESGO PAÍS ===\n${rpData.valor} bps (${rpData.fecha})`;
    }

    // ── LECAPs / BONCAPs / LETRAS ─────────────────────────────────────────
    const necesitaLetras = q.includes("lecap") || q.includes("boncap") || q.includes("letra") ||
      q.includes("tna") || q.includes("tem") || q.includes("tea") || q.includes("vencimiento") ||
      q.includes("vence") || q.includes("rendimiento") || q.includes("tesoro") || q.includes("tir") ||
      q.includes("plazo") || q.includes("corto plazo");

    if (necesitaLetras) {
      // Intentar endpoint de rendimientos.co directamente
      const lecapsData = await fetchConTimeout("https://rendimientos.co/api/lecaps");
      if (lecapsData && Array.isArray(lecapsData) && lecapsData.length > 0) {
        const tabla = lecapsData.map(l =>
          `${l.ticker || l.sym} | DTM: ${l.dtm || l.diasAlVencimiento} | TEM: ${l.tem || l.tasa}% | TNA: ${l.tna}% | TEA: ${l.tea}% | Precio: ${l.precio || l.price}`
        ).join("\n");
        datosEnVivo += "\n\n=== LECAPs EN TIEMPO REAL (rendimientos.co) ===\nSYM | DTM | TEM | TNA | TEA | PRECIO\n" + tabla;
      } else {
        // Fallback: ROFEX/IAMC vía argentinadatos
        const letrasAlt = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/letras/lecap");
        if (letrasAlt && Array.isArray(letrasAlt) && letrasAlt.length > 0) {
          const tabla = letrasAlt.map(l =>
            `${l.ticker} | Vto: ${l.vencimiento} | TNA: ${l.tna}% | TEA: ${l.tea}% | Precio: ${l.precio}`
          ).join("\n");
          datosEnVivo += "\n\n=== LECAPs (argentinadatos.com) ===\n" + tabla;
        } else {
          // Fallback 2: IAMC cotizaciones letras
          const letrasIAMC = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/letras");
          if (letrasIAMC && Array.isArray(letrasIAMC) && letrasIAMC.length > 0) {
            const tabla = letrasIAMC.slice(0, 20).map(l =>
              `${JSON.stringify(l)}`
            ).join("\n");
            datosEnVivo += "\n\n=== LETRAS DATOS RAW ===\n" + tabla;
          } else {
            datosEnVivo += "\n\n=== LECAPs ===\nNo se pudo obtener cotizaciones en tiempo real. Los datos de LECAPs y BONCAPs se obtienen de BYMA/ROFEX con retardo.";
          }
        }
      }
    }

    // ── BILLETERAS / FCI ──────────────────────────────────────────────────
    const necesitaBilleteras = q.includes("billetera") || q.includes("cuenta remunerada") ||
      q.includes("mercado pago") || q.includes("uala") || q.includes("ualá") ||
      q.includes("lemon") || q.includes("personal pay") || q.includes("belo") ||
      q.includes("paga mas") || q.includes("mejor tna") || q.includes("donde poner") ||
      q.includes("fci") || q.includes("money market") || q.includes("fondo");

    if (necesitaBilleteras) {
      // FCI mercado dinero
      const mmData = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/ultimos");
      if (mmData && Array.isArray(mmData)) {
        const fondosMap = {};
        mmData.forEach(f => {
          if (!fondosMap[f.fondo] || fondosMap[f.fondo].fecha < f.fecha) fondosMap[f.fondo] = f;
        });
        const ranking = Object.values(fondosMap)
          .sort((a, b) => (b.tna || 0) - (a.tna || 0))
          .slice(0, 15)
          .map((f, i) => `${i+1}. ${f.fondo} | TNA: ${((f.tna||0)*100).toFixed(2)}% | TEA: ${((f.tea||0)*100).toFixed(2)}% | Fecha: ${f.fecha}`)
          .join("\n");
        datosEnVivo += "\n\n=== BILLETERAS / FCI MERCADO DINERO - RANKING POR TNA (datos hoy) ===\n" + ranking;
      }

      // También FCI renta fija
      const rfData = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/fci/rentaFija/ultimos");
      if (rfData && Array.isArray(rfData)) {
        const fondosMap = {};
        rfData.forEach(f => {
          if (!fondosMap[f.fondo] || fondosMap[f.fondo].fecha < f.fecha) fondosMap[f.fondo] = f;
        });
        const ranking = Object.values(fondosMap)
          .sort((a, b) => (b.tna || 0) - (a.tna || 0))
          .slice(0, 10)
          .map((f, i) => `${i+1}. ${f.fondo} | TNA: ${((f.tna||0)*100).toFixed(2)}% | TEA: ${((f.tea||0)*100).toFixed(2)}%`)
          .join("\n");
        datosEnVivo += "\n\n=== FCI RENTA FIJA TOP 10 ===\n" + ranking;
      }
    }

    // ── BONOS SOBERANOS ───────────────────────────────────────────────────
    const necesitaBonos = q.includes("al30") || q.includes("gd30") || q.includes("ae38") ||
      q.includes("gd46") || q.includes("al35") || q.includes("gd35") || q.includes("al29") ||
      q.includes("bono") || q.includes("soberano") || q.includes("paridad");

    if (necesitaBonos) {
      const bonosData = await fetchConTimeout("https://rendimientos.co/api/soberanos");
      if (bonosData && Array.isArray(bonosData) && bonosData.length > 0) {
        const tabla = bonosData.map(b =>
          `${b.ticker || b.sym} | Precio: ${b.precio || b.price} | TIR: ${b.tir}% | Paridad: ${b.paridad}%`
        ).join("\n");
        datosEnVivo += "\n\n=== BONOS SOBERANOS EN TIEMPO REAL (rendimientos.co) ===\n" + tabla;
      }
    }

    // ── PLAZO FIJO ────────────────────────────────────────────────────────
    if (q.includes("plazo fijo")) {
      const pfData = await fetchConTimeout("https://api.argentinadatos.com/v1/finanzas/tasas/depositos30Dias/ultimo");
      if (pfData) {
        datosEnVivo += `\n\n=== PLAZO FIJO ===\nTNA bancos privados (depósitos 30 días): ${pfData.valor}% (${pfData.fecha})`;
      }
    }

  } catch(e) {
    datosEnVivo += `\n\n(Error parcial al obtener datos: ${e.message})`;
  }

  // ── LLAMADA A GEMINI ──────────────────────────────────────────────────
  // Fecha actual en Argentina (UTC-3)
  const ahora = new Date();
  const fechaArg = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  const fechaHoy = fechaArg.toISOString().slice(0, 10);

  const promptFinal = systemPrompt +
    "\n\n== FECHA Y HORA ACTUAL EN ARGENTINA: " + fechaHoy + " ==" +
    "\n\n== DATOS OBTENIDOS EN TIEMPO REAL AHORA ==" +
    datosEnVivo +
    "\n\n== FIN DE DATOS EN TIEMPO REAL ==" +
    "\n\nIMPORTANTE: " +
    "\n1. Usá EXCLUSIVAMENTE los datos de arriba para responder con números exactos." +
    "\n2. La fecha de hoy es " + fechaHoy + ". IGNORÁ cualquier letra o instrumento cuya fecha de vencimiento ya pasó (sea anterior a hoy)." +
    "\n3. Solo mostrá letras con vencimiento FUTURO (mayor a " + fechaHoy + ")." +
    "\n4. Ordená las letras por fecha de vencimiento de menor a mayor (las que vencen antes primero)." +
    "\n5. No inventes ni estimes nada. Si algún dato falta, decilo claramente.";

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_KEY;

  const geminiBody = {
    contents: [{ role: "user", parts: [{ text: promptFinal + "\n\nPregunta del usuario: " + userMessage }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: 2048 }
  };

  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(geminiBody) });
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
