
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    }
  });
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromBase64url(value) {
  const normal = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normal);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function signToken(payload, secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const data = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(data)
  );

  return data + "." + base64url(new Uint8Array(signature));
}

async function verifyToken(token, secret) {
  try {
    if (!secret || typeof token !== "string") return false;

    const parts = token.split(".");
    if (parts.length !== 2) return false;

    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );

    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      fromBase64url(parts[1]),
      encoder.encode(parts[0])
    );

    if (!valid) return false;

    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64url(parts[0]))
    );

    return payload.exp > Math.floor(Date.now() / 1000);
  } catch {
    return false;
  }
}

async function isAdmin(request, env) {
  const header = request.headers.get("Authorization") || "";
  if (!header.startsWith("Bearer ")) return false;

  return verifyToken(
    header.slice(7),
    env.ADMIN_TOKEN
  );
}

function cleanPhotos(value) {
  let items = [];

  if (Array.isArray(value)) {
    items = value;
  } else if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      items = Array.isArray(parsed) ? parsed : [value];
    } catch {
      items = [value];
    }
  }

  return [...new Set(items.map(item => {
    const raw = clean(item, 500);

    if (/^\/api\/photo\/[A-Za-z0-9._/-]+$/.test(raw)) {
      return raw;
    }

    try {
      const url = new URL(raw);
      return ["https:", "http:"].includes(url.protocol)
        ? url.href
        : "";
    } catch {
      return "";
    }
  }).filter(Boolean))].slice(0, 8);
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
      photos TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),

    env.DB.prepare(`CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      skill TEXT,
      area TEXT,
      description TEXT,
      contact TEXT,
      photos TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`),

    env.DB.prepare(`CREATE TABLE IF NOT EXISTS stores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      area TEXT,
      description TEXT,
      contact TEXT,
      photos TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`)
  ]);

  for (const table of ["projects", "profiles", "stores"]) {
    try {
      await env.DB.prepare(
        `ALTER TABLE ${table} ADD COLUMN photos TEXT`
      ).run();
    } catch (error) {
      if (!String(error.message).toLowerCase().includes("duplicate column")) {
        throw error;
      }
    }
  }

  try {
    await env.DB.prepare(
      "ALTER TABLE projects ADD COLUMN title TEXT"
    ).run();
  } catch (error) {
    if (!String(error.message).toLowerCase().includes("duplicate column")) {
      throw error;
    }
  }
}

function recordFields(table) {
  if (table === "projects") {
    return [
      "name",
      "title",
      "area",
      "description",
      "budget",
      "contact",
      "photos"
    ];
  }

  if (table === "profiles") {
    return ["name", "skill", "area", "description", "contact", "photos"];
  }

  return ["name", "area", "description", "contact", "photos"];
}

function recordValues(table, data) {
  return recordFields(table).map(field => {
    if (field === "photos") {
      return JSON.stringify(
        cleanPhotos(data.photos || data.images || data.image)
      );
    }

    const limits = {
      name: 150,
      title: 150,
      skill: 150,
      area: 150,
      description: 2000,
      budget: 100,
      contact: 250
    };

    return clean(data[field], limits[field] || 250);
  });
}

async function readImageType(file) {
  const bytes = new Uint8Array(
    await file.slice(0, 12).arrayBuffer()
  );

  const starts = (...values) =>
    values.every((value, index) => bytes[index] === value);

  if (starts(0xFF, 0xD8, 0xFF)) return "image/jpeg";

  if (starts(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)) {
    return "image/png";
  }

  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  if (
    starts(0x47, 0x49, 0x46, 0x38) &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  ) {
    return "image/gif";
  }

  return "";
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (!env.DB) {
        return json({ error: "La base de datos D1 no está configurada." }, 503);
      }

      // Inicio de sesión del administrador.
      if (path === "/api/admin/login") {
        if (request.method !== "POST") {
          return json({ error: "Método no permitido" }, 405);
        }

        if (!env.ADMIN_TOKEN) {
          return json({ error: "Falta configurar ADMIN_TOKEN en Cloudflare." }, 503);
        }

        const body = await request.json();
        const password = clean(body.password, 500);

        if (!password || password !== env.ADMIN_TOKEN) {
          return json({ error: "Clave de administrador incorrecta." }, 401);
        }

        const token = await signToken({
          role: "admin",
          exp: Math.floor(Date.now() / 1000) + 7200
        }, env.ADMIN_TOKEN);

        return json({
          success: true,
          token,
          expiresIn: 7200
        });
      }

      // Verificación de sesión administrativa.
      if (path === "/api/admin/check") {
        if (request.method !== "GET") {
          return json({ error: "Método no permitido" }, 405);
        }

        return await isAdmin(request, env)
          ? json({ success: true })
          : json({ error: "Sesión no autorizada." }, 401);
      }

      // Lectura de fotografías guardadas en R2.
      if (path.startsWith("/api/photo/")) {
        if (request.method !== "GET" && request.method !== "HEAD") {
          return json({ error: "Método no permitido" }, 405);
        }

        if (!env.PHOTOS) {
          return json({ error: "El almacenamiento R2 no está configurado." }, 503);
        }

        const key = path.slice("/api/photo/".length);

        if (
          !key ||
          key.includes("..") ||
          key.startsWith("/") ||
          !/^uploads\/[A-Za-z0-9._-]+$/.test(key)
        ) {
          return json({ error: "Fotografía no válida." }, 400);
        }

        const object = await env.PHOTOS.get(key);

        if (!object) {
          return json({ error: "Fotografía no encontrada." }, 404);
        }

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("ETag", object.httpEtag);
        headers.set("Cache-Control", "public, max-age=86400");
        headers.set("X-Content-Type-Options", "nosniff");

        return new Response(
          request.method === "HEAD" ? null : object.body,
          { headers }
        );
      }

      // Subida de fotografías a R2.
      if (path === "/api/upload") {
        if (request.method !== "POST") {
          return json({ error: "Método no permitido" }, 405);
        }

        if (!env.PHOTOS) {
          return json({ error: "El almacenamiento R2 no está configurado." }, 503);
        }

        const form = await request.formData();
        const file = form.get("file");

        if (!(file instanceof File) || !file.size) {
          return json({ error: "Selecciona una fotografía." }, 400);
        }

        if (file.size > MAX_IMAGE_SIZE) {
          return json({ error: "La fotografía supera el máximo de 5 MB." }, 400);
        }

        const mime = await readImageType(file);

        if (!mime) {
          return json({ error: "Formato no válido. Usa JPG, PNG, WEBP o GIF." }, 400);
        }

        const extensions = {
          "image/jpeg": "jpg",
          "image/png": "png",
          "image/webp": "webp",
          "image/gif": "gif"
        };

        const key = `uploads/${crypto.randomUUID()}.${extensions[mime]}`;

        await env.PHOTOS.put(key, file.stream(), {
          httpMetadata: {
            contentType: mime,
            cacheControl: "public, max-age=86400"
          }
        });

        return json({
          success: true,
          key,
          url: `/api/photo/${key}`
        }, 201);
      }

      // Todas las operaciones de registros necesitan D1.
      if (
        path === "/api/records" ||
        /^\/api\/records\/(projects|profiles|stores)\/\d+$/.test(path)
      ) {
        await ensureSchema(env);
      }

      // Consulta pública, con filtros opcionales.
      if (path === "/api/records" && request.method === "GET") {
        const [projects, profiles, stores] = await Promise.all([
          env.DB.prepare("SELECT * FROM projects ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM profiles ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM stores ORDER BY id DESC").all()
        ]);

        const result = {
          projects: projects.results,
          profiles: profiles.results,
          stores: stores.results
        };

        const term = clean(url.searchParams.get("q"), 100).toLowerCase();
        const area = clean(url.searchParams.get("area"), 100).toLowerCase();
        const type = clean(url.searchParams.get("type"), 30).toLowerCase();

        for (const table of Object.keys(result)) {
          if (type && type !== table && type !== table.slice(0, -1)) {
            result[table] = [];
            continue;
          }

          result[table] = result[table]
            .filter(item => {
              const searchable = [
                item.name,
                item.title,
                item.skill,
                item.area,
                item.description
              ].join(" ").toLowerCase();

              return (
                (!term || searchable.includes(term)) &&
                (!area || String(item.area || "").toLowerCase().includes(area))
              );
            })
            .map(item => ({
              ...item,
              photos: cleanPhotos(item.photos)
            }));
        }

        return json({ success: true, ...result });
      }

      // Crear publicaciones públicas.
      if (path === "/api/records" && request.method === "POST") {
        const body = await request.json();

        if (!body || typeof body !== "object" || Array.isArray(body)) {
          return json({ error: "Datos no válidos." }, 400);
        }

        const data = {
          ...(body.record || {}),
          ...body
        };

        const type = String(
          data.type || data.category || data.recordType || ""
        ).toLowerCase();

        const table = TABLES[type];

        if (!table) {
          return json({ error: "Tipo de registro no válido." }, 400);
        }

        const values = recordValues(table, data);

        if (!values[0]) {
          return json({ error: "El nombre es obligatorio." }, 400);
        }

        const fields = recordFields(table);
        const placeholders = fields.map(() => "?").join(", ");

        await env.DB.prepare(
          `INSERT INTO ${table} (${fields.join(", ")}) VALUES (${placeholders})`
        ).bind(...values).run();

        return json({
          success: true,
          message: "Registro guardado correctamente."
        }, 201);
      }

      // Editar o eliminar un registro: solo administrador.
      const match = path.match(
        /^\/api\/records\/(projects|profiles|stores)\/(\d+)$/
      );

      if (match) {
        if (!await isAdmin(request, env)) {
          return json({ error: "Debes iniciar sesión como administrador." }, 401);
        }

        const table = match[1];
        const id = Number(match[2]);

        if (request.method === "DELETE") {
          const result = await env.DB.prepare(
            `DELETE FROM ${table} WHERE id = ?`
          ).bind(id).run();

          return result.meta.changes
            ? json({ success: true, message: "Registro eliminado." })
            : json({ error: "Registro no encontrado." }, 404);
        }

        if (request.method === "PUT") {
          const body = await request.json();

          if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Datos no válidos." }, 400);
          }

          const data = body.record && typeof body.record === "object"
            ? body.record
            : body;

          const fields = recordFields(table);
          const values = recordValues(table, data);

          if (!values[0]) {
            return json({ error: "El nombre es obligatorio." }, 400);
          }

          const assignments = fields.map(field => `${field} = ?`).join(", ");

          const result = await env.DB.prepare(
            `UPDATE ${table} SET ${assignments} WHERE id = ?`
          ).bind(...values, id).run();

          return result.meta.changes
            ? json({ success: true, message: "Registro actualizado." })
            : json({ error: "Registro no encontrado." }, 404);
        }

        return json({ error: "Método no permitido." }, 405);
      }

      return json({ error: "Ruta no encontrada." }, 404);

    } catch (error) {
      console.error("Proyecta Chile API:", error);
      return json({
        error: "No se pudo completar la operación. Revisa la configuración del servidor."
      }, 500);
    }
  }
};
