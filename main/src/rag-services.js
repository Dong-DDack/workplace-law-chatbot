import { GoogleGenAI } from "@google/genai";
import { createClient } from "@supabase/supabase-js";

export const EMBEDDING_MODEL = "gemini-embedding-001";
export const EMBEDDING_DIMENSIONS = 768;

let googleClient;
let supabaseClient;

function requireEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`환경 변수 ${name}이(가) 설정되지 않았습니다.`);
  return value;
}

function getGoogleClient() {
  googleClient ??= new GoogleGenAI({ apiKey: requireEnvironment("GEMINI_API_KEY") });
  return googleClient;
}

export function getSupabaseClient() {
  if (!supabaseClient) {
    supabaseClient = createClient(
      requireEnvironment("SUPABASE_URL"),
      requireEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
      { auth: { persistSession: false, autoRefreshToken: false } },
    );
  }
  return supabaseClient;
}

function normalize(values) {
  if (!Array.isArray(values) || values.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`임베딩 차원이 ${EMBEDDING_DIMENSIONS}개가 아닙니다.`);
  }
  const magnitude = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) throw new Error("빈 임베딩 벡터가 반환됐습니다.");
  return values.map((value) => value / magnitude);
}

export async function embedTexts(texts, taskType, title) {
  const config = {
    taskType,
    outputDimensionality: EMBEDDING_DIMENSIONS,
  };
  if (taskType === "RETRIEVAL_DOCUMENT" && title) config.title = title;

  const response = await getGoogleClient().models.embedContent({
    model: EMBEDDING_MODEL,
    contents: texts,
    config,
  });
  const embeddings = response.embeddings ?? [];
  if (embeddings.length !== texts.length) {
    throw new Error("Gemini가 요청한 수와 다른 임베딩 개수를 반환했습니다.");
  }
  return embeddings.map((embedding) => normalize(embedding.values));
}

export async function answerFromSources(question, sources) {
  const model = process.env.GEMINI_MODEL?.trim() || "gemini-3.5-flash-lite";
  const sourceText = sources.map((source, index) => {
    const location = source.pages?.length
      ? `(PDF ${source.pages.join(", ")}쪽)`
      : source.article_number?.startsWith("FAQ:") ? "(웹 FAQ)" : "";
    return `[근거 ${index + 1}] ${source.article_number} ${location}\n${source.content}`;
  }).join("\n\n");
  const response = await getGoogleClient().models.generateContent({
    model,
    contents: `너는 대한민국 근로기준법과 제공된 고용노동부 공식 안내자료만 근거로 답하는 안내 도우미야. 먼저 질문이 이 범위에 맞는지, 검색된 자료가 실제로 질문에 답하는지 판단해.\n\n분류 규칙:\n- 날씨, 요리, 여행, 코딩, 일반 상식 등 근로기준법과 무관한 질문은 status를 "out_of_scope"로 정해.\n- 직장과 관련 있어도 검색된 자료가 질문에 직접 답하지 않거나 다른 법률이 핵심이면 status를 "insufficient_evidence"로 정해. 비슷한 단어가 있다는 이유만으로 조문을 연결하지 마.\n- 근로기준법 또는 공식 안내자료가 직접 뒷받침할 때만 status를 "answer"로 정해. 필요한 사실이 부족하면 답변에서 결론을 단정하지 말고 확인 질문을 최대 2개 해.\n- answer가 아닌 status에서는 사용자가 범위를 이해할 수 있는 짧은 안내만 작성해.\n\n답변 규칙:\n- status가 answer이면 쉬운 한국어로 답하고, Markdown 제목과 목록을 사용해 짧고 읽기 쉽게 작성해. 표는 만들지 마.\n- 법률 용어와 조문 문구를 길게 옮기지 말고 일상적인 말로 풀어 설명해. 꼭 필요한 용어는 바로 뒤에 짧게 뜻을 덧붙여.\n- 발췌문에 없는 법률 내용을 사실처럼 덧붙이거나 구체적인 법적 판단을 확정하지 마.\n- 답변 본문에 조문 번호나 페이지 번호를 새로 만들지 마. 근거 표시는 앱에서 따로 제공해.\n\n질문:\n${question}\n\n검색된 법령·공식 안내자료 발췌문:\n${sourceText}`,
    config: {
      temperature: 0.2,
      maxOutputTokens: 700,
      responseMimeType: "application/json",
      responseJsonSchema: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["answer", "out_of_scope", "insufficient_evidence"],
            description: "Whether the question is in scope and supported by the retrieved law excerpts.",
          },
          answer: { type: "string", description: "The Korean response to display to the user." },
        },
        required: ["status", "answer"],
        propertyOrdering: ["status", "answer"],
      },
    },
  });
  const output = response.text?.trim();
  if (!output) throw new Error("Gemini가 답변을 반환하지 않았습니다.");
  const result = JSON.parse(output);
  if (!["answer", "out_of_scope", "insufficient_evidence"].includes(result.status) || typeof result.answer !== "string") {
    throw new Error("Gemini가 예상한 답변 형식으로 응답하지 않았습니다.");
  }
  return result;
}
