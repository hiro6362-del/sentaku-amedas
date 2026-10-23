// 洗濯アメダス：雨雲画像を24時間ためるサーバー
// 10分ごとに、登録された地点のまわりの気象庁レーダー画像（降水ナウキャスト実況）を保存し、
// アプリから /tile/{validtime}/{z}/{x}/{y}.png で取り出せるようにする。
const NOWC = "https://www.jma.go.jp/bosai/jmatile/data/nowc";
const Z = 8;                 // 保存するズーム（1ピクセル約0.5km。レーダーは1kmメッシュなので十分）
const RADIUS_KM = 40;        // 地点のまわりの保存範囲
const KEEP_HOURS = 25;       // 保存しておく時間
const ACTIVE_DAYS = 30;      // この日数アプリが開かれていない地点は保存を止める
const MAX_PLACES = 300;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...CORS } });

const tx = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const ty = (lat, z) => { const r = lat * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
function tilesAround(lat, lon) {
  const dLat = RADIUS_KM / 111, dLon = RADIUS_KM / (111 * Math.cos(lat * Math.PI / 180));
  const out = [];
  for (let x = tx(lon - dLon, Z); x <= tx(lon + dLon, Z); x++)
    for (let y = ty(lat + dLat, Z); y <= ty(lat - dLat, Z); y++) out.push(`${x}/${y}`);
  return out;
}
const utcKey = d => d.toISOString().replace(/[-:T]/g, "").slice(0, 14);
const validPoint = (lat, lon) => Number.isFinite(lat) && Number.isFinite(lon) && lat > 20 && lat < 46 && lon > 122 && lon < 154;

async function collect(env) {
  const started = new Date().toISOString();
  try{
    const saved = await collectInner(env);
    await setMeta(env, {last_run: started, last_error: "", last_saved: String(saved)});
  }catch(e){
    await setMeta(env, {last_run: started, last_error: String(e && e.stack || e)}).catch(() => {});
    throw e;
  }
}
async function setMeta(env, kv){
  await env.DB.batch(Object.entries(kv).map(([k, v]) => env.DB.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").bind(k, v)));
}

async function collectInner(env) {
  const now = Date.now(), nowc = env.NOWC || NOWC;   // NOWC は動作確認用の差し替え口
  const places = (await env.DB.prepare("SELECT lat, lon FROM places WHERE last_seen > ?")
    .bind(now - ACTIVE_DAYS * 86400e3).all()).results;
  await env.DB.prepare("DELETE FROM frames WHERE validtime < ?").bind(utcKey(new Date(now - KEEP_HOURS * 3600e3))).run();
  if (!places.length) return 0;
  let saved = 0;

  const tiles = new Set(places.flatMap(p => tilesAround(p.lat, p.lon)));
  const times = await (await fetch(`${nowc}/targetTimes_N1.json`)).json();
  // 直近30分ぶんのうち、まだ保存していない時刻を拾う（cronが遅れても取りこぼさない）
  const recent = times.filter(t => (!t.elements || t.elements.includes("hrpns")) && t.validtime >= utcKey(new Date(now - 30 * 60e3)));
  for (const t of recent) {
    if (!/^\d{12}00$/.test(t.validtime) || Number(t.validtime.slice(10, 12)) % 10) continue;   // アプリは10分刻みなので10分ごとだけ保存
    const have = new Set((await env.DB.prepare("SELECT x, y FROM frames WHERE validtime = ? AND z = ?")
      .bind(t.validtime, Z).all()).results.map(r => `${r.x}/${r.y}`));
    const todo = [...tiles].filter(k => !have.has(k));
    const rows = await Promise.all(todo.map(async k => {
      const r = await fetch(`${nowc}/${t.basetime}/none/${t.validtime}/surf/hrpns/${Z}/${k}.png`);
      // 雨のないタイルは空（png=null）で記録して、二度取りしない
      const png = r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
      const [x, y] = k.split("/").map(Number);
      return env.DB.prepare("INSERT OR IGNORE INTO frames (validtime, z, x, y, png) VALUES (?, ?, ?, ?, ?)")
        .bind(t.validtime, Z, x, y, png && png.length ? png : null);
    }));
    if (rows.length) await env.DB.batch(rows);
    saved += rows.length;
  }
  return saved;
}


// ---- 一時的な確認用：登録地点の今のレーダー色と最寄りアメダスの雨量を比べる（確認後に削除） ----
async function pngPixel(buf, px, py) {
  const u = new Uint8Array(buf), dv = new DataView(buf);
  let p = 8, w = 0, h = 0, depth = 0, ctype = 0, pal = null, trns = null; const idat = [];
  while (p < u.length) {
    const len = dv.getUint32(p), type = String.fromCharCode(...u.slice(p + 4, p + 8)), d = u.slice(p + 8, p + 8 + len);
    if (type === "IHDR") { w = dv.getUint32(p + 8); h = dv.getUint32(p + 12); depth = u[p + 16]; ctype = u[p + 17]; }
    else if (type === "PLTE") pal = d; else if (type === "tRNS") trns = d; else if (type === "IDAT") idat.push(d);
    p += 12 + len;
  }
  const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
  const bpp = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype] * (depth / 8), stride = Math.ceil(w * ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]) * depth / 8);
  const out = new Uint8Array(h * stride); let prev = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)), cur = out.subarray(y * stride, (y + 1) * stride);
    const b = Math.max(1, bpp);
    for (let i = 0; i < stride; i++) {
      const a = i >= b ? cur[i - b] : 0, up = prev[i], c = i >= b ? prev[i - b] : 0;
      let v = line[i];
      if (f === 1) v += a; else if (f === 2) v += up; else if (f === 3) v += (a + up) >> 1;
      else if (f === 4) { const pp = a + up - c, pa = Math.abs(pp - a), pb = Math.abs(pp - up), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c; }
      cur[i] = v & 255;
    }
    prev = cur;
  }
  let r, g, bl, al = 255;
  if (ctype === 3) {
    const bits = depth, idx = (out[py * stride + Math.floor(px * bits / 8)] >> (8 - bits - (px * bits) % 8)) & ((1 << bits) - 1);
    r = pal[idx * 3]; g = pal[idx * 3 + 1]; bl = pal[idx * 3 + 2]; al = trns && idx < trns.length ? trns[idx] : 255;
  } else if (ctype === 6) { const o = py * stride + px * 4; [r, g, bl, al] = out.slice(o, o + 4); }
  else if (ctype === 2) { const o = py * stride + px * 3; [r, g, bl] = out.slice(o, o + 3); }
  return { w, h, ctype, depth, rgba: [r, g, bl, al] };
}
async function check(env) {
  const places = (await env.DB.prepare("SELECT lat, lon FROM places").all()).results;
  const table = await (await fetch("https://www.jma.go.jp/bosai/amedas/const/amedastable.json")).json();
  const latest = (await (await fetch("https://www.jma.go.jp/bosai/amedas/data/latest_time.txt")).text()).trim();
  const lt = new Date(latest), j = new Date(lt.getTime() + 9 * 3600e3);
  const pad = n => String(n).padStart(2, "0");
  const file = `${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}_${pad(Math.floor(j.getUTCHours() / 3) * 3)}`;
  const times = await (await fetch(`${NOWC}/targetTimes_N1.json`)).json();
  const t = times[0], z = 10;
  const out = [];
  for (const pl of places) {
    const near = Object.entries(table).map(([code, s]) => { const la = s.lat[0] + s.lat[1] / 60, lo = s.lon[0] + s.lon[1] / 60; return { code, name: s.kjName, km: Math.hypot((la - pl.lat) * 111, (lo - pl.lon) * 91) }; }).sort((a, b) => a.km - b.km).slice(0, 3);
    for (const n of near) {
      const d = await (await fetch(`https://www.jma.go.jp/bosai/amedas/data/point/${n.code}/${file}.json`)).json().catch(() => ({}));
      const keys = Object.keys(d).sort().slice(-3);
      n.last = keys.map(k => [k.slice(8, 12), d[k].precipitation10m?.[0], d[k].precipitation1h?.[0]]);
      delete n.code;
    }
    const fx = (pl.lon + 180) / 360 * 2 ** z * 256, r = pl.lat * Math.PI / 180, fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z * 256;
    const tile = await fetch(`${NOWC}/${t.basetime}/none/${t.validtime}/surf/hrpns/${z}/${Math.floor(fx / 256)}/${Math.floor(fy / 256)}.png`);
    let radar = { status: tile.status };
    if (tile.ok) {
      const buf = await tile.arrayBuffer();
      radar = { ...(await pngPixel(buf, Math.floor(fx) % 256, Math.floor(fy) % 256)), bytes: buf.byteLength };
      // まわり（約±5km）の色付き画素の割合
      const cnt = { colored: 0, total: 0 };
      for (let dy = -20; dy <= 20; dy += 5) for (let dx = -20; dx <= 20; dx += 5) {
        const x = Math.floor(fx) % 256 + dx, y = Math.floor(fy) % 256 + dy;
        if (x < 0 || y < 0 || x > 255 || y > 255) continue;
        const q = await pngPixel(buf, x, y); cnt.total++; if (q.rgba[3] > 0) cnt.colored++;
      }
      radar.around = cnt;
    }
    out.push({ near, radar, radarTime: t.validtime });
  }
  return { amedasLatest: latest, places: out };
}

async function handle(req, env) {
  const url = new URL(req.url), parts = url.pathname.split("/").filter(Boolean);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  // 雨雲タイル
  if (req.method === "GET" && parts[0] === "tile" && parts.length === 5) {
    const [, vt, z, x, yPng] = parts, y = parseInt(yPng, 10);
    const row = await env.DB.prepare("SELECT png FROM frames WHERE validtime = ? AND z = ? AND x = ? AND y = ?")
      .bind(vt, Number(z), Number(x), y).first();
    if (!row) return new Response("not stored", { status: 404, headers: CORS });
    if (!row.png) return new Response(null, { status: 204, headers: { ...CORS, "Cache-Control": "public, max-age=86400" } });
    return new Response(new Uint8Array(row.png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400", ...CORS } });
  }
  // 保存している時刻の一覧
  if (req.method === "GET" && parts[0] === "times") {
    const r = await env.DB.prepare("SELECT DISTINCT validtime FROM frames ORDER BY validtime").all();
    return json(r.results.map(x => x.validtime));
  }
  if (req.method === "GET" && parts[0] === "check-k7q2") return json(await check(env));
  // 動作確認用：登録地点の数と最後の保存処理の結果
  if (req.method === "GET" && parts[0] === "status") {
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM places").first()).n;
    const f = (await env.DB.prepare("SELECT COUNT(*) AS n FROM frames").first()).n;
    const meta = Object.fromEntries((await env.DB.prepare("SELECT k, v FROM meta").all()).results.map(r => [r.k, r.v]));
    const t = (await env.DB.prepare("SELECT validtime, COUNT(*) AS n, SUM(png IS NOT NULL) AS rain FROM frames GROUP BY validtime ORDER BY validtime DESC LIMIT 6").all()).results;
    return json({ places: n, frames: f, recent: t, ...meta });
  }
  // 地点の登録
  if (req.method === "POST" && parts[0] === "places" && parts.length === 1) {
    const b = await req.json().catch(() => ({}));
    const lat = Math.round(Number(b.lat) * 100) / 100, lon = Math.round(Number(b.lon) * 100) / 100;   // 約1km単位に丸める
    if (!validPoint(lat, lon)) return json({ error: "日本の範囲の緯度経度を指定してください" }, 400);
    const n = (await env.DB.prepare("SELECT COUNT(*) AS n FROM places").first()).n;
    if (n >= MAX_PLACES) return json({ error: "登録数の上限に達しています" }, 503);
    const id = crypto.randomUUID(), now = Date.now();
    await env.DB.prepare("INSERT INTO places (id, lat, lon, created, last_seen) VALUES (?, ?, ?, ?, ?)").bind(id, lat, lon, now, now).run();
    return json({ id });
  }
  // アプリを開いたときの「まだ使ってるよ」の合図
  if (req.method === "POST" && parts[0] === "places" && parts[2] === "seen") {
    const r = await env.DB.prepare("UPDATE places SET last_seen = ? WHERE id = ?").bind(Date.now(), parts[1]).run();
    return json({ ok: r.meta.changes > 0 }, r.meta.changes ? 200 : 404);
  }
  // 地点の登録解除
  if (req.method === "DELETE" && parts[0] === "places" && parts.length === 2) {
    await env.DB.prepare("DELETE FROM places WHERE id = ?").bind(parts[1]).run();
    return json({ ok: true });
  }
  if (parts.length === 0) return new Response("sentaku-radar: ok", { headers: CORS });
  return new Response("not found", { status: 404, headers: CORS });
}

export default {
  fetch: (req, env) => handle(req, env).catch(e => json({ error: String(e) }, 500)),
  scheduled: (event, env, ctx) => ctx.waitUntil(collect(env)),
};
