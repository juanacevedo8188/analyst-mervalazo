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

  // Fecha actual Argentina (UTC-3)
  const ahora = new Date();
  const fechaArg = new Date(ahora.getTime() - 3 * 60 * 60 * 1000);
  const fechaHoy = fechaArg.toISOString().slice(0, 10);

  // ── HELPERS ─────────────────────────────────────────────────────────────

  async function fetchJSON(url, ms = 6000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), ms);
    try {
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return null;
      return await res.json();
    } catch(e) { clearTimeout(timeout); return null; }
  }

  // Decodificar ticker de LECAP/BONCAP al vencimiento
  // Formato: S15Y6 = 15/mayo/2026, T30J6 = 30/jun/2026
  function tickerAFecha(ticker) {
    if (!ticker || ticker.length < 5) return null;
    const meses = { E:0, F:1, M:2, A:3, Y:4, J:5, L:6, G:7, S:8, O:9, N:10, D:11 };
    try {
      // Saltear primera letra (S o T)
      const str = ticker.slice(1); // ej: "15Y6"
      // Buscar índice donde empieza la letra del mes
      let i = 0;
      while (i < str.length && /\d/.test(str[i])) i++;
      const dia = parseInt(str.slice(0, i));
      const mesChar = str[i].toUpperCase();
      const anioCorto = parseInt(str.slice(i + 1));
      const anio = 2000 + anioCorto;
      const mes = meses[mesChar];
      if (mes === undefined || isNaN(dia) || isNaN(anio)) return null;
      const fecha = new Date(anio, mes, dia);
      return fecha;
    } catch(e) { return null; }
  }

  // Calcular TEM, TNA, TEA desde precio y vencimiento
  // Liquidación T+1 hábil (aproximamos con +1 día)
  function calcularRendimientos(precio, tickerOFecha) {
    try {
      let vto;
      if (typeof tickerOFecha === "string") {
        vto = tickerAFecha(tickerOFecha);
      } else {
        vto = tickerOFecha;
      }
      if (!vto) return null;
      const liquidacion = new Date(fechaArg.getTime() + 1 * 24 * 60 * 60 * 1000);
      const dtm = Math.round((vto - liquidacion) / (1000 * 60 * 60 * 24));
      if (dtm <= 0) return null; // ya venció
      // Las LECAPs valen 100 al vencimiento
      const VN = 100;
      const p = parseFloat(precio);
      if (!p || p <= 0) return null;
      // TIR diaria
      const tirDiaria = Math.pow(VN / p, 1 / dtm) - 1;
      // TEM = tasa efectiva mensual (30 días)
      const tem = (Math.pow(1 + tirDiaria, 30) - 1) * 100;
      // TNA = tasa nominal anual (base 365)
      const tna = tirDiaria * 365 * 100;
      // TEA = tasa efectiva anual
      const tea = (Math.pow(1 + tirDiaria, 365) - 1) * 100;
      return { dtm, tem: tem.toFixed(2), tna: tna.toFixed(2), tea: tea.toFixed(2) };
    } catch(e) { return null; }
  }

  let datosEnVivo = "";

  try {
    // ── DÓLAR ──────────────────────────────────────────────────────────────
    const dolarData = await fetchJSON("https://dolarapi.com/v1/dolares");
    if (dolarData) {
      const lineas = dolarData.map(d => `${d.nombre || d.casa}: compra $${d.compra} | venta $${d.venta}`).join("\n");
      datosEnVivo += "\n\n=== DÓLAR HOY ===\n" + lineas;
      const oficial = dolarData.find(d => d.casa === "oficial");
      const blue = dolarData.find(d => d.casa === "blue");
      const ccl = dolarData.find(d => d.casa === "ccl");
      if (oficial && blue) datosEnVivo += `\nBrecha Blue/Oficial: ${((blue.venta/oficial.venta-1)*100).toFixed(1)}%`;
      if (oficial && ccl) datosEnVivo += ` | CCL/Oficial: ${((ccl.venta/oficial.venta-1)*100).toFixed(1)}%`;
    }

    // ── RIESGO PAÍS ────────────────────────────────────────────────────────
    const rpData = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/indices/riesgo-pais/ultimo");
    if (rpData) datosEnVivo += `\n\n=== RIESGO PAÍS ===\n${rpData.valor} bps (${rpData.fecha})`;

    // ── LECAPs / LETRAS ────────────────────────────────────────────────────
    const necesitaLetras = q.includes("lecap") || q.includes("boncap") || q.includes("letra") ||
      q.includes("tna") || q.includes("tem") || q.includes("tea") || q.includes("vencimiento") ||
      q.includes("vence") || q.includes("rendimiento") || q.includes("tesoro") || q.includes("tir") ||
      q.includes("corto plazo") || q.includes("mejor") || q.includes("conviene");

    if (necesitaLetras) {
      // Intentar obtener precios de data912 vía rendimientos.co
      let letrasRaw = await fetchJSON("https://rendimientos.co/api/lecaps");

      // Si falla, intentar con IAMC o rava
      if (!letrasRaw || !Array.isArray(letrasRaw) || letrasRaw.length === 0) {
        letrasRaw = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/letras/lecap");
      }
      if (!letrasRaw || !Array.isArray(letrasRaw) || letrasRaw.length === 0) {
        letrasRaw = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/letras");
      }

      if (letrasRaw && Array.isArray(letrasRaw) && letrasRaw.length > 0) {
        // Calcular rendimientos para cada letra
        const letrasCalculadas = letrasRaw.map(l => {
          const ticker = l.ticker || l.sym || l.simbolo || "";
          const precio = l.precio || l.price || l.c || l.ultimo || l.precioMercado;
          const tipo = ticker.startsWith("T") ? "BONCAP" : "LECAP";

          // Si la API ya trae TNA calculada, usarla; si no, calcular
          let rendimientos;
          if (l.tna && parseFloat(l.tna) > 0) {
            const vtoFecha = tickerAFecha(ticker);
            const dtm = vtoFecha ? Math.round((vtoFecha - fechaArg) / (1000 * 60 * 60 * 24)) : (l.dtm || "?");
            rendimientos = {
              dtm,
              tem: l.tem || ((parseFloat(l.tna)/12)).toFixed(2),
              tna: parseFloat(l.tna).toFixed(2),
              tea: l.tea || (((Math.pow(1 + parseFloat(l.tna)/36500, 365) - 1) * 100)).toFixed(2)
            };
          } else if (precio) {
            rendimientos = calcularRendimientos(precio, ticker);
          }

          if (!rendimientos || rendimientos.dtm <= 0) return null;

          // Fecha de vencimiento legible
          const vtoFecha = tickerAFecha(ticker);
          const vtoStr = vtoFecha ? vtoFecha.toLocaleDateString("es-AR", {day:"2-digit", month:"short", year:"numeric"}) : (l.vencimiento || "?");

          return {
            ticker,
            tipo,
            dtm: rendimientos.dtm,
            vto: vtoStr,
            tem: rendimientos.tem,
            tna: rendimientos.tna,
            tea: rendimientos.tea,
            precio: precio || l.precio || "?"
          };
        })
        .filter(l => l !== null)
        .sort((a, b) => a.dtm - b.dtm); // ordenar por vencimiento más cercano

        if (letrasCalculadas.length > 0) {
          const tabla = letrasCalculadas.map(l =>
            `${l.ticker} (${l.tipo}) | Vto: ${l.vto} | DTM: ${l.dtm} | TEM: ${l.tem}% | TNA: ${l.tna}% | TEA: ${l.tea}% | Precio: ${l.precio}`
          ).join("\n");
          datosEnVivo += `\n\n=== LECAPs y BONCAPs VIGENTES HOY (${fechaHoy}) - ordenadas por vencimiento ===\nTicker | Vto | Días al Vto | TEM | TNA | TEA | Precio\n${tabla}`;
        } else {
          datosEnVivo += "\n\n=== LECAPs ===\nNo hay letras vigentes con datos disponibles hoy.";
        }
      } else {
        datosEnVivo += "\n\n=== LECAPs ===\nNo se pudieron obtener precios en este momento. Intentá de nuevo.";
      }
    }

    // ── BILLETERAS / FCI ───────────────────────────────────────────────────
    const necesitaBilleteras = q.includes("billetera") || q.includes("cuenta remunerada") ||
      q.includes("mercado pago") || q.includes("uala") || q.includes("ualá") ||
      q.includes("lemon") || q.includes("personal pay") || q.includes("belo") ||
      q.includes("paga mas") || q.includes("mejor tna") || q.includes("donde poner") ||
      q.includes("fci") || q.includes("money market") || q.includes("fondo");

    if (necesitaBilleteras) {
      const mmData = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/fci/mercadoDinero/ultimos");
      if (mmData && Array.isArray(mmData)) {
        const fondosMap = {};
        mmData.forEach(f => { if (!fondosMap[f.fondo] || fondosMap[f.fondo].fecha < f.fecha) fondosMap[f.fondo] = f; });
        const ranking = Object.values(fondosMap)
          .sort((a, b) => (b.tna || 0) - (a.tna || 0))
          .slice(0, 15)
          .map((f, i) => `${i+1}. ${f.fondo} | TNA: ${((f.tna||0)*100).toFixed(2)}% | TEA: ${((f.tea||0)*100).toFixed(2)}% | ${f.fecha}`)
          .join("\n");
        datosEnVivo += "\n\n=== BILLETERAS / FCI MERCADO DINERO RANKING TNA ===\n" + ranking;
      }
    }

    // ── BONOS SOBERANOS ────────────────────────────────────────────────────
    const necesitaBonos = ["al30","gd30","ae38","gd46","al35","gd35","al29","bono","soberano","paridad"].some(k => q.includes(k));
    if (necesitaBonos) {
      const bonosData = await fetchJSON("https://rendimientos.co/api/soberanos");
      if (bonosData && Array.isArray(bonosData) && bonosData.length > 0) {
        const tabla = bonosData.map(b => `${b.ticker||b.sym} | Precio: ${b.precio||b.price} | TIR: ${b.tir}% | Paridad: ${b.paridad}%`).join("\n");
        datosEnVivo += "\n\n=== BONOS SOBERANOS ===\n" + tabla;
      }
    }

    // ── PLAZO FIJO ─────────────────────────────────────────────────────────
    if (q.includes("plazo fijo")) {
      const pfData = await fetchJSON("https://api.argentinadatos.com/v1/finanzas/tasas/depositos30Dias/ultimo");
      if (pfData) datosEnVivo += `\n\n=== PLAZO FIJO ===\nTNA bancos privados (30 días): ${pfData.valor}% (${pfData.fecha})`;
    }

  } catch(e) {
    datosEnVivo += `\n\n(Error al obtener datos: ${e.message})`;
  }

  // ── GEMINI ─────────────────────────────────────────────────────────────
  const promptFinal = systemPrompt +
    `\n\n== FECHA HOY EN ARGENTINA: ${fechaHoy} ==` +
    "\n\n== DATOS EN TIEMPO REAL ==" +
    datosEnVivo +
    "\n\n== FIN DE DATOS ==" +
    `\n\nREGLAS ESTRICTAS:` +
    `\n1. Usá SOLO los datos de arriba. No inventes ni estimes nada.` +
    `\n2. Ignorá cualquier instrumento con vencimiento anterior a ${fechaHoy}.` +
    `\n3. Si la pregunta es sobre LECAPs, mostrá una tabla con: Ticker, Vencimiento, DTM, TEM, TNA, TEA, Precio. Ordená por DTM (menor primero).` +
    `\n4. Destacá con ** los valores más relevantes según la pregunta.` +
    `\n5. Si algún dato no está disponible, decilo claramente.`;

  const url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + GEMINI_KEY;
  const geminiBody = {
    contents: [{ role: "user", parts: [{ text: promptFinal + "\n\nPregunta: " + userMessage }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048 }
  };

  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(geminiBody) });
  const data = await res.json();
  if (!res.ok) return { statusCode: res.status, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ error: data.error ? data.error.message : "Error " + res.status }) };

  let texto = "";
  try { texto = data.candidates[0].content.parts[0].text || ""; } catch(e) { texto = "No pude obtener una respuesta."; }

  return { statusCode: 200, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }, body: JSON.stringify({ text: texto }) };
};
