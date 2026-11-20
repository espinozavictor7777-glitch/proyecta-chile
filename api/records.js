
const TABLES = {
  project: "projects",
  projects: "projects",
  profile: "profiles",
  profiles: "profiles",
  store: "stores",
  stores: "stores"
};

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;
const encoder = new TextEncoder();

const clean = (value, max = 2000) =>
  typeof value === "string" ? value.trim().slice(0, max) : "";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders
    }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

async function signToken(secret) {
  const header = base64url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const payload = base64url(encoder.encode(JSON.stringify({
    role: "admin",
    exp: Math.floor(Date.now() / 1000) + 2 * 60 * 60
  })));
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(data));
  return `${data}.${base64url(new Uint8Array(signature))}`;
}

async function verifyToken(token, secret) {
  try {
    if (!token || !secret) return false;
    const parts = token.split(".");
    if (parts.length !== 3) return false;
    const data = `${parts[0]}.${parts[1]}`;
    const key = await crypto.subtle.importKey(
      "raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "HMAC", key, fromBase64url(parts[2]), encoder.encode(data)
    );
    if (!valid) return false;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
    return payload.role === "admin" && Number(payload.exp) > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function isAdmin(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  return verifyToken(token, env.ADMIN_TOKEN);
}

function cleanPhotos(value) {
  let photos = value;
  if (typeof photos === "string") {
    try { photos = JSON.parse(photos); } catch { photos = []; }
  }
  if (!Array.isArray(photos)) return [];
  return photos
    .filter(item => typeof item === "string")
    .map(item => item.trim().slice(0, 1000))
    .filter(Boolean)
    .slice(0, 10);
}

async function ensureSchema(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      title TEXT,
      area TEXT,
      description TEXT,
      budget TEXT,
      contact TEXT,
      photos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      skill TEXT,
      area TEXT,
      description TEXT,
      contact TEXT,
      photos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT,
      description TEXT,
      contact TEXT,
      photos TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS quote_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      record_type TEXT,
      record_id INTEGER,
      record_name TEXT,
      customer_name TEXT NOT NULL,
      phone TEXT NOT NULL,
      area TEXT,
      description TEXT NOT NULL,
      status TEXT DEFAULT 'pendiente',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);

  try {
    await env.DB.prepare("ALTER TABLE projects ADD COLUMN photos TEXT DEFAULT '[]'").run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
  try {
    await env.DB.prepare("ALTER TABLE profiles ADD COLUMN photos TEXT DEFAULT '[]'").run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
  try {
    await env.DB.prepare("ALTER TABLE stores ADD COLUMN photos TEXT DEFAULT '[]'").run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
  try {
    await env.DB.prepare("ALTER TABLE projects ADD COLUMN title TEXT").run();
  } catch (error) {
    if (!String(error).toLowerCase().includes("duplicate column")) throw error;
  }
}

function recordFields(table) {
  if (table === "projects") {
    return ["name", "title", "area", "description", "budget", "contact", "photos"];
  }
  if (table === "profiles") {
    return ["name", "skill", "area", "description", "contact", "photos"];
  }
  return ["name", "area", "description", "contact", "photos"];
}

function recordValues(table, body) {
  const name = clean(body.name || body.title, 120);
  const values = {
    name,
    title: clean(body.title || body.name, 160),
    skill: clean(body.skill, 120),
    area: clean(body.area || body.comuna, 120),
    description: clean(body.description, 4000),
    budget: clean(body.budget, 120),
    contact: clean(body.contact || body.phone || body.email, 180),
    photos: JSON.stringify(cleanPhotos(body.photos))
  };
  return recordFields(table).map(field => values[field] ?? "");
}

function readImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { ext: "jpg", type: "image/jpeg" };
  }
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { ext: "png", type: "image/png" };
  }
  if (bytes.length >= 12 &&
      String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
      String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") {
    return { ext: "webp", type: "image/webp" };
  }
  if (bytes.length >= 6 &&
      ["GIF87a", "GIF89a"].includes(String.fromCharCode(...bytes.slice(0, 6)))) {
    return { ext: "gif", type: "image/gif" };
  }
  return null;
}

function normalizeRecord(row) {
  return { ...row, photos: cleanPhotos(row.photos) };
}

export default {
  async fetch(request, env) {
    try {
      if (!env.DB) return json({ error: "La base de datos D1 no está configurada." }, 500);

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const method = request.method.toUpperCase();

      if (path === "/api/admin/login" && method === "POST") {
        if (!env.ADMIN_TOKEN) return json({ error: "Falta configurar ADMIN_TOKEN." }, 500);
        const body = await request.json();
        if (clean(body.password, 300) !== env.ADMIN_TOKEN) {
          return json({ error: "Contraseña incorrecta." }, 401);
        }
        const token = await signToken(env.ADMIN_TOKEN);
        return json({ ok: true, token });
      }

      if (path === "/api/admin/check" && method === "GET") {
        return json({ ok: await isAdmin(request, env) });
      }

      if (path.startsWith("/api/photo/") && (method === "GET" || method === "HEAD")) {
        if (!env.PHOTOS) return json({ error: "El almacenamiento de fotos no está configurado." }, 500);
        const key = decodeURIComponent(path.slice("/api/photo/".length));
        if (!key || key.includes("..")) return json({ error: "Foto no encontrada." }, 404);
        const object = await env.PHOTOS.get(key);
        if (!object) return json({ error: "Foto no encontrada." }, 404);
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=31536000, immutable");
        headers.set("X-Content-Type-Options", "nosniff");
        if (method === "HEAD") return new Response(null, { headers });
        return new Response(object.body, { headers });
      }

      if (path === "/api/upload" && method === "POST") {
        if (!env.PHOTOS) return json({ error: "El almacenamiento de fotos no está configurado." }, 500);
        const form = await request.formData();
        const file = form.get("file");
        if (!file || typeof file.arrayBuffer !== "function") {
          return json({ error: "No se recibió ninguna imagen." }, 400);
        }
        if (file.size <= 0 || file.size > MAX_IMAGE_SIZE) {
          return json({ error: "La imagen debe pesar como máximo 5 MB." }, 400);
        }
        const bytes = new Uint8Array(await file.arrayBuffer());
        const imageType = readImageType(bytes);
        if (!imageType) return json({ error: "Formato no permitido. Usa JPG, PNG, WEBP o GIF." }, 400);
        const key = `${Date.now()}-${crypto.randomUUID()}.${imageType.ext}`;
        await env.PHOTOS.put(key, bytes, {
          httpMetadata: { contentType: imageType.type }
        });
        return json({ ok: true, key, url: `/api/photo/${encodeURIComponent(key)}` });
      }

      if (path === "/api/quotes" || path.startsWith("/api/quotes/")) {
        await ensureSchema(env);

        if (path === "/api/quotes" && method === "POST") {
          const body = await request.json();
          const customerName = clean(body.customer_name || body.name, 120);
          const phone = clean(body.phone || body.contact, 60);
          const area = clean(body.area || body.comuna, 120);
          const description = clean(body.description || body.message, 3000);
          const recordType = clean(body.record_type || body.type, 30).toLowerCase();
          const recordId = Number(body.record_id || body.id) || null;
          const recordName = clean(body.record_name || body.title || body.project_name, 160);

          if (!customerName || !phone || !description) {
            return json({ error: "Completa tu nombre, teléfono y descripción." }, 400);
          }
          if (!/^[0-9+\s().-]{7,60}$/.test(phone)) {
            return json({ error: "Ingresa un teléfono válido." }, 400);
          }

          const result = await env.DB.prepare(`
            INSERT INTO quote_requests
            (record_type, record_id, record_name, customer_name, phone, area, description)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).bind(
            recordType, recordId, recordName, customerName, phone, area, description
          ).run();

          return json({ ok: true, id: result.meta?.last_row_id ?? null, message: "Solicitud recibida." }, 201);
        }

        if (path === "/api/quotes" && method === "GET") {
          if (!(await isAdmin(request, env))) return json({ error: "No autorizado." }, 401);
          const result = await env.DB.prepare(
            "SELECT * FROM quote_requests ORDER BY created_at DESC, id DESC"
          ).all();
          return json({ ok: true, quotes: result.results || [] });
        }

        const quoteMatch = path.match(/^\/api\/quotes\/(\d+)$/);
        if (quoteMatch && method === "PUT") {
          if (!(await isAdmin(request, env))) return json({ error: "No autorizado." }, 401);
          const id = Number(quoteMatch[1]);
          const body = await request.json();
          const status = clean(body.status, 30).toLowerCase();
          if (!["pendiente", "contactado", "cerrado"].includes(status)) {
            return json({ error: "Estado no válido." }, 400);
          }
          const result = await env.DB.prepare(
            "UPDATE quote_requests SET status = ? WHERE id = ?"
          ).bind(status, id).run();
          if (!result.meta?.changes) return json({ error: "Solicitud no encontrada." }, 404);
          return json({ ok: true, message: "Estado actualizado." });
        }

        return json({ error: "Ruta de cotizaciones no encontrada." }, 404);
      }

      const recordRoute = path === "/api/records" ||
        /^\/api\/records\/(projects|profiles|stores)\/\d+$/.test(path);
      if (recordRoute) await ensureSchema(env);

      if (path === "/api/records" && method === "GET") {
        const term = clean(url.searchParams.get("q"), 100).toLowerCase();
        const area = clean(url.searchParams.get("area"), 100).toLowerCase();
        const type = clean(url.searchParams.get("type"), 30).toLowerCase();

        const tables = type && TABLES[type]
          ? [TABLES[type]]
          : ["projects", "profiles", "stores"];

        const all = [];
        for (const table of tables) {
          const result = await env.DB.prepare(
            `SELECT * FROM ${table} ORDER BY created_at DESC, id DESC`
          ).all();
          for (const row of result.results || []) {
            const item = normalizeRecord(row);
            item.type = table === "projects" ? "project" : table === "profiles" ? "profile" : "store";
            const searchable = [
              item.name, item.title, item.area, item.description, item.skill
            ].join(" ").toLowerCase();
            if (term && !searchable.includes(term)) continue;
            if (area && !String(item.area || "").toLowerCase().includes(area)) continue;
            all.push(item);
          }
        }
        all.sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
        return json({ ok: true, records: all });
      }

      if (path === "/api/records" && method === "POST") {
        const body = await request.json();
        const requestedType = clean(body.type || body.category || body.recordType, 30).toLowerCase();
        const table = TABLES[requestedType];
        if (!table) return json({ error: "Tipo de publicación no válido." }, 400);

        const values = recordValues(table, body);
        if (!values[0]) return json({ error: "El nombre o título es obligatorio." }, 400);

        const fields = recordFields(table);
        const placeholders = fields.map(() => "?").join(", ");
        const result = await env.DB.prepare(
          `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${placeholders})`
        ).bind(...values).run();

        return json({
          ok: true,
          id: result.meta?.last_row_id ?? null,
          message: "Publicación guardada."
        }, 201);
      }

      const adminRecordMatch = path.match(/^\/api\/records\/(projects|profiles|stores)\/(\d+)$/);
      if (adminRecordMatch && (method === "PUT" || method === "DELETE")) {
        if (!(await isAdmin(request, env))) return json({ error: "No autorizado." }, 401);
        const table = adminRecordMatch[1];
        const id = Number(adminRecordMatch[2]);

        if (method === "DELETE") {
          const result = await env.DB.prepare(
            `DELETE FROM ${table} WHERE id = ?`
          ).bind(id).run();
          if (!result.meta?.changes) return json({ error: "Publicación no encontrada." }, 404);
          return json({ ok: true, message: "Publicación eliminada." });
        }

        const body = await request.json();
        const fields = recordFields(table);
        const values = recordValues(table, body);
        const assignments = fields.map(field => `${field} = ?`).join(", ");
        const result = await env.DB.prepare(
          `UPDATE ${table} SET ${assignments} WHERE id = ?`
        ).bind(...values, id).run();
        if (!result.meta?.changes) return json({ error: "Publicación no encontrada." }, 404);
        return json({ ok: true, message: "Publicación actualizada." });
      }

      return json({ error: "Ruta no encontrada." }, 404);
    } catch (error) {
      return json({
        error: "Error interno del servidor.",
        detail: String(error?.message || error).slice(0, 500)
      }, 500);
    }
  }
};
