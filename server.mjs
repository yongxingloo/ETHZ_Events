import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = __dirname;
const publicDir = path.join(rootDir, "public");
const port = Number(process.env.PORT || 3000);

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, `http://${request.headers.host}`).pathname;
    const relativePath = pathname === "/" ? "/index.html" : pathname;
    const targetPath = path.normalize(path.join(publicDir, relativePath));

    if (!targetPath.startsWith(publicDir)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    const content = await fs.readFile(targetPath);
    response.writeHead(200, {
      "content-type": mimeTypes[path.extname(targetPath)] ?? "application/octet-stream"
    });
    response.end(content);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
});

server.listen(port, () => {
  console.log(`ETHZ events site running at http://localhost:${port}`);
});
