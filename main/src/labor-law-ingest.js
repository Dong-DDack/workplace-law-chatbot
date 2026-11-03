import fs from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

// Real article headings in this PDF include a parenthesized caption. Requiring
// it avoids treating body citations such as "제17조에 따라" as new articles.
const ARTICLE_HEADING = /^\s*(제\s*\d+\s*조(?:의\s*\d+)?\s*\([^\n)]{1,100}\))/gm;
const MAX_CHUNK_LENGTH = 1800;
const CHUNK_OVERLAP = 160;

function cleanText(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/[\t ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function pageItemsToText(items) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string" || !item.str) continue;
    text += item.str;
    text += item.hasEOL ? "\n" : " ";
  }
  return cleanText(text);
}

function splitArticleSections(pageRecords) {
  const documentText = pageRecords.map((page) => page.text).join("\n\n");
  const headings = [...documentText.matchAll(ARTICLE_HEADING)];
  if (!headings.length) return [];

  return headings.map((heading, index) => {
    const start = heading.index;
    const end = headings[index + 1]?.index ?? documentText.length;
    const body = cleanText(documentText.slice(start, end));
    const articleMatch = heading[1].match(/제\s*(\d+)\s*조(?:의\s*(\d+))?/);
    const articleNumber = articleMatch
      ? `제${articleMatch[1]}조${articleMatch[2] ? `의${articleMatch[2]}` : ""}`
      : heading[1].trim();
    const pageNumbers = pageRecords
      .filter((page) => page.start < end && page.end > start)
      .map((page) => page.pageNumber);
    return { articleNumber, text: body, pageNumbers };
  }).filter((article) => article.text.length > 0);
}

function splitLongArticle(article) {
  if (article.text.length <= MAX_CHUNK_LENGTH) return [article];

  const parts = [];
  let remaining = article.text;
  let offset = 0;
  while (remaining.length > MAX_CHUNK_LENGTH) {
    let splitAt = remaining.lastIndexOf("\n", MAX_CHUNK_LENGTH);
    if (splitAt < MAX_CHUNK_LENGTH * 0.55) {
      splitAt = remaining.lastIndexOf(" ", MAX_CHUNK_LENGTH);
    }
    if (splitAt < MAX_CHUNK_LENGTH * 0.55) splitAt = MAX_CHUNK_LENGTH;

    const part = cleanText(remaining.slice(0, splitAt));
    parts.push({
      ...article,
      text: part,
      part: parts.length + 1,
      offsetStart: offset,
      offsetEnd: offset + splitAt,
    });
    offset += Math.max(1, splitAt - CHUNK_OVERLAP);
    remaining = remaining.slice(Math.max(1, splitAt - CHUNK_OVERLAP));
  }
  if (remaining.trim()) {
    parts.push({
      ...article,
      text: cleanText(remaining),
      part: parts.length + 1,
      offsetStart: offset,
      offsetEnd: offset + remaining.length,
    });
  }
  return parts;
}

async function extractPdfPages(pdfPath) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const loadingTask = pdfjs.getDocument({ data, useSystemFonts: true, verbosity: 0 });
  const pdf = await loadingTask.promise;
  const pages = [];
  let fullTextLength = 0;

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = pageItemsToText(content.items);
      const start = fullTextLength;
      fullTextLength += text.length + 2;
      pages.push({ pageNumber, text, start, end: fullTextLength });
      page.cleanup();
    }
  } finally {
    await loadingTask.destroy();
  }
  return pages;
}

async function loadLaborLawData(lawDirectory) {
  const files = await fs.readdir(lawDirectory);
  const pdfName = files.find((name) => name.toLowerCase().endsWith(".pdf") && name.includes("근로기준법"));
  if (!pdfName) {
    throw new Error("법령 폴더에서 근로기준법 PDF를 찾지 못했습니다.");
  }

  const pdfPath = path.join(lawDirectory, pdfName);
  const pages = await extractPdfPages(pdfPath);
  let offset = 0;
  const pageRecords = pages.map((page) => {
    const record = { ...page, start: offset, end: offset + page.text.length };
    offset = record.end + 2;
    return record;
  });
  const articles = splitArticleSections(pageRecords);
  const chunks = articles.flatMap(splitLongArticle).map((chunk, index) => ({
    id: `labor-law-${index + 1}`,
    article: chunk.articleNumber,
    part: chunk.part ?? 1,
    pages: chunk.pageNumbers,
    text: chunk.text,
  }));
  const extractedCharacters = pages.reduce((total, page) => total + page.text.length, 0);
  const pagesWithoutText = pages.filter((page) => page.text.length < 30).map((page) => page.pageNumber);

  return {
    fileName: pdfName,
    pageCount: pages.length,
    extractedCharacters,
    articleCount: articles.length,
    chunkCount: chunks.length,
    pagesWithoutText,
    extractionNote: pagesWithoutText.length
      ? "글자가 거의 추출되지 않은 페이지가 있습니다. 스캔 페이지일 수 있어 OCR 확인이 필요합니다."
      : "텍스트가 추출됐습니다. 표와 조항 연결이 정확한지는 원본과 대조해 주세요.",
    chunks,
    sampleChunks: chunks.slice(0, 8),
    pageSamples: pages
      .filter((page) => page.text.length > 0)
      .slice(0, 3)
      .map((page) => ({ pageNumber: page.pageNumber, text: page.text.slice(0, 700) })),
  };
}

export async function loadLaborLawChunks(lawDirectory) {
  const data = await loadLaborLawData(lawDirectory);
  return {
    fileName: data.fileName,
    pageCount: data.pageCount,
    articleCount: data.articleCount,
    chunks: data.chunks,
  };
}

export async function loadLaborLawPreview(lawDirectory) {
  const { chunks, ...preview } = await loadLaborLawData(lawDirectory);
  return preview;
}
