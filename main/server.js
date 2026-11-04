import fs from "node:fs/promises";
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
const maxChatRequestsPerMinutePerUser = 5;
const chatRequestTimestamps = new Map();
const allowedEmails = new Set(
  (process.env.APP_ALLOWED_EMAILS || "").split(",").map((email) => email.trim().toLowerCase()).filter(Boolean),
);
const dailyChatLimit = Math.max(1, Number.parseInt(process.env.APP_DAILY_CHAT_LIMIT || "10", 10) || 10);
const globalDailyChatLimit = Math.max(1, Number.parseInt(process.env.APP_GLOBAL_DAILY_CHAT_LIMIT || "30", 10) || 30);

if (process.env.NODE_ENV === "production" && !allowedEmails.size) {
  throw new Error("배포 환경에는 APP_ALLOWED_EMAILS에 로그인 허용 이메일을 설정해야 합니다.");
}
if (process.env.NODE_ENV === "production") {
  const missingAuthSettings = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_PUBLISHABLE_KEY", "GEMINI_API_KEY"]
    .filter((name) => !process.env[name]?.trim());
  if (missingAuthSettings.length) {
    throw new Error(`배포 환경변수가 비어 있습니다: ${missingAuthSettings.join(", ")}`);
  }
}

async function requireAllowedUser(request, response, next) {
  const token = request.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) return response.status(401).json({ error: "Google 계정으로 로그인해 주세요." });

  try {
    const { data, error } = await getSupabaseClient().auth.getUser(token);
    const user = data?.user;
    if (error || !user) return response.status(401).json({ error: "로그인 정보가 만료됐어요. 다시 로그인해 주세요." });
    const email = user.email?.trim().toLowerCase();
    const providers = user.app_metadata?.providers || [];
    const usedGoogleProvider = user.app_metadata?.provider === "google" || providers.includes("google");
    if (!usedGoogleProvider || !email || !allowedEmails.has(email)) {
      return response.status(403).json({ error: "아직 초대되지 않은 계정이에요. 프로젝트 관리자에게 접근을 요청해 주세요." });
    }
    request.authUser = user;
    return next();
  } catch {
    return response.status(401).json({ error: "로그인 정보를 확인하지 못했어요. 다시 로그인해 주세요." });
  }
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

function describeServerError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (error && typeof error === "object") {
    const fields = ["code", "message", "details", "hint", "status", "statusText"];
    const details = fields
      .filter((field) => typeof error[field] === "string" && error[field])
      .map((field) => `${field}=${error[field]}`);
    if (details.length) return details.join(" | ");
  }
  return "오류 객체에 메시지 필드가 없습니다.";
}

app.use(express.static(__dirname));
app.use(express.json({ limit: "20kb" }));

app.get("/vendor/supabase.js", (_request, response) => {
  response.sendFile(path.join(__dirname, "node_modules", "@supabase", "supabase-js", "dist", "umd", "supabase.js"));
});

app.get("/api/health", (_request, response) => {
  response.json({ ok: true, stage: "rag-chat" });
});

app.get("/api/auth/config", (_request, response) => {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY?.trim();
  if (!supabaseUrl || !publishableKey) {
    return response.status(503).json({ error: "Supabase 로그인 설정이 아직 완료되지 않았습니다." });
  }
  return response.json({ supabaseUrl, publishableKey });
});

app.get("/api/auth/me", requireAllowedUser, (request, response) => {
  response.json({ user: { id: request.authUser.id, email: request.authUser.email } });
});

app.get("/api/documents", requireAllowedUser, async (_request, response) => {
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

app.post("/api/chat", requireAllowedUser, async (request, response) => {
  const now = Date.now();
  const userTimestamps = (chatRequestTimestamps.get(request.authUser.id) || []).filter((timestamp) => timestamp > now - chatRequestWindowMs);
  if (userTimestamps.length >= maxChatRequestsPerMinutePerUser) {
    const retryAfter = Math.max(1, Math.ceil((userTimestamps[0] + chatRequestWindowMs - now) / 1000));
    return response.status(429).set("Retry-After", String(retryAfter)).json({
      error: `분당 질문 한도에 도달했어요. ${retryAfter}초 후 다시 시도해 주세요.`,
    });
  }
  userTimestamps.push(now);
  chatRequestTimestamps.set(request.authUser.id, userTimestamps);

  const question = typeof request.body?.question === "string"
    ? request.body.question.trim()
    : "";
  if (!question) return response.status(400).json({ error: "질문을 입력해 주세요." });
  if (question.length > 2000) {
    return response.status(400).json({ error: "질문은 2,000자 이내로 입력해 주세요." });
  }

  let userQuotaReserved = false;
  let globalQuotaReserved = false;
  let failureStage = "전체 질문 한도 예약";
  try {
    const { data: globalQuotaAvailable, error: globalQuotaError } = await getSupabaseClient().rpc("consume_global_daily_chat_quota", {
      p_daily_limit: globalDailyChatLimit,
    });
    if (globalQuotaError) throw globalQuotaError;
    if (!globalQuotaAvailable) {
      return response.status(429).json({ error: `오늘 서비스 전체 질문 한도(${globalDailyChatLimit}회)를 모두 사용했어요. 한국 시간 자정 이후 다시 이용해 주세요.` });
    }
    globalQuotaReserved = true;

    failureStage = "계정별 질문 한도 예약";
    const { data: quotaAvailable, error: quotaError } = await getSupabaseClient().rpc("consume_daily_chat_quota", {
      p_user_id: request.authUser.id,
      p_daily_limit: dailyChatLimit,
    });
    if (quotaError) throw quotaError;
    if (!quotaAvailable) {
      try {
        await getSupabaseClient().rpc("release_global_daily_chat_quota");
      } catch {
        // Keep the per-user limit response if the global reservation cannot be released.
      }
      globalQuotaReserved = false;
      return response.status(429).json({ error: `오늘의 질문 한도(${dailyChatLimit}회)를 모두 사용했어요. 한국 시간 자정 이후 다시 이용해 주세요.` });
    }
    userQuotaReserved = true;

    failureStage = "Gemini 질문 임베딩 생성";
    const [queryEmbedding] = await embedTexts([question], "RETRIEVAL_QUERY", "근로기준법 질문");
    failureStage = "Supabase 벡터 검색";
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
      failureStage = "Supabase 문서 정보 조회";
      const { data: documents, error: documentsError } = await getSupabaseClient()
        .from("law_documents")
        .select("id, title, source_url")
        .in("id", documentIds);
      if (documentsError) throw documentsError;
      documentsById = new Map((documents ?? []).map((document) => [document.id, document]));
    }
    failureStage = "Gemini 답변 생성";
    const result = await answerFromSources(question, retrievedSources.slice(0, 5));
    if (result.status !== "answer") {
      userQuotaReserved = false;
      globalQuotaReserved = false;
      const fallbackAnswer = result.status === "out_of_scope"
        ? "현재 저는 근로기준법과 관련 공식 안내자료를 참고해 답변해요. 근로시간, 휴게시간, 임금, 휴일·휴가, 근로계약, 해고 등 일과 관련된 상황을 질문해 주세요."
        : "검색된 법령과 공식 안내자료만으로는 이 질문에 답하기 어려워요. 상황을 더 구체적으로 적거나 관련 근거를 추가해 주세요.";
      return response.json({ answer: fallbackAnswer, sources: [] });
    }
    userQuotaReserved = false;
    globalQuotaReserved = false;
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
    if (userQuotaReserved) {
      try {
        await getSupabaseClient().rpc("release_daily_chat_quota", { p_user_id: request.authUser.id });
      } catch {
        // Keep the original chat error if per-user quota cleanup fails.
      }
    }
    if (globalQuotaReserved) {
      try {
        await getSupabaseClient().rpc("release_global_daily_chat_quota");
      } catch {
        // Keep the original chat error if global quota cleanup fails.
      }
    }
    console.error(`RAG 답변 생성 실패 (${failureStage}):`, describeServerError(error));
    return response.status(500).json({
      error: userFacingError(error),
    });
  }
});

app.get("/api/documents/labor-law/preview", requireAllowedUser, async (_request, response) => {
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
