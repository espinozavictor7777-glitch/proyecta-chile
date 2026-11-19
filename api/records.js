export default {
  async fetch(request, env) {
    const headers = {
      "Content-Type": "application/json; charset=utf-8"
    };

    const response = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers });

    if (request.method !== "GET" && request.method !== "POST") {
      return response({ error: "Método no permitido" }, 405);
    }

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
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`),
        env.DB.prepare(`CREATE TABLE IF NOT EXISTS stores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          area TEXT,
          description TEXT,
          contact TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )`)
      ]);

      if (request.method === "GET") {
        const [projects, profiles, stores] = await Promise.all([
          env.DB.prepare("SELECT * FROM projects ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM profiles ORDER BY id DESC").all(),
          env.DB.prepare("SELECT * FROM stores ORDER BY id DESC").all()
        ]);

        return response({
          projects: projects.results,
          profiles: profiles.results,
          stores: stores.results
        });
      }

            const body = await request.json();
      const data = { ...(body.record || {}), ...body };
      const type = data.type || data.category || data.recordType;
      

      if (type === "project" || type === "projects") {
        await env.DB.prepare(
          "INSERT INTO projects (name, area, description, budget, contact) VALUES (?, ?, ?, ?, ?)"
        ).bind(
          data.name || "",
          data.area || "",
          data.description || "",
          data.budget || "",
          data.contact || ""
        ).run();

      } else if (type === "profile" || type === "profiles") {
        await env.DB.prepare(
          "INSERT INTO profiles (name, skill, area, description, contact) VALUES (?, ?, ?, ?, ?)"
        ).bind(
          data.name || "",
          data.skill || "",
          data.area || "",
          data.description || "",
          data.contact || ""
        ).run();

      } else if (type === "store" || type === "stores") {
        await env.DB.prepare(
          "INSERT INTO stores (name, area, description, contact) VALUES (?, ?, ?, ?)"
        ).bind(
          data.name || "",
          data.area || "",
          data.description || "",
          data.contact || ""
        ).run();

      } else {
        return response({ error: "Tipo de registro no válido" }, 400);
      }

      return response({ success: true, message: "Registro guardado" }, 201);

    } catch (error) {
      return response({ error: "Error del servidor", detail: error.message }, 500);
    }
  }
};
