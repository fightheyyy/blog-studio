const elements = {
  actionMessage: document.querySelector("#action-message"),
  commitMessage: document.querySelector("#commit-message"),
  confirmPublish: document.querySelector("#confirm-publish"),
  contentHtml: document.querySelector("#content-html"),
  date: document.querySelector("#date"),
  deck: document.querySelector("#deck"),
  description: document.querySelector("#description"),
  documentKind: document.querySelector("#document-kind"),
  documentState: document.querySelector("#document-state"),
  editHint: document.querySelector("#edit-hint"),
  editorWorkbench: document.querySelector(".editor-workbench"),
  headlineLines: document.querySelector("#headline-lines"),
  htmlCount: document.querySelector("#html-count"),
  imageInput: document.querySelector("#image-input"),
  kicker: document.querySelector("#kicker"),
  loadingCover: document.querySelector("#loading-cover"),
  newPost: document.querySelector("#new-post"),
  openPage: document.querySelector("#open-page"),
  postCount: document.querySelector("#post-count"),
  postList: document.querySelector("#post-list"),
  previewFrame: document.querySelector("#preview-frame"),
  previewStage: document.querySelector("#preview-stage"),
  publish: document.querySelector("#publish"),
  publishArticleName: document.querySelector("#publish-article-name"),
  publishDialog: document.querySelector("#publish-dialog"),
  publishTarget: document.querySelector("#publish-target"),
  publishWarning: document.querySelector("#publish-warning"),
  readMinutes: document.querySelector("#read-minutes"),
  refreshStatus: document.querySelector("#refresh-status"),
  repoBranch: document.querySelector("#repo-branch"),
  repoDot: document.querySelector("#repo-dot"),
  repoRemote: document.querySelector("#repo-remote"),
  saveDraft: document.querySelector("#save-draft"),
  slug: document.querySelector("#slug"),
  title: document.querySelector("#title"),
  toast: document.querySelector("#toast"),
  toolbar: document.querySelector("#toolbar"),
  workspaceTitle: document.querySelector("#workspace-title"),
};

const fields = [
  elements.title,
  elements.headlineLines,
  elements.slug,
  elements.kicker,
  elements.date,
  elements.readMinutes,
  elements.deck,
  elements.description,
];

const state = {
  posts: [],
  current: null,
  git: null,
  dirty: false,
  busy: false,
  mode: "visual",
  hydrating: false,
  previewTimer: 0,
  toastTimer: 0,
};

bindEvents();
initialize();

async function initialize() {
  try {
    const [postsResult] = await Promise.all([loadPosts(), loadGitStatus({ quiet: true })]);
    if (postsResult.length) await openArticle(postsResult[0].slug, { skipConfirm: true });
    else await startNewArticle({ skipConfirm: true });
  } catch (error) {
    showError(error);
  } finally {
    window.setTimeout(() => elements.loadingCover.classList.add("is-hidden"), 180);
  }
}

function bindEvents() {
  elements.newPost.addEventListener("click", () => startNewArticle());
  elements.refreshStatus.addEventListener("click", () => loadGitStatus());
  elements.saveDraft.addEventListener("click", () => saveDraft());
  elements.publish.addEventListener("click", () => openPublishDialog());
  elements.confirmPublish.addEventListener("click", () => publishArticle());
  elements.contentHtml.addEventListener("input", onHtmlInput);
  elements.imageInput.addEventListener("change", uploadImage);
  elements.previewFrame.addEventListener("load", configurePreviewFrame);

  fields.forEach((field) => field.addEventListener("input", onMetadataInput));

  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setEditorMode(button.dataset.mode));
  });
  document.querySelectorAll("[data-viewport]").forEach((button) => {
    button.addEventListener("click", () => setViewport(button.dataset.viewport));
  });
  elements.toolbar.addEventListener("click", handleToolbarClick);

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveDraft();
    }
  });
  window.addEventListener("beforeunload", (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });
}

async function loadPosts() {
  const result = await api("/api/posts");
  state.posts = result.posts;
  renderPostList();
  return result.posts;
}

async function loadGitStatus({ quiet = false } = {}) {
  try {
    const result = await api("/api/status");
    state.git = result.status;
    renderGitStatus();
    return result.status;
  } catch (error) {
    state.git = null;
    elements.repoDot.className = "status-dot is-warning";
    elements.repoBranch.textContent = "Git 状态读取失败";
    elements.repoRemote.textContent = error.message;
    if (!quiet) showError(error);
    return null;
  }
}

function renderGitStatus() {
  const git = state.git;
  if (!git) return;
  const sync = [git.ahead ? `↑${git.ahead}` : "", git.behind ? `↓${git.behind}` : ""]
    .filter(Boolean)
    .join(" ");
  elements.repoBranch.textContent = `${git.branch}${sync ? ` · ${sync}` : ""}`;
  elements.repoRemote.textContent = git.remote;
  elements.repoRemote.title = git.remote;
  elements.repoDot.className = `status-dot ${git.hasOrigin && !git.behind ? "is-ready" : "is-warning"}`;
}

function renderPostList() {
  elements.postCount.textContent = String(state.posts.length);
  elements.postList.replaceChildren();
  if (!state.posts.length) {
    const empty = document.createElement("p");
    empty.className = "post-list-empty";
    empty.textContent = "还没有文章。点击“新建文章”写第一篇。";
    elements.postList.append(empty);
    return;
  }

  state.posts.forEach((post) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "post-list-button";
    button.dataset.slug = post.slug;
    if (state.current?.slug === post.slug && !state.current?.isNew) button.classList.add("is-active");

    const title = document.createElement("span");
    title.className = "post-list-title";
    title.textContent = post.title;
    const meta = document.createElement("span");
    meta.className = "post-list-meta";
    const date = document.createElement("span");
    date.textContent = post.date || "NO DATE";
    const time = document.createElement("span");
    time.textContent = `${post.readMinutes} MIN`;
    meta.append(date, time);
    button.append(title, meta);
    button.addEventListener("click", () => openArticle(post.slug));
    elements.postList.append(button);
  });
}

async function openArticle(slug, { skipConfirm = false } = {}) {
  if (!skipConfirm && !canLeaveCurrentArticle()) return;
  setBusy(true, "正在打开文章…");
  try {
    const result = await api(`/api/posts/${encodeURIComponent(slug)}`);
    hydrateArticle(result.article);
    setActionMessage("编辑只保存在本地，点击发布后才会推送到 GitHub。");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function startNewArticle({ skipConfirm = false } = {}) {
  if (!skipConfirm && !canLeaveCurrentArticle()) return;
  setBusy(true, "正在准备新文章…");
  try {
    const result = await api("/api/template");
    hydrateArticle(result.article);
    setActionMessage("这是一篇新草稿；保存后才会创建 HTML 文件。");
    elements.title.focus();
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

function canLeaveCurrentArticle() {
  return !state.dirty || window.confirm("当前修改还没有保存，确定离开吗？");
}

function hydrateArticle(article) {
  state.hydrating = true;
  state.current = structuredClone(article);
  elements.title.value = article.title;
  elements.headlineLines.value = article.headlineLines.join("\n");
  elements.slug.value = article.slug;
  elements.slug.disabled = !article.isNew;
  elements.kicker.value = article.kicker;
  elements.date.value = article.date;
  elements.readMinutes.value = article.readMinutes;
  elements.deck.value = article.deck;
  elements.description.value = article.description;
  elements.contentHtml.value = article.contentHtml;
  elements.workspaceTitle.textContent = article.title || "一篇还没有标题的新文章";
  elements.documentKind.textContent = article.isNew ? "ARTICLE / NEW DRAFT" : `ARTICLE / ${article.slug}`;
  updateOpenPageLink();
  updateHtmlCount();
  setDirty(false);
  renderPostList();
  refreshPreview();
  state.hydrating = false;
}

function onMetadataInput(event) {
  if (state.hydrating || !state.current) return;
  if (event.target === elements.slug) {
    elements.slug.value = elements.slug.value.toLowerCase().replace(/\s+/g, "-");
  }
  syncCurrentFromForm();
  elements.workspaceTitle.textContent = state.current.title || "一篇还没有标题的新文章";
  elements.documentKind.textContent = state.current.isNew
    ? "ARTICLE / NEW DRAFT"
    : `ARTICLE / ${state.current.slug}`;
  updateOpenPageLink();
  setDirty(true);
  schedulePreview();
}

function onHtmlInput() {
  if (!state.current) return;
  state.current.contentHtml = elements.contentHtml.value;
  updateHtmlCount();
  setDirty(true);
  schedulePreview(300);
}

function syncCurrentFromForm() {
  if (!state.current) return;
  state.current = {
    ...state.current,
    title: elements.title.value.trim(),
    headlineLines: elements.headlineLines.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
    slug: elements.slug.value.trim(),
    kicker: elements.kicker.value.trim(),
    date: elements.date.value,
    readMinutes: Number(elements.readMinutes.value),
    deck: elements.deck.value.trim(),
    description: elements.description.value.trim(),
  };
}

function syncContentFromFrame() {
  if (!state.current) return;
  const content = elements.previewFrame.contentDocument?.querySelector(".article-content");
  if (!content || state.mode !== "visual") return;
  state.current.contentHtml = content.innerHTML.trim();
  elements.contentHtml.value = state.current.contentHtml;
  updateHtmlCount();
}

function collectArticle() {
  syncContentFromFrame();
  syncCurrentFromForm();
  const article = structuredClone(state.current);
  if (!article.headlineLines.length && article.title) article.headlineLines = [article.title];
  validateClientArticle(article);
  return article;
}

function validateClientArticle(article) {
  if (!article) throw new Error("请先选择或新建一篇文章。");
  if (!article.title) throw new Error("请填写文章标题。");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(article.slug)) {
    throw new Error("Slug 只能使用小写字母、数字和连字符，例如 robot-field-notes。");
  }
  if (!article.kicker) throw new Error("请填写栏目标签。");
  if (!article.deck) throw new Error("请填写页头导语。");
  if (!article.date) throw new Error("请选择发布日期。");
  if (!Number.isInteger(article.readMinutes) || article.readMinutes < 1) {
    throw new Error("请填写有效的预计阅读分钟数。");
  }
  if (!article.contentHtml.trim()) throw new Error("正文不能为空。");
}

function schedulePreview(delay = 180) {
  window.clearTimeout(state.previewTimer);
  state.previewTimer = window.setTimeout(refreshPreview, delay);
}

function refreshPreview() {
  if (!state.current?.sourceHtml) return;
  const parser = new DOMParser();
  const documentCopy = parser.parseFromString(state.current.sourceHtml, "text/html");
  applyArticleToPreviewDocument(documentCopy, state.current);
  documentCopy.querySelectorAll("script, iframe, object, embed, base, meta[http-equiv]").forEach((node) => node.remove());
  documentCopy.querySelectorAll("*").forEach((node) => {
    [...node.attributes].filter((attribute) => /^on/i.test(attribute.name)).forEach((attribute) => node.removeAttribute(attribute.name));
  });
  const base = documentCopy.createElement("base");
  base.href = `${window.location.origin}/posts/`;
  base.dataset.blogStudio = "preview-base";
  documentCopy.head.prepend(base);
  elements.previewFrame.srcdoc = `<!doctype html>\n${documentCopy.documentElement.outerHTML}`;
}

function applyArticleToPreviewDocument(documentCopy, article) {
  setMeta(documentCopy, "meta[name='description']", "name", "description", article.description || article.deck);
  setMeta(documentCopy, "meta[property='og:title']", "property", "og:title", article.title);
  setMeta(documentCopy, "meta[property='og:description']", "property", "og:description", article.deck);
  setMeta(
    documentCopy,
    "meta[property='article:published_time']",
    "property",
    "article:published_time",
    article.date,
  );
  documentCopy.title = article.title || "未命名文章";

  const header = documentCopy.querySelector(".article-header");
  if (header) {
    const kicker = header.querySelector(".article-kicker");
    const headline = header.querySelector("h1");
    const deck = header.querySelector(".article-deck");
    const time = header.querySelector("time");
    const readTime = [...header.querySelectorAll(".article-meta span")].find((span) => /分钟/.test(span.textContent));
    if (kicker) kicker.textContent = article.kicker;
    if (headline) {
      headline.textContent = "";
      headline.setAttribute("aria-label", article.title);
      (article.headlineLines.length ? article.headlineLines : [article.title]).forEach((line) => {
        const span = documentCopy.createElement("span");
        span.textContent = line;
        headline.append(span);
      });
    }
    if (deck) deck.textContent = article.deck;
    if (time) {
      time.dateTime = article.date;
      time.textContent = article.date.replaceAll("-", ".");
    }
    if (readTime) readTime.textContent = `约 ${article.readMinutes} 分钟阅读`;
  }
  const content = documentCopy.querySelector(".article-content");
  if (content) content.innerHTML = article.contentHtml;
}

function setMeta(documentCopy, selector, attribute, key, content) {
  let meta = documentCopy.querySelector(selector);
  if (!meta) {
    meta = documentCopy.createElement("meta");
    meta.setAttribute(attribute, key);
    documentCopy.head.append(meta);
  }
  meta.setAttribute("content", content || "");
}

function configurePreviewFrame() {
  const frameDocument = elements.previewFrame.contentDocument;
  const content = frameDocument?.querySelector(".article-content");
  if (!frameDocument || !content) return;

  const editorStyle = frameDocument.createElement("style");
  editorStyle.dataset.blogStudio = "editor-style";
  editorStyle.textContent = `
    .article-content[contenteditable="true"] {
      outline: 1px dashed rgba(24, 24, 22, .28);
      outline-offset: 18px;
      min-height: 360px;
      caret-color: #577500;
    }
    .article-content[contenteditable="true"]:focus {
      outline-color: #83aa00;
      outline-style: solid;
    }
    .article-content[contenteditable="true"]::after {
      display: block;
      height: 80px;
      content: "";
    }
  `;
  frameDocument.head.append(editorStyle);
  content.contentEditable = state.mode === "visual" ? "true" : "false";
  content.spellcheck = true;
  content.addEventListener("input", () => {
    if (state.mode !== "visual" || !state.current) return;
    state.current.contentHtml = content.innerHTML.trim();
    elements.contentHtml.value = state.current.contentHtml;
    updateHtmlCount();
    setDirty(true);
  });
  content.addEventListener("paste", (event) => {
    if (state.mode !== "visual") return;
    const text = event.clipboardData?.getData("text/plain");
    if (!text) return;
    event.preventDefault();
    frameDocument.execCommand("insertText", false, text);
  });
}

function setEditorMode(mode) {
  if (!state.current || !["visual", "html"].includes(mode)) return;
  if (state.mode === "visual") syncContentFromFrame();
  state.mode = mode;
  elements.editorWorkbench.dataset.editorMode = mode;
  document.querySelectorAll("[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  elements.editHint.textContent =
    mode === "visual" ? "点击预览中的正文直接编辑" : "左侧写 HTML，右侧同步预览";
  refreshPreview();
  if (mode === "html") window.setTimeout(() => elements.contentHtml.focus(), 50);
}

function setViewport(viewport) {
  elements.previewStage.classList.toggle("is-mobile", viewport === "mobile");
  document.querySelectorAll("[data-viewport]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.viewport === viewport);
  });
}

function handleToolbarClick(event) {
  const button = event.target.closest("button");
  if (!button || !state.current) return;
  event.preventDefault();
  const { command, value, action } = button.dataset;
  if (action === "image") {
    elements.imageInput.click();
    return;
  }
  if (state.mode === "html") {
    handleHtmlToolbar(command, value, action);
    return;
  }
  handleVisualToolbar(command, value, action);
}

function handleVisualToolbar(command, value, action) {
  const frameDocument = elements.previewFrame.contentDocument;
  const content = frameDocument?.querySelector(".article-content");
  if (!frameDocument || !content) return;
  content.focus();

  if (command === "createLink") {
    const href = window.prompt("链接地址（https://…）");
    if (!href) return;
    frameDocument.execCommand("createLink", false, href);
  } else if (command) {
    frameDocument.execCommand(command, false, value || null);
  } else if (action === "lead") {
    const selection = frameDocument.getSelection();
    const anchor = selection?.anchorNode?.nodeType === Node.TEXT_NODE
      ? selection.anchorNode.parentElement
      : selection?.anchorNode;
    const paragraph = anchor?.closest?.("p");
    if (paragraph && content.contains(paragraph)) paragraph.classList.toggle("article-lead");
    else insertVisualHtml(frameDocument, '<p class="article-lead">开篇段落</p>');
  } else if (action === "callout") {
    insertVisualHtml(
      frameDocument,
      '<aside class="article-callout"><p class="article-callout-title">一句明确的判断</p><p>补充证据、边界或需要读者注意的地方。</p></aside><p><br></p>',
    );
  } else if (action === "code") {
    const selected = frameDocument.getSelection()?.toString() || "在这里粘贴代码或流程";
    insertVisualHtml(
      frameDocument,
      `<pre class="article-flow" role="region"><code>${escapeHtml(selected)}</code></pre><p><br></p>`,
    );
  }

  state.current.contentHtml = content.innerHTML.trim();
  elements.contentHtml.value = state.current.contentHtml;
  updateHtmlCount();
  setDirty(true);
}

function insertVisualHtml(frameDocument, html) {
  frameDocument.execCommand("insertHTML", false, html);
}

function handleHtmlToolbar(command, value, action) {
  const textarea = elements.contentHtml;
  const selected = textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
  let replacement = "";
  if (command === "formatBlock") {
    replacement = `<${value}>${selected || (value === "p" ? "正文段落" : "小标题")}</${value}>`;
  } else if (command === "bold") {
    replacement = `<strong>${selected || "重点文字"}</strong>`;
  } else if (command === "italic") {
    replacement = `<em>${selected || "强调文字"}</em>`;
  } else if (command === "createLink") {
    const href = window.prompt("链接地址（https://…）");
    if (!href) return;
    replacement = `<a href="${escapeAttribute(href)}">${selected || "链接文字"}</a>`;
  } else if (command === "insertUnorderedList") {
    replacement = `<ul>\n  <li>${selected || "列表项"}</li>\n</ul>`;
  } else if (command === "insertOrderedList") {
    replacement = `<ol>\n  <li>${selected || "列表项"}</li>\n</ol>`;
  } else if (action === "lead") {
    replacement = `<p class="article-lead">${selected || "开篇段落"}</p>`;
  } else if (action === "callout") {
    replacement =
      '<aside class="article-callout">\n  <p class="article-callout-title">一句明确的判断</p>\n  <p>补充证据、边界或需要读者注意的地方。</p>\n</aside>';
  } else if (action === "code") {
    replacement = `<pre class="article-flow" role="region"><code>${escapeHtml(selected || "在这里粘贴代码或流程")}</code></pre>`;
  }
  if (!replacement) return;
  textarea.setRangeText(replacement, textarea.selectionStart, textarea.selectionEnd, "end");
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.focus();
}

async function uploadImage() {
  const file = elements.imageInput.files?.[0];
  elements.imageInput.value = "";
  if (!file || !state.current) return;
  syncCurrentFromForm();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(state.current.slug)) {
    showError(new Error("请先填写有效的 Slug，再上传图片。"));
    return;
  }
  setBusy(true, "正在保存图片…");
  try {
    const dataUrl = await readAsDataUrl(file);
    const result = await api("/api/assets", {
      method: "POST",
      body: JSON.stringify({ slug: state.current.slug, fileName: file.name, dataUrl }),
    });
    const alt = window.prompt("图片说明（用于无障碍访问）", "") ?? "";
    const figure =
      `<figure class="article-figure">` +
      `<img src="${escapeAttribute(result.asset.src)}" alt="${escapeAttribute(alt)}" loading="lazy" />` +
      (alt ? `<figcaption>${escapeHtml(alt)}</figcaption>` : "") +
      `</figure><p><br></p>`;
    if (state.mode === "visual") {
      const frameDocument = elements.previewFrame.contentDocument;
      const content = frameDocument?.querySelector(".article-content");
      content?.focus();
      if (frameDocument && content) {
        insertVisualHtml(frameDocument, figure);
        state.current.contentHtml = content.innerHTML.trim();
        elements.contentHtml.value = state.current.contentHtml;
      }
    } else {
      const textarea = elements.contentHtml;
      textarea.setRangeText(figure, textarea.selectionStart, textarea.selectionEnd, "end");
      state.current.contentHtml = textarea.value;
      schedulePreview();
    }
    updateHtmlCount();
    setDirty(true);
    showToast(result.message);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
  }
}

async function saveDraft() {
  if (state.busy) return null;
  let article;
  try {
    article = collectArticle();
  } catch (error) {
    showError(error);
    return null;
  }

  setBusy(true, "正在保存到本地…");
  try {
    const result = await api("/api/save", {
      method: "POST",
      body: JSON.stringify({ article }),
    });
    hydrateArticle(result.article);
    await Promise.all([loadPosts(), loadGitStatus({ quiet: true })]);
    renderPostList();
    showToast(result.message);
    setActionMessage("已保存到本地；下次发布站点会包含这篇文章。");
    return result.article;
  } catch (error) {
    showError(error);
    return null;
  } finally {
    setBusy(false);
  }
}

async function openPublishDialog() {
  if (state.busy) return;
  let article;
  try {
    article = collectArticle();
  } catch (error) {
    showError(error);
    return;
  }
  await loadGitStatus({ quiet: true });
  elements.publishArticleName.textContent = "站点配置、首页、全部已保存文章及图片";
  elements.publishTarget.textContent = state.git
    ? `${state.git.branch} → ${state.git.remote}`
    : "当前分支 → origin";
  elements.commitMessage.value = `publish: ${article.title}`.slice(0, 160);
  const warnings = [];
  if (state.git?.behind) warnings.push(`当前分支落后远程 ${state.git.behind} 个提交，需要先拉取。`);
  if (state.git?.ahead) warnings.push(`当前分支还有 ${state.git.ahead} 个本地提交；Git 推送会一并发布它们。`);
  if (state.git?.dirtyCount) {
    warnings.push(`仓库另有 ${state.git.dirtyCount} 项未提交变化；Studio 会提交全部已保存的站点内容，其他未提交代码不包含在内。`);
  }
  elements.publishWarning.textContent = warnings.join(" ");
  elements.publishWarning.hidden = !warnings.length;
  elements.publishDialog.showModal();
}

async function publishArticle() {
  if (state.busy) return;
  let article;
  try {
    article = collectArticle();
  } catch (error) {
    showError(error);
    return;
  }
  const commitMessage = elements.commitMessage.value.trim();
  setBusy(true, "正在提交并推送到 GitHub…");
  elements.confirmPublish.disabled = true;
  try {
    const result = await api("/api/publish", {
      method: "POST",
      body: JSON.stringify({ article, commitMessage }),
    });
    elements.publishDialog.close();
    if (result.article) hydrateArticle(result.article);
    await Promise.all([loadPosts(), loadGitStatus({ quiet: true })]);
    renderPostList();
    showToast(result.message);
    setActionMessage(
      result.publish.pushed
        ? `发布成功：提交 ${result.publish.commit} 已推送到 GitHub。`
        : result.publish.message,
    );
  } catch (error) {
    if (error.context?.savedArticle) hydrateArticle(error.context.savedArticle);
    if (error.context?.committed) {
      setActionMessage(`已生成本地提交 ${error.context.commit}，但推送失败。请查看错误后重试。`, true);
    }
    showError(error);
  } finally {
    elements.confirmPublish.disabled = false;
    setBusy(false);
  }
}

function updateOpenPageLink() {
  const slug = state.current?.slug;
  elements.openPage.href = slug ? `/posts/${encodeURIComponent(slug)}.html` : "/index.html#blog";
  elements.openPage.textContent = state.current?.isNew ? "打开首页" : "打开页面";
}

function updateHtmlCount() {
  elements.htmlCount.textContent = `${elements.contentHtml.value.length.toLocaleString()} chars`;
}

function setDirty(dirty) {
  state.dirty = dirty;
  elements.documentState.classList.toggle("is-dirty", dirty);
  elements.documentState.classList.toggle("is-saved", !dirty);
  const label = elements.documentState.querySelector("span:last-child");
  label.textContent = dirty ? "有未保存修改" : state.current?.isNew ? "新文章 · 尚未保存" : "已保存到本地";
}

function setBusy(busy, message = "") {
  state.busy = busy;
  [elements.newPost, elements.saveDraft, elements.publish, elements.refreshStatus].forEach((button) => {
    button.disabled = busy;
  });
  if (message) setActionMessage(message);
}

function setActionMessage(message, isError = false) {
  elements.actionMessage.textContent = message;
  elements.actionMessage.classList.toggle("is-error", isError);
}

function showToast(message, { error = false } = {}) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  elements.toast.classList.toggle("is-error", error);
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, error ? 7000 : 4200);
}

function showError(error) {
  const message = [error?.message || "发生错误。", error?.details].filter(Boolean).join("\n");
  showToast(message, { error: true });
  setActionMessage(error?.message || "发生错误。", true);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error(`服务器返回了无法识别的响应（HTTP ${response.status}）。`);
  }
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `请求失败（HTTP ${response.status}）。`);
    Object.assign(error, data);
    throw error;
  }
  return data;
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", () => reject(new Error("无法读取图片文件。")));
    reader.readAsDataURL(file);
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}
