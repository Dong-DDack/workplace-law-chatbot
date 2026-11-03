import fs from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadLaborLawPreview } from "./src/labor-law-ingest.js";
import { answerFromSources, embedTexts, getSupabaseClient } from "./src/rag-services.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const faqEntries = JSON.parse(await fs.readFile(path.join(__dirname, "data", "labor-law-faq.json"), "utf8"));
const faqByArticle = new Map(faqEntries.map((faq) => [`FAQ: ${faq.question}`, faq]));
const app = express();
const port = Number(process.env.PORT || 3000);
const chatRequestWindowMs = 60_000;
const maxChatRequestsPerWindow = 10;
const chatRequestTimestamps = [];
const appAccessPassword = process.env.APP_ACCESS_PASSWORD?.trim();
const appAccessUsername = process.env.APP_ACCESS_USERNAME?.trim() || "tester";

if (process.env.NODE_ENV === "production" && !appAccessPassword) {
  throw new Error("배포 환경에는 APP_ACCESS_PASSWORD를 설정해야 합니다.");
}

function sameSecret(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function protectTestDeployment(request, response, next) {
  if (!appAccessPassword || request.path === "/api/health") return next();
  const authorization = request.get("authorization") || "";
  const match = authorization.match(/^Basic\s+(.+)$/i);
  if (match) {
    try {
      const [username, ...passwordParts] = Buffer.from(match[1], "base64").toString("utf8").split(":");
      const password = passwordParts.join(":");
      if (sameSecret(username || "", appAccessUsername) && sameSecret(password, appAccessPassword)) return next();
    } catch {
      // Malformed credentials receive the same challenge as missing credentials.
    }
  }
  response.set("WWW-Authenticate", 'Basic realm="Ilteobeom tester access", charset="UTF-8"');
  return response.status(401).send("테스터 계정과 비밀번호를 입력해 주세요.");
}

function userFacingError(error) {
  let message = error instanceof Error ? error.message : "답변을 생성하지 못했습니다.";
  const rawMessage = message;
  try {
    const parsed = JSON.parse(message);
    message = parsed.error?.message || message;
  } catch {
    // Keep the original readable message when the SDK error is not JSON.
  }
  if (/429|RESOURCE_EXHAUSTED|quota exceeded/i.test(`${rawMessage} ${message}`)) {
    if (/requests?_per_day|requests? per day|daily.*quota/i.test(`${rawMessage} ${message}`)) {
      return "오늘의 Gemini 무료 API 사용 한도에 도달했어요. 일일 한도는 태평양 시간 기준 자정에 초기화되니, 그 이후 다시 시도해 주세요.";
    }
    if (/requests?_per_minute|requests? per minute|tokens?_per_minute|tokens? per minute/i.test(`${rawMessage} ${message}`)) {
      const retrySeconds = Number(`${rawMessage} ${message}`.match(/retry(?: in|Delay["']?:\s*["']?)(\d+(?:\.\d+)?)\s*s/i)?.[1]);
      return retrySeconds
        ? `Gemini 무료 API의 분당 한도에 도달했어요. 약 ${Math.ceil(retrySeconds)}초 후 다시 시도해 주세요.`
        : "Gemini 무료 API의 분당 한도에 도달했어요. 잠시 기다린 뒤 다시 시도해 주세요.";
    }
    return "Gemini 무료 API 사용 한도에 도달했어요. 분당 한도라면 잠시 후, 일일 한도라면 태평양 시간 기준 자정 이후 다시 시도해 주세요.";
  }
  return message.slice(0, 400);
}

app.use(protectTestDeployment);
app.use(express.static(__dirname));
app.use(express.json({ limit: "20kb" }));

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, stage: "rag-chat" });
});

app.get("/api/documents", async (_request, response) => {
  try {
    const { data, error } = await getSupabaseClient()
      .from("law_documents")
      .select("slug, title, source_file, source_url, effective_date")
      .order("title", { ascending: true });
    if (error) throw error;
    response.json({ documents: data ?? [] });
  } catch (error) {
    console.error("참고 자료 목록을 불러오지 못했습니다:", error instanceof Error ? error.message : "알 수 없는 오류");
    response.status(500).json({ error: "참고 자료 목록을 불러오지 못했습니다." });
  }
});

app.post("/api/chat", async (request, response, next) => {
  const now = Date.now();
  while (chatRequestTimestamps.length && chatRequestTimestamps[0] <= now - chatRequestWindowMs) {
    chatRequestTimestamps.shift();
  }
  if (chatRequestTimestamps.length >= maxChatRequestsPerWindow) {
    const retryAfter = Math.max(1, Math.ceil((chatRequestTimestamps[0] + chatRequestWindowMs - now) / 1000));
    return response.status(429).set("Retry-After", String(retryAfter)).json({
      error: `테스트 앱의 요청 한도에 도달했어요. ${retryAfter}초 후 다시 시도해 주세요.`,
    });
  }
  chatRequestTimestamps.push(now);

  const question = typeof request.body?.question === "string"
    ? request.body.question.trim()
    : "";
  if (!question) return response.status(400).json({ error: "질문을 입력해 주세요." });
  if (question.length > 2000) {
    return response.status(400).json({ error: "질문은 2,000자 이내로 입력해 주세요." });
  }

  try {
    const [queryEmbedding] = await embedTexts([question], "RETRIEVAL_QUERY", "근로기준법 질문");
    const { data: sources, error } = await getSupabaseClient().rpc("match_law_chunks", {
      query_embedding: queryEmbedding,
      match_threshold: 0.25,
      match_count: 6,
    });
    if (error) throw error;

    const retrievedSources = sources ?? [];
    const documentIds = [...new Set(retrievedSources.map((source) => source.document_id).filter(Number.isInteger))];
    let documentsById = new Map();
    if (documentIds.length) {
      const { data: documents, error: documentsError } = await getSupabaseClient()
        .from("law_documents")
        .select("id, title, source_url")
        .in("id", documentIds);
      if (documentsError) throw documentsError;
      documentsById = new Map((documents ?? []).map((document) => [document.id, document]));
    }
    const result = await answerFromSources(question, retrievedSources.slice(0, 5));
    if (result.status !== "answer") {
      const fallbackAnswer = result.status === "out_of_scope"
        ? "현재 저는 근로기준법과 관련 공식 안내자료를 참고해 답변해요. 근로시간, 휴게시간, 임금, 휴일·휴가, 근로계약, 해고 등 일과 관련된 상황을 질문해 주세요."
        : "검색된 법령과 공식 안내자료만으로는 이 질문에 답하기 어려워요. 상황을 더 구체적으로 적거나 관련 근거를 추가해 주세요.";
      return response.json({ answer: fallbackAnswer, sources: [] });
    }
    return response.json({
      answer: result.answer,
      sources: retrievedSources.slice(0, 5).map((source) => {
        const document = documentsById.get(source.document_id);
        const faq = faqByArticle.get(source.article_number);
        return {
          article: source.article_number,
          title: document?.title ?? faq?.source_title ?? null,
          url: document?.source_url ?? faq?.source_url ?? null,
          pages: source.pages ?? [],
          excerpt: source.content,
          similarity: source.similarity,
        };
      }),
    });
  } catch (error) {
    console.error("RAG 답변 생성 실패:", error instanceof Error ? error.message : "알 수 없는 오류");
    return response.status(500).json({
      error: userFacingError(error),
    });
  }
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
