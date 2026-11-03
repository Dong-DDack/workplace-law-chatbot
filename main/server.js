import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLaborLawPreview } from "./src/labor-law-ingest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.static(__dirname));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, stage: "pdf-extraction" });
});

app.get("/api/documents/labor-law/preview", async (_request, response) => {
  try {
    const preview = await loadLaborLawPreview(path.resolve(__dirname, "..", "법령"));
    response.json(preview);
  } catch (error) {
    console.error("근로기준법 PDF 추출 실패:", error);
    response.status(500).json({
      error: error instanceof Error ? error.message : "PDF를 읽지 못했습니다.",
    });
  }
});

app.listen(port, () => {
  console.log(`일터법 프로토타입: http://localhost:${port}`);
});
