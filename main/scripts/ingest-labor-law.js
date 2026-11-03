import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import { loadLaborLawChunks } from "../src/labor-law-ingest.js";
import { EMBEDDING_MODEL, embedTexts, getSupabaseClient } from "../src/rag-services.js";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const mainDirectory = path.resolve(scriptDirectory, "..");
const lawDirectory = path.resolve(mainDirectory, "..", "법령");
const faqPath = path.join(mainDirectory, "data", "labor-law-faq.json");
const checkpointDirectory = path.join(mainDirectory, ".cache");
const batchSize = 16;
const safeEmbeddingsPerMinute = 80;
const maxChunkLength = 1800;
const overlapLength = 160;
const excludedPdfNameFragments = ["임금체불 신고 안내", "괴롭힘 매뉴얼 개정 보도자료"];

let rateWindowStartedAt = Date.now();
let embeddingsInRateWindow = 0;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function cleanText(value) {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").replace(/\s+/g, " ").trim();
}

function quotaRetryDelay(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (!/429|RESOURCE_EXHAUSTED|quota exceeded/i.test(message)) return null;
  const retrySeconds = Number(message.match(/"retryDelay"\s*:\s*"(\d+)s"/)?.[1]);
  return (retrySeconds || 60) * 1000 + 1500;
}

async function respectRateLimit(nextCount) {
  if (embeddingsInRateWindow + nextCount <= safeEmbeddingsPerMinute) return;
  const remaining = 61_000 - (Date.now() - rateWindowStartedAt);
  if (remaining > 0) {
    console.log(`무료 API 한도를 지키기 위해 ${Math.ceil(remaining / 1000)}초 기다립니다.`);
    await wait(remaining);
  }
  rateWindowStartedAt = Date.now();
  embeddingsInRateWindow = 0;
}

function failIfError(error) {
  if (error) throw new Error(error.message || "Supabase 요청에 실패했습니다.");
}

async function extractPdfChunks(pdfPath, title) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const task = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const pdf = await task.promise;
  const chunks = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = cleanText(content.items.map((item) => item.str || "").join(" "));
      page.cleanup();
      if (text.length < 30) {
        console.warn(`텍스트가 거의 없는 페이지를 건너뜁니다: ${title} · ${pageNumber}쪽 (OCR 확인 필요)`);
        continue;
      }
      let start = 0;
      while (start < text.length) {
        let end = Math.min(start + maxChunkLength, text.length);
        if (end < text.length) {
          const boundary = text.lastIndexOf(" ", end);
          if (boundary > start + maxChunkLength * 0.55) end = boundary;
        }
        chunks.push({
          article: `자료: ${title}`,
          part: chunks.filter((chunk) => chunk.pages[0] === pageNumber).length + 1,
          pages: [pageNumber],
          text: `자료명: ${title}\n${text.slice(start, end).trim()}`,
        });
        if (end >= text.length) break;
        start = Math.max(start + 1, end - overlapLength);
      }
    }
  } finally {
    await task.destroy();
  }
  return chunks;
}

async function readCheckpoint(checkpointPath, fingerprint, count) {
  try {
    const saved = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    if (saved.fingerprint === fingerprint && Array.isArray(saved.embeddings) && saved.embeddings.length === count) {
      return saved.embeddings;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return Array.from({ length: count }, () => null);
}

async function saveCheckpoint(checkpointPath, fingerprint, embeddings) {
  await fs.mkdir(checkpointDirectory, { recursive: true });
  const temporaryPath = `${checkpointPath}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify({ fingerprint, embeddings }));
  await fs.rename(temporaryPath, checkpointPath);
}

async function ingestDocument(supabase, documentSource) {
  const { slug, title, sourceFile, sourceUrl = null, chunks } = documentSource;
  if (!chunks.length) {
    console.warn(`추출된 청크가 없어 건너뜁니다: ${title}`);
    return;
  }

  const fingerprint = createHash("sha256")
    .update(`${sourceFile}\0${EMBEDDING_MODEL}\0${chunks.map((chunk) => chunk.text).join("\0")}`)
    .digest("hex");
  const checkpointPath = path.join(checkpointDirectory, `embedding-${slug}.json`);
  const embeddings = await readCheckpoint(checkpointPath, fingerprint, chunks.length);
  const previousCount = embeddings.filter(Boolean).length;
  if (previousCount) console.log(`${title}: 저장된 임베딩 ${previousCount}개부터 이어서 진행합니다.`);

  const { data: document, error: documentError } = await supabase
    .from("law_documents")
    .upsert({ slug, title, effective_date: null, source_file: sourceFile, source_url: sourceUrl }, { onConflict: "slug" })
    .select("id")
    .single();
  failIfError(documentError);

  let newlyGenerated = 0;
  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const missing = chunks.slice(offset, offset + batchSize)
      .map((chunk, index) => ({ chunk, index: offset + index }))
      .filter(({ index }) => !embeddings[index]);
    if (!missing.length) continue;

    await respectRateLimit(missing.length);
    let vectors;
    for (let attempt = 0; ; attempt += 1) {
      try {
        vectors = await embedTexts(missing.map(({ chunk }) => chunk.text), "RETRIEVAL_DOCUMENT", title);
        break;
      } catch (error) {
        const retryDelay = quotaRetryDelay(error);
        if (retryDelay === null || attempt >= 3) throw error;
        console.log(`${title}: Gemini 무료 요청 한도에 도달해 ${Math.ceil(retryDelay / 1000)}초 후 재시도합니다.`);
        await wait(retryDelay);
        rateWindowStartedAt = Date.now();
        embeddingsInRateWindow = 0;
      }
    }

    embeddingsInRateWindow += missing.length;
    missing.forEach(({ index }, vectorIndex) => { embeddings[index] = vectors[vectorIndex]; });
    newlyGenerated += missing.length;
    await saveCheckpoint(checkpointPath, fingerprint, embeddings);
    console.log(`${title}: 임베딩 ${embeddings.filter(Boolean).length}/${chunks.length}`);
  }

  const rows = chunks.map((chunk, index) => ({
    document_id: document.id,
    chunk_index: index,
    article_number: chunk.article,
    part_number: chunk.part ?? 1,
    pages: chunk.pages ?? [],
    content: chunk.text,
    embedding: embeddings[index],
    embedding_model: EMBEDDING_MODEL,
  }));
  for (let offset = 0; offset < rows.length; offset += batchSize) {
    const { error } = await supabase.from("law_chunks")
      .upsert(rows.slice(offset, offset + batchSize), { onConflict: "document_id,chunk_index" });
    failIfError(error);
    console.log(`${title}: Supabase 저장 ${Math.min(offset + batchSize, rows.length)}/${rows.length}`);
  }
  const { error: cleanupError } = await supabase.from("law_chunks")
    .delete().eq("document_id", document.id).gt("chunk_index", rows.length - 1);
  failIfError(cleanupError);
  await fs.rm(checkpointPath, { force: true });
  console.log(`완료: ${title} · ${rows.length}개 청크 (${newlyGenerated}개 새 임베딩)`);
}

async function loadSources() {
  const files = (await fs.readdir(lawDirectory)).filter((name) => name.toLowerCase().endsWith(".pdf")).sort();
  const lawFile = files.find((name) => name.includes("근로기준법"));
  if (!lawFile) throw new Error("법령 폴더에서 근로기준법 PDF를 찾지 못했습니다.");
  const parsedLaw = await loadLaborLawChunks(lawDirectory);
  const sources = [{
    slug: "labor-standard-act",
    title: "근로기준법",
    sourceFile: parsedLaw.fileName,
    sourceUrl: "https://www.law.go.kr/법령/근로기준법",
    chunks: parsedLaw.chunks.map((chunk) => ({ article: chunk.article, part: chunk.part, pages: chunk.pages, text: chunk.text })),
  }];

  for (const sourceFile of files.filter((name) => name !== lawFile)) {
    if (excludedPdfNameFragments.some((fragment) => sourceFile.includes(fragment))) {
      console.warn(`내용이 임시 안내 또는 보도자료라 임베딩에서 제외합니다: ${sourceFile}`);
      continue;
    }
    const title = path.basename(sourceFile, ".pdf");
    const hash = createHash("sha256").update(sourceFile).digest("hex").slice(0, 12);
    sources.push({
      slug: `labor-doc-${hash}`,
      title,
      sourceFile,
      chunks: await extractPdfChunks(path.join(lawDirectory, sourceFile), title),
    });
  }

  const faqs = JSON.parse(await fs.readFile(faqPath, "utf8"));
  if (!Array.isArray(faqs)) throw new Error("FAQ JSON은 배열 형식이어야 합니다.");
  for (const faq of faqs) {
    if (!faq.id || !faq.question || !faq.answer || !faq.source_url) {
      throw new Error(`필수 FAQ 항목이 없습니다: ${faq.id || "id 없음"}`);
    }
    const searchableText = [
      `질문: ${faq.question}`,
      `답변: ${faq.answer}`,
      `검색어: ${(faq.search_terms ?? []).join(", ")}`,
      `출처: ${faq.source_title}`,
    ].join("\n");
    sources.push({
      slug: faq.id,
      title: faq.source_title,
      sourceFile: `${faq.id}.json`,
      sourceUrl: faq.source_url,
      chunks: [{ article: `FAQ: ${faq.question}`, part: 1, pages: [], text: searchableText }],
    });
  }
  return sources;
}

async function main() {
  const sources = await loadSources();
  const totalChunks = sources.reduce((sum, source) => sum + source.chunks.length, 0);
  console.log(`${sources.length}개 자료, ${totalChunks}개 청크를 준비했습니다.`);
  const supabase = getSupabaseClient();
  for (const source of sources) await ingestDocument(supabase, source);
  console.log("모든 PDF와 FAQ의 임베딩·저장이 완료됐습니다.");
}

main().catch((error) => {
  console.error("법령 자료 임베딩 저장 실패:", error instanceof Error ? error.message : "알 수 없는 오류");
  process.exitCode = 1;
});
