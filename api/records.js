
export default {
  async fetch(request, env) {
    const headers = {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    };

    const response = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    if (request.method !== "GET" && request.method !== "POST") {
      return response({ error: "Método no permitido" }, 405);
    }

    const clean = (value, max = 2000) =>
      typeof value === "string"
        ? value.trim().slice(0, max)
        : "";

    const cleanPhotos = (value) => {
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

      const valid = items.map((item) => {
        const raw = clean(item, 1000);
        if (!raw) return "";

        try {
          const url = new URL(raw);
          return ["https:", "http:"].includes(url.protocol)
            ? url.href
            : "";
        } catch {
          return "";
        }
      }).filter(Boolean);

      return [...new Set(valid)].slice(0, 6);
    };

    const addPhotosColumn = async (table) => {
      try {
        await env.DB.prepare(
          `ALTER TABLE ${table} ADD COLUMN photos TEXT`
        ).run();
      } catch (error) {
        if (!String(error.message).toLowerCase().includes("duplicate column name")) {
          throw error;
        }
      }
    };

    try {
      await env.DB.batch([
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          area TEXT,
          description TEXT,
          budget TEXT,
          contact TEXT,
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

      await addPhotosColumn("profiles");
      await addPhotosColumn("stores");

      if (request.method === "GET") {
        const [projects, profiles, stores] = await Promise.all([
          env.DB.prepare("SELECT * FROM projects ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM profiles ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM stores ORDER BY id DESC").all()
        ]);

        return response({
          success: true,
          projects: projects.results,
          profiles: profiles.results,
          stores: stores.results
        });
      }

      const body = await request.json();

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return response({ error: "Datos no válidos" }, 400);
      }

      const data = {
        ...(body.record || {}),
        ...body
      };

      const type = String(
        data.type || data.category || data.recordType || ""
      ).toLowerCase();

      const name = clean(data.name, 150);

      if (!name) {
        return response({ error: "El nombre es obligatorio" }, 400);
      }

      if (type === "project" || type === "projects") {
        await env.DB.prepare(
          `INSERT INTO projects
          (name, area, description, budget, contact)
          VALUES (?, ?, ?, ?, ?)`
        ).bind(
          name,
          clean(data.area, 150),
          clean(data.description),
          clean(data.budget, 100),
          clean(data.contact, 250)
        ).run();

      } else if (type === "profile" || type === "profiles") {
        await env.DB.prepare(
          `INSERT INTO profiles
          (name, skill, area, description, contact, photos)
          VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(
          name,
          clean(data.skill, 150),
          clean(data.area, 150),
          clean(data.description),
          clean(data.contact, 250),
          JSON.stringify(cleanPhotos(
            data.photos || data.images || data.image
          ))
        ).run();

      } else if (type === "store" || type === "stores") {
        await env.DB.prepare(
          `INSERT INTO stores
          (name, area, description, contact, photos)
          VALUES (?, ?, ?, ?, ?)`
        ).bind(
          name,
          clean(data.area, 150),
          clean(data.description),
          clean(data.contact, 250),
          JSON.stringify(cleanPhotos(
            data.photos || data.images || data.image
          ))
        ).run();

      } else {
        return response({
          error: "Tipo de registro no válido"
        }, 400);
      }

      return response({
        success: true,
        message: "Registro guardado correctamente"
      }, 201);

    } catch (error) {
      return response({
        error: "Error del servidor",
        detail: error.message
      }, 500);
    }
  }
};
