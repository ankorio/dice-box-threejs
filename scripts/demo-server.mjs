import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return null;
  }

  return process.argv[index + 1];
}

const host = readArg("--host") || process.env.HOST || "127.0.0.1";
const port = Number.parseInt(readArg("--port") || process.env.PORT || "8080", 10);

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
  [".mp3", "audio/mpeg"],
  [".wav", "audio/wav"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
]);

const server = http.createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || "/", `http://${req.headers.host || host}`);
    const pathname = decodeURIComponent(requestUrl.pathname);
    const relativePath = pathname === "/" ? "demo.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(repoRoot, relativePath);

    if (!filePath.startsWith(repoRoot + path.sep) && filePath !== repoRoot) {
      res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Forbidden");
      return;
    }

    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes.get(ext) || "application/octet-stream",
      "Content-Length": fileStat.size,
      "Cache-Control": "no-cache",
    });

    createReadStream(filePath).pipe(res);
  } catch (error) {
    const status = error && error.code === "ENOENT" ? 404 : 500;
    res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(status === 404 ? "Not found" : "Server error");
  }
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use on ${host}. Try: npm run demo -- --port 8081`);
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});

server.listen(port, host, () => {
  console.log(`Demo ready at http://${host}:${port}/`);
  console.log("Press Ctrl+C to stop the server.");
});
