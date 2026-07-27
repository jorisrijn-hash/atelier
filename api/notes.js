// /api/notes.js  —  Atelier <-> Notion sync proxy (Vercel serverless function)
//
// Why this exists: the browser app can't call Notion directly (Notion blocks
// browser CORS) and the token must never live in client code. So the app calls
// THIS endpoint on your own domain, and this function talks to Notion with the
// secret token kept server-side.
//
// Required Vercel Environment Variables (Project -> Settings -> Environment Variables):
//   NOTION_TOKEN  = your Internal Integration Secret (from the Notion integration)
//   NOTION_DB_ID  = the Atelier database id. A PAGE id also works: this function
//                   will find the database inside that page automatically.
//                   (You can use 3aa779e3c51a8064a2afeaa15fb164db.)
// Optional:
//   SYNC_KEY      = any string. If set, the app must send the same value in the
//                   x-sync-key header. Soft gate against random callers. Not real
//                   security (the app is public), just a deterrent.
//
// Your Notion database MUST have these exact, case-sensitive properties:
//   Note  (Title),  Date  (Date),  AppID (Text)

const NOTION = "https://api.notion.com/v1";
const VERSION = "2022-06-28";
const TOKEN = process.env.NOTION_TOKEN;
const RAW_DB = process.env.NOTION_DB_ID;
const SYNC_KEY = process.env.SYNC_KEY || "";

const P_NOTE = "Note", P_DATE = "Date", P_APPID = "AppID";

const headers = () => ({
  Authorization: `Bearer ${TOKEN}`,
  "Notion-Version": VERSION,
  "Content-Type": "application/json",
});
const strip = (id) => (id || "").replace(/-/g, "").trim();
const textOf = (rich) => (rich || []).map((t) => t.plain_text || "").join("");

let cachedDb = null;
// Accept a database id, or a page id that contains one inline database.
async function resolveDb() {
  if (cachedDb) return cachedDb;
  const id = strip(RAW_DB);
  let r = await fetch(`${NOTION}/databases/${id}`, { headers: headers() });
  if (r.ok) { cachedDb = id; return id; }
  r = await fetch(`${NOTION}/blocks/${id}/children?page_size=100`, { headers: headers() });
  if (!r.ok) throw new Error(`Cannot resolve NOTION_DB_ID (${r.status}). Check the id and that the integration is connected to the page.`);
  const data = await r.json();
  const db = (data.results || []).find((b) => b.type === "child_database");
  if (!db) throw new Error("No database found in that page. Put a table inside the page, or set NOTION_DB_ID to the database's own id.");
  cachedDb = strip(db.id);
  return cachedDb;
}

function mapPage(p) {
  const props = p.properties || {};
  return {
    pageId: p.id,
    text: textOf(props[P_NOTE] && props[P_NOTE].title),
    date: (props[P_DATE] && props[P_DATE].date && props[P_DATE].date.start) || "",
    appId: textOf(props[P_APPID] && props[P_APPID].rich_text),
    lastEdited: p.last_edited_time,
    archived: !!p.archived,
  };
}
function propsFor(b) {
  const props = {};
  if (b.text !== undefined) props[P_NOTE] = { title: [{ text: { content: String(b.text || "").slice(0, 2000) } }] };
  if (b.date !== undefined) props[P_DATE] = { date: b.date ? { start: b.date } : null };
  if (b.appId !== undefined) props[P_APPID] = { rich_text: [{ text: { content: String(b.appId || "") } }] };
  return props;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-sync-key");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  if (!TOKEN || !RAW_DB) return res.status(500).json({ error: "Missing NOTION_TOKEN or NOTION_DB_ID." });
  if (SYNC_KEY && req.headers["x-sync-key"] !== SYNC_KEY) return res.status(401).json({ error: "Bad sync key." });

  try {
    const db = await resolveDb();

    if (req.method === "GET") {
      const since = req.query.since;
      const out = [];
      let cursor;
      do {
        const body = { page_size: 100 };
        if (cursor) body.start_cursor = cursor;
        if (since) body.filter = { timestamp: "last_edited_time", last_edited_time: { after: since } };
        const r = await fetch(`${NOTION}/databases/${db}/query`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
        if (!r.ok) return res.status(r.status).json({ error: "Notion query failed", detail: await r.text() });
        const data = await r.json();
        (data.results || []).forEach((p) => out.push(mapPage(p)));
        cursor = data.has_more ? data.next_cursor : null;
      } while (cursor);
      return res.status(200).json({ notes: out, serverTime: new Date().toISOString() });
    }

    if (req.method === "POST") {
      const b = req.body || {};
      if (b.pageId) {
        const payload = { properties: propsFor(b) };
        if (b.archived === true) payload.archived = true;
        const r = await fetch(`${NOTION}/pages/${b.pageId}`, { method: "PATCH", headers: headers(), body: JSON.stringify(payload) });
        if (!r.ok) return res.status(r.status).json({ error: "Notion update failed", detail: await r.text() });
        return res.status(200).json({ ok: true, page: mapPage(await r.json()) });
      }
      const r = await fetch(`${NOTION}/pages`, { method: "POST", headers: headers(), body: JSON.stringify({ parent: { database_id: db }, properties: propsFor(b) }) });
      if (!r.ok) return res.status(r.status).json({ error: "Notion create failed", detail: await r.text() });
      return res.status(200).json({ ok: true, page: mapPage(await r.json()) });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
};
