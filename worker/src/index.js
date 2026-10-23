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
