const input = document.querySelector("#questionInput");
const sendButton = document.querySelector("#sendButton");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcome");
const chatScroll = document.querySelector("#chatScroll");
const toast = document.querySelector("#toast");

const demoAnswers = [
  {
    test: /(휴게|쉬는 시간|쉬는시간)/,
    article: "제54조 · 휴게",
    page: "조문 위치 연결 예정",
    body: "근로시간이 4시간이면 30분 이상, 8시간이면 1시간 이상의 휴게시간을 근로시간 도중에 줘야 해요. 휴게시간은 근로자가 자유롭게 이용할 수 있어야 합니다.",
    follow: "실제 적용은 근무 형태와 법 적용 예외 여부에 따라 달라질 수 있어요."
  },
  {
    test: /(연차|유급휴가|휴가)/,
    article: "제60조 · 연차 유급휴가",
    page: "조문 위치 연결 예정",
    body: "일반적으로 1년간 출근율이 80% 이상이면 15일의 유급휴가가 발생합니다. 계속 근로기간이 1년 미만인 근로자는 한 달을 개근할 때마다 1일의 휴가가 생길 수 있어요.",
    follow: "근속기간, 출근율, 사업장 규모 등 구체적인 조건을 함께 확인해야 해요."
  },
  {
    test: /(임금|월급|급여|월급날|늦게|못 받)/,
    article: "제43조 · 임금 지급",
    page: "조문 위치 연결 예정",
    body: "임금은 원칙적으로 근로자에게 전액을 직접 지급하고, 매월 1회 이상 일정한 날짜를 정해 지급해야 합니다. 임금이 밀렸다면 근로계약서, 급여명세서, 출퇴근 기록 등 자료를 모아 공식 상담·신고 경로를 확인해보세요.",
    follow: "체불 여부와 받을 수 있는 금액은 계약 내용과 실제 근무 기록을 따져봐야 합니다."
  },
  {
    test: /(근로계약서|계약서)/,
    article: "제17조 · 근로조건의 명시",
    page: "조문 위치 연결 예정",
    body: "사용자는 임금, 소정근로시간, 휴일, 연차 유급휴가 등 법에서 정한 근로조건을 명시해야 하고, 주요 내용이 적힌 서면을 근로자에게 교부해야 합니다.",
    follow: "계약서의 항목별 내용과 실제 근무 조건이 다르면 관련 자료를 함께 확인하는 것이 좋습니다."
  }
];

let toastTimer;
function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function answerFor(question) {
  const found = demoAnswers.find((answer) => answer.test.test(question));
  if (found) return found;
  return {
    article: "관련 조문을 더 확인해야 해요",
    page: "근로기준법 PDF",
    body: "이 프로토타입에는 휴게시간, 연차, 임금 지급, 근로계약서에 관한 예시 답변만 들어 있어요. 실제 버전에서는 질문과 관련된 조문을 문서에서 검색해 답하도록 연결할 예정입니다.",
    follow: "질문을 조금 구체적으로 적거나 위의 예시 질문을 선택해보세요."
  };
}

function addUserMessage(question) {
  const row = document.createElement("div");
  row.className = "message user";
  const bubble = document.createElement("div");
  bubble.className = "user-bubble";
  bubble.textContent = question;
  row.append(bubble);
  messages.append(row);
}

function addTyping() {
  const row = document.createElement("div");
  row.className = "message";
  row.id = "typingIndicator";
  row.innerHTML = '<div class="message-avatar">일</div><div class="message-body"><div class="message-label">일터법이 답변을 준비하고 있어요</div><div class="typing"><i></i><i></i><i></i></div></div>';
  messages.append(row);
}

function addAnswer(answer) {
  const row = document.createElement("div");
  row.className = "message";
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "근로기준법을 바탕으로 한 예시 답변";
  const card = document.createElement("div");
  card.className = "answer-card";
  const text = document.createElement("p");
  text.textContent = answer.body;
  const follow = document.createElement("p");
  follow.textContent = answer.follow;
  const citation = document.createElement("button");
  citation.className = "citation";
  citation.type = "button";
  citation.innerHTML = `<span>▤</span> ${answer.article} <span class="page">${answer.page}</span>`;
  citation.addEventListener("click", () => showToast("실제 PDF 조문 연결은 다음 개발 단계에서 붙일게요."));
  const disclaimer = document.createElement("p");
  disclaimer.className = "answer-disclaimer";
  disclaimer.textContent = "학습용 예시입니다. 실제 법 적용과 권리 판단은 구체적인 사실관계에 따라 달라질 수 있어요.";
  card.append(text, follow, citation, disclaimer);
  body.append(label, card);
  row.append(Object.assign(document.createElement("div"), { className: "message-avatar", textContent: "일" }), body);
  messages.append(row);
}

function submitQuestion(value = input.value) {
  const question = value.trim();
  if (!question) return;
  welcome.hidden = true;
  messages.classList.add("has-messages");
  addUserMessage(question);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  addTyping();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  setTimeout(() => {
    document.querySelector("#typingIndicator")?.remove();
    addAnswer(answerFor(question));
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }, 520);
}

input.addEventListener("input", () => {
  sendButton.disabled = !input.value.trim();
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 100)}px`;
});
input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    submitQuestion();
  }
});
sendButton.addEventListener("click", () => submitQuestion());
document.querySelectorAll(".suggestion-card").forEach((card) => {
  card.addEventListener("click", () => submitQuestion(card.dataset.question));
});
document.querySelector("#newChat").addEventListener("click", () => {
  messages.replaceChildren();
  messages.classList.remove("has-messages");
  welcome.hidden = false;
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  input.focus();
});
document.querySelector("#addSource").addEventListener("click", () => showToast("문서 업로드 기능은 PDF 검색을 연결할 때 추가할게요."));
document.querySelector(".help-button").addEventListener("click", () => showToast("법령 근거를 찾아 쉬운 말로 설명하는 학습용 프로토타입입니다."));

const previewOverlay = document.querySelector("#previewOverlay");
const previewContent = document.querySelector("#previewContent");
let previewLoaded = false;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function renderDocumentPreview(data) {
  const summary = [
    ["페이지", `${data.pageCount}쪽`],
    ["추출 글자", Number(data.extractedCharacters).toLocaleString("ko-KR")],
    ["찾은 조문", `${data.articleCount}개`],
    ["만든 조각", `${data.chunkCount}개`],
  ];
  const alertClass = data.pagesWithoutText?.length ? "extraction-alert warning" : "extraction-alert";
  const noTextPages = data.pagesWithoutText?.length
    ? ` 글자가 거의 없는 페이지: ${data.pagesWithoutText.join(", ")}쪽.`
    : "";
  const pageSamples = (data.pageSamples || []).map((page) => `
    <details class="preview-page-sample"><summary>${page.pageNumber}쪽 텍스트 일부</summary><p>${escapeHtml(page.text)}</p></details>`).join("");
  const chunks = (data.sampleChunks || []).map((chunk) => `
    <article class="chunk-card"><div class="chunk-title">${escapeHtml(chunk.article)}${chunk.part > 1 ? ` · 조각 ${chunk.part}` : ""}</div><div class="chunk-meta">PDF ${escapeHtml(chunk.pages.join(", ") || "페이지 정보 없음")}쪽</div><p>${escapeHtml(chunk.text.slice(0, 900))}${chunk.text.length > 900 ? "…" : ""}</p></article>`).join("");

  previewContent.innerHTML = `
    <div class="preview-file-row">파일 <b>${escapeHtml(data.fileName)}</b></div>
    <div class="preview-summary">${summary.map(([label, value]) => `<div class="summary-card"><small>${label}</small><strong>${escapeHtml(value)}</strong></div>`).join("")}</div>
    <div class="${alertClass}">${escapeHtml(data.extractionNote)}${escapeHtml(noTextPages)}</div>
    <div class="preview-section-title">추출한 페이지 텍스트 <small>최대 3쪽 미리보기</small></div>
    ${pageSamples || '<div class="empty-preview">추출된 페이지 텍스트가 없습니다. 스캔 PDF인지 확인해 주세요.</div>'}
    <div class="preview-section-title">조문별 문서 조각 <small>첫 8개 미리보기</small></div>
    ${chunks || '<div class="empty-preview">조문 제목을 찾지 못했습니다. PDF의 제목·줄바꿈 구조를 확인해야 합니다.</div>'}
    <p class="preview-footnote">이번 단계는 텍스트 추출과 조문별 분할을 확인하는 미리보기예요. 아직 임베딩 생성, 벡터DB 저장, AI 답변 생성은 연결되지 않았습니다.</p>`;
}

async function openDocumentPreview() {
  previewOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#closePreview").focus();
  if (previewLoaded) return;
  previewContent.innerHTML = '<div class="preview-loading"><span class="loading-spinner"></span> PDF에서 텍스트와 조문을 읽고 있어요…</div>';
  try {
    const response = await fetch("/api/documents/labor-law/preview");
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "PDF를 읽지 못했습니다.");
    renderDocumentPreview(data);
    previewLoaded = true;
  } catch (error) {
    previewContent.innerHTML = `<div class="preview-error">${escapeHtml(error.message || "PDF 미리보기를 불러오지 못했습니다.")}<br><br>프로젝트 폴더에서 <b>npm start</b>로 웹 서버를 실행했는지 확인해 주세요.</div>`;
  }
}

function closeDocumentPreview() {
  previewOverlay.hidden = true;
  document.body.style.overflow = "";
}

document.querySelector("#previewSource").addEventListener("click", openDocumentPreview);
document.querySelector("#closePreview").addEventListener("click", closeDocumentPreview);
previewOverlay.addEventListener("click", (event) => {
  if (event.target === previewOverlay) closeDocumentPreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !previewOverlay.hidden) closeDocumentPreview();
});
