const input = document.querySelector("#questionInput");
const sendButton = document.querySelector("#sendButton");
const messages = document.querySelector("#messages");
const welcome = document.querySelector("#welcome");
const chatScroll = document.querySelector("#chatScroll");
const toast = document.querySelector("#toast");
const authGate = document.querySelector("#authGate");
const authMessage = document.querySelector("#authMessage");
const googleLoginButton = document.querySelector("#googleLogin");
const appShell = document.querySelector("#appShell");

let toastTimer;
const conversationStoragePrefix = "workplace-law-chatbot.conversations.v1";
let conversationStorageKey = conversationStoragePrefix;
let authClient = null;
let conversations = [];
let activeConversationId = null;

function showAuthGate(message) {
  authGate.hidden = false;
  appShell.hidden = true;
  authMessage.textContent = message || "승인된 Google 계정으로 로그인해 주세요.";
}

async function authenticatedFetch(url, options = {}) {
  const { data: { session } } = await authClient.auth.getSession();
  if (!session) throw new Error("로그인이 필요해요. 페이지를 새로고침해 주세요.");
  const headers = new Headers(options.headers || {});
  headers.set("Authorization", `Bearer ${session.access_token}`);
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    await authClient.auth.signOut();
    showAuthGate("로그인 정보가 만료됐어요. 다시 로그인해 주세요.");
  }
  return response;
}

async function initializeAuthentication() {
  try {
    const configResponse = await fetch("/api/auth/config");
    const config = await configResponse.json();
    if (!configResponse.ok) throw new Error(config.error || "로그인 설정을 불러오지 못했어요.");
    if (!window.supabase?.createClient) throw new Error("로그인 라이브러리를 불러오지 못했어요. 네트워크를 확인해 주세요.");

    authClient = window.supabase.createClient(config.supabaseUrl, config.publishableKey);
    googleLoginButton.disabled = false;
    googleLoginButton.addEventListener("click", async () => {
      googleLoginButton.disabled = true;
      authMessage.textContent = "Google 로그인 페이지로 이동합니다…";
      const { error } = await authClient.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin, queryParams: { prompt: "select_account" } },
      });
      if (error) {
        googleLoginButton.disabled = false;
        authMessage.textContent = `로그인을 시작하지 못했어요: ${error.message}`;
      }
    });

    const { data: { session }, error } = await authClient.auth.getSession();
    if (error) throw error;
    if (!session) {
      showAuthGate("초대된 Google 계정으로 로그인해 주세요.");
      return;
    }

    const verification = await fetch("/api/auth/me", {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    const result = await verification.json();
    if (!verification.ok) {
      await authClient.auth.signOut();
      const accessDenied = verification.status === 403;
      const message = result.error || "이 계정은 아직 초대되지 않았어요.";
      showAuthGate(message);
      if (accessDenied) {
        window.alert("이 Google 계정은 아직 초대 목록에 없어 사용할 수 없습니다.\n\n앱 관리자에게 이 계정을 테스터로 추가해 달라고 요청해 주세요.");
      }
      return;
    }

    const user = result.user;
    conversationStorageKey = `${conversationStoragePrefix}.${user.id}`;
    conversations = loadConversations();
    appShell.hidden = false;
    authGate.hidden = true;
    document.querySelector("#accountEmail").textContent = user.email || "";
    document.querySelector("#signOut").addEventListener("click", async () => {
      await authClient.auth.signOut();
      window.location.reload();
    }, { once: true });
    renderConversationList();
    if (conversations.length) {
      const latest = [...conversations].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      showConversation(latest);
    }
  } catch (error) {
    showAuthGate(error instanceof Error ? error.message : "로그인을 준비하지 못했어요.");
  }
}

function loadConversations() {
  try {
    const saved = JSON.parse(localStorage.getItem(conversationStorageKey) || "[]");
    return Array.isArray(saved) ? saved.filter((item) => item && item.id && Array.isArray(item.messages)) : [];
  } catch {
    return [];
  }
}

function saveConversations() {
  try {
    localStorage.setItem(conversationStorageKey, JSON.stringify(conversations));
  } catch {
    showToast("이 브라우저의 저장 공간이 부족해요. 대화를 내보낸 뒤 오래된 대화를 정리해 주세요.");
  }
}

function activeConversation() {
  return conversations.find((conversation) => conversation.id === activeConversationId) ?? null;
}

function renderConversationList() {
  const list = document.querySelector("#conversationList");
  list.replaceChildren();
  [...conversations].reverse().forEach((conversation) => {
    const row = document.createElement("div");
    row.className = `conversation-row${conversation.id === activeConversationId ? " active" : ""}`;
    const button = document.createElement("button");
    button.className = "conversation-item";
    button.type = "button";
    button.dataset.conversationId = conversation.id;
    button.textContent = conversation.title || "새 대화";
    button.title = conversation.title || "새 대화";

    const more = document.createElement("button");
    more.className = "conversation-more";
    more.type = "button";
    more.dataset.conversationToggle = conversation.id;
    more.setAttribute("aria-label", `${conversation.title || "대화"} 메뉴`);
    more.setAttribute("aria-expanded", "false");
    more.textContent = "···";

    const menu = document.createElement("div");
    menu.className = "conversation-menu";
    menu.dataset.conversationMenu = conversation.id;
    menu.hidden = true;
    [
      ["rename", "현재 대화 제목 수정"],
      ["delete", "현재 대화 삭제"],
      ["export", "대화 내보내기"],
    ].forEach(([action, label]) => {
      const item = document.createElement("button");
      item.type = "button";
      item.dataset.conversationAction = action;
      item.dataset.conversationActionId = conversation.id;
      item.textContent = label;
      menu.append(item);
    });
    row.append(button, more, menu);
    list.append(row);
  });
}

function showConversation(conversation) {
  activeConversationId = conversation.id;
  messages.replaceChildren();
  messages.classList.add("has-messages");
  welcome.hidden = true;
  conversation.messages.forEach((entry) => {
    if (entry.role === "user") addUserMessage(entry.content);
    if (entry.role === "assistant") addAnswer({ answer: entry.content, sources: entry.sources || [] });
  });
  renderConversationList();
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function startNewConversation() {
  activeConversationId = null;
  messages.replaceChildren();
  messages.classList.remove("has-messages");
  welcome.hidden = false;
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  renderConversationList();
  input.focus();
}

function setConversationTitle(conversation, question) {
  if (conversation.messages.some((entry) => entry.role === "user")) return;
  conversation.title = question.replace(/\s+/g, " ").trim().slice(0, 32) || "새 대화";
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
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

function appendInlineFormattedText(parent, value) {
  const segments = String(value).split(/(\*\*[^*]+\*\*)/g);
  for (const segment of segments) {
    if (!segment) continue;
    if (segment.startsWith("**") && segment.endsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = segment.slice(2, -2);
      parent.append(strong);
    } else {
      parent.append(document.createTextNode(segment));
    }
  }
}

function renderAnswerText(container, answerText) {
  const lines = String(answerText || "").split(/\r?\n/);
  let paragraphLines = [];
  let currentList = null;

  function flushParagraph() {
    if (!paragraphLines.length) return;
    const paragraph = document.createElement("p");
    appendInlineFormattedText(paragraph, paragraphLines.join(" "));
    container.append(paragraph);
    paragraphLines = [];
  }

  function flushList() {
    currentList = null;
  }

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const heading = line.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      const title = document.createElement("h4");
      appendInlineFormattedText(title, heading[1]);
      container.append(title);
      continue;
    }

    const bullet = line.match(/^(?:[-*•])\s+(.+)$/);
    const numbered = line.match(/^\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph();
      const listType = numbered ? "ol" : "ul";
      if (!currentList || currentList.tagName.toLowerCase() !== listType) {
        flushList();
        currentList = document.createElement(listType);
        container.append(currentList);
      }
      const item = document.createElement("li");
      appendInlineFormattedText(item, (bullet || numbered)[1]);
      currentList.append(item);
      continue;
    }

    flushList();
    paragraphLines.push(line);
  }

  flushParagraph();
  flushList();
}

function addAnswer(answer) {
  const row = document.createElement("div");
  row.className = "message";
  const body = document.createElement("div");
  body.className = "message-body";
  const label = document.createElement("div");
  label.className = "message-label";
  label.textContent = "근로기준법 RAG 답변";
  const card = document.createElement("div");
  card.className = "answer-card";
  const text = document.createElement("div");
  text.className = "answer-copy";
  renderAnswerText(text, answer.answer);
  const citations = document.createElement("div");
  citations.className = "answer-citations";
  (answer.sources || []).forEach((source) => {
    const citation = document.createElement(source.url ? "a" : "button");
    citation.className = "citation";
    if (source.url) {
      citation.href = source.url;
      citation.target = "_blank";
      citation.rel = "noopener noreferrer";
    } else {
      citation.type = "button";
    }
    const pages = Array.isArray(source.pages) && source.pages.length
      ? `PDF ${source.pages.join(", ")}쪽`
      : source.url?.includes("/faq/") ? "웹 FAQ"
        : source.url ? "공식 자료" : "페이지 정보 없음";
    citation.textContent = source.url?.includes("/faq/")
      ? `▤ ${source.title || "고용노동부 FAQ"} · 웹 FAQ`
      : `▤ ${source.title || source.article} · ${source.article} · ${pages}`;
    if (!source.url) {
      citation.addEventListener("click", () => {
        showToast(`${source.article} · ${pages} ${source.excerpt.slice(0, 120)}`);
      });
    }
    citations.append(citation);
  });
  const disclaimer = document.createElement("p");
  disclaimer.className = "answer-disclaimer";
  disclaimer.textContent = "학습용 예시입니다. 실제 법 적용과 권리 판단은 구체적인 사실관계에 따라 달라질 수 있어요.";
  card.append(text, citations, disclaimer);
  body.append(label, card);
  row.append(Object.assign(document.createElement("div"), { className: "message-avatar", textContent: "일" }), body);
  messages.append(row);
}

async function submitQuestion(value = input.value) {
  const question = value.trim();
  if (!question) return;
  let conversation = activeConversation();
  if (!conversation) {
    conversation = { id: crypto.randomUUID(), title: "새 대화", messages: [], updatedAt: Date.now() };
    conversations.push(conversation);
    activeConversationId = conversation.id;
  }
  setConversationTitle(conversation, question);
  conversation.messages.push({ role: "user", content: question });
  conversation.updatedAt = Date.now();
  saveConversations();
  renderConversationList();
  welcome.hidden = true;
  messages.classList.add("has-messages");
  addUserMessage(question);
  input.value = "";
  input.style.height = "auto";
  sendButton.disabled = true;
  addTyping();
  chatScroll.scrollTop = chatScroll.scrollHeight;
  try {
    const response = await authenticatedFetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "답변을 가져오지 못했습니다.");
    conversation.messages.push({ role: "assistant", content: result.answer, sources: result.sources || [] });
    conversation.updatedAt = Date.now();
    saveConversations();
    addAnswer(result);
  } catch (error) {
    const failedAnswer = {
      answer: error instanceof Error ? error.message : "답변을 가져오지 못했습니다.",
      sources: [],
    };
    conversation.messages.push({ role: "assistant", content: failedAnswer.answer, sources: [] });
    conversation.updatedAt = Date.now();
    saveConversations();
    addAnswer(failedAnswer);
  } finally {
    document.querySelector("#typingIndicator")?.remove();
    sendButton.disabled = !input.value.trim();
    renderConversationList();
    chatScroll.scrollTop = chatScroll.scrollHeight;
  }
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
document.querySelector("#newChat").addEventListener("click", startNewConversation);
document.querySelector("#clearConversations").addEventListener("click", () => {
  if (!conversations.length) {
    showToast("삭제할 대화가 없습니다.");
    return;
  }
  if (window.confirm("이 브라우저에 저장된 모든 대화를 삭제할까요? 삭제 후에는 복구할 수 없습니다.")) {
    conversations = [];
    localStorage.removeItem(conversationStorageKey);
    startNewConversation();
  }
});
document.querySelector("#conversationList").addEventListener("click", (event) => {
  const toggle = event.target.closest("[data-conversation-toggle]");
  if (toggle) {
    const id = toggle.dataset.conversationToggle;
    const menu = document.querySelector(`[data-conversation-menu="${CSS.escape(id)}"]`);
    const shouldOpen = menu.hidden;
    document.querySelectorAll(".conversation-menu").forEach((item) => { item.hidden = true; });
    document.querySelectorAll("[data-conversation-toggle]").forEach((item) => item.setAttribute("aria-expanded", "false"));
    if (shouldOpen) {
      const bounds = toggle.getBoundingClientRect();
      const menuWidth = 190;
      const menuHeight = 132;
      const left = Math.max(8, Math.min(bounds.right - menuWidth, window.innerWidth - menuWidth - 8));
      const below = bounds.bottom + 4;
      const top = below + menuHeight <= window.innerHeight - 8
        ? below
        : Math.max(8, bounds.top - menuHeight - 4);
      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
    }
    menu.hidden = !shouldOpen;
    toggle.setAttribute("aria-expanded", String(shouldOpen));
    return;
  }

  const actionButton = event.target.closest("[data-conversation-action]");
  if (actionButton) {
    const conversation = conversations.find((item) => item.id === actionButton.dataset.conversationActionId);
    const action = actionButton.dataset.conversationAction;
    document.querySelectorAll(".conversation-menu").forEach((item) => { item.hidden = true; });
    document.querySelectorAll("[data-conversation-toggle]").forEach((item) => item.setAttribute("aria-expanded", "false"));
    if (!conversation) return;
    if (action === "rename") {
      const title = window.prompt("대화 제목", conversation.title);
      if (title?.trim()) {
        conversation.title = title.trim().slice(0, 60);
        conversation.updatedAt = Date.now();
        saveConversations();
        renderConversationList();
      }
    }
    if (action === "delete" && window.confirm(`“${conversation.title}” 대화를 삭제할까요?`)) {
      conversations = conversations.filter((item) => item.id !== conversation.id);
      saveConversations();
      if (activeConversationId === conversation.id) startNewConversation();
      else renderConversationList();
    }
    if (action === "export") {
      const file = new Blob([JSON.stringify(conversation, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${conversation.title.replace(/[\\/:*?"<>|]/g, "-").slice(0, 40) || "대화"}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    return;
  }

  const button = event.target.closest("[data-conversation-id]");
  const conversation = conversations.find((item) => item.id === button?.dataset.conversationId);
  if (conversation) {
    document.querySelectorAll(".conversation-menu").forEach((item) => { item.hidden = true; });
    showConversation(conversation);
  }
});
document.addEventListener("click", (event) => {
  if (event.target.closest(".conversation-row")) return;
  document.querySelectorAll(".conversation-menu").forEach((item) => { item.hidden = true; });
  document.querySelectorAll("[data-conversation-toggle]").forEach((item) => item.setAttribute("aria-expanded", "false"));
});
document.querySelector("#conversationList").addEventListener("scroll", () => {
  document.querySelectorAll(".conversation-menu").forEach((item) => { item.hidden = true; });
}, { passive: true });
document.querySelector(".help-button").addEventListener("click", () => showToast("법령 근거를 찾아 쉬운 말로 설명하는 학습용 프로토타입입니다."));

const libraryOverlay = document.querySelector("#libraryOverlay");
const libraryContent = document.querySelector("#libraryContent");
let libraryLoaded = false;

function renderLibrary(documents) {
  document.querySelector("#sourceCount").textContent = `${documents.length}개 자료`;
  if (!documents.length) {
    libraryContent.innerHTML = '<div class="empty-preview">등록된 자료가 아직 없습니다.</div>';
    return;
  }
  libraryContent.innerHTML = `<div class="library-list">${documents.map((doc) => {
    const isFaq = doc.source_file?.endsWith(".json");
    const type = isFaq ? "FAQ" : "PDF 자료";
    const detail = [type, doc.source_file].filter(Boolean).join(" · ");
    const title = escapeHtml(doc.title || "제목 없는 자료");
    return `<article class="library-item"><div class="library-file-icon">${isFaq ? "Q&A" : "PDF"}</div><div class="library-item-copy"><strong>${title}</strong><small>${escapeHtml(detail)}</small></div>${doc.source_url ? `<a class="library-link" href="${escapeHtml(doc.source_url)}" target="_blank" rel="noopener noreferrer">원문 ↗</a>` : '<span class="library-indexed">검색 등록됨</span>'}</article>`;
  }).join("")}</div><p class="library-footnote">자료 이름을 누르면 공식 원문이 있는 경우 새 창에서 열립니다. 대화 검색에는 등록된 자료가 사용됩니다.</p>`;
}

async function openLibrary() {
  libraryOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#closeLibrary").focus();
  if (libraryLoaded) return;
  libraryContent.innerHTML = '<div class="preview-loading"><span class="loading-spinner"></span> 등록 자료를 불러오고 있어요…</div>';
  try {
    const response = await authenticatedFetch("/api/documents");
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "자료 목록을 가져오지 못했습니다.");
    renderLibrary(result.documents || []);
    libraryLoaded = true;
  } catch (error) {
    libraryContent.innerHTML = `<div class="preview-error">${escapeHtml(error.message || "자료 목록을 가져오지 못했습니다.")}</div>`;
  }
}

function closeLibrary() {
  libraryOverlay.hidden = true;
  document.body.style.overflow = "";
}

document.querySelector("#openLibrary").addEventListener("click", openLibrary);
document.querySelector("#openLibraryNav").addEventListener("click", openLibrary);
document.querySelector("#closeLibrary").addEventListener("click", closeLibrary);
libraryOverlay.addEventListener("click", (event) => {
  if (event.target === libraryOverlay) closeLibrary();
});

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
    <p class="preview-footnote">이 미리보기는 근로기준법 PDF에서 텍스트와 조문을 추출한 결과를 보여줘요. 실제 질문 답변에는 임베딩되어 검색된 법령과 공식 안내자료가 사용됩니다.</p>`;
}

async function openDocumentPreview() {
  previewOverlay.hidden = false;
  document.body.style.overflow = "hidden";
  document.querySelector("#closePreview").focus();
  if (previewLoaded) return;
  previewContent.innerHTML = '<div class="preview-loading"><span class="loading-spinner"></span> PDF에서 텍스트와 조문을 읽고 있어요…</div>';
  try {
    const response = await authenticatedFetch("/api/documents/labor-law/preview");
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

document.querySelector("#previewSource")?.addEventListener("click", openDocumentPreview);
document.querySelector("#closePreview")?.addEventListener("click", closeDocumentPreview);
previewOverlay.addEventListener("click", (event) => {
  if (event.target === previewOverlay) closeDocumentPreview();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !previewOverlay.hidden) closeDocumentPreview();
  if (event.key === "Escape" && !libraryOverlay.hidden) closeLibrary();
  if (event.ctrlKey && event.altKey && event.key.toLowerCase() === "n") {
    event.preventDefault();
    startNewConversation();
  }
});

await initializeAuthentication();
