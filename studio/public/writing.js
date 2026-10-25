const $ = (selector) => document.querySelector(selector);
const fields = [
  "title",
  "description",
  "slug",
  "date",
  "category",
  "tags",
  "featured",
  "manuscript",
];
const state = {
  article: null,
  workspace: null,
  posts: [],
  filter: "all",
  dirty: false,
  version: 0,
  saving: null,
  autosave: 0,
  previewTimer: 0,
  previewId: 0,
  presentation: "editorial",
  busy: false,
  conflict: false,
};

async function api(url, body) {
  const response = await fetch(
    url,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const data = await response.json();
  if (!response.ok || !data.ok) {
    const error = new Error(data.error || `请求失败（${response.status}）`);
    Object.assign(error, {
      code: data.code,
      context: data.context,
      details: data.details,
    });
    throw error;
  }
  return data;
}
function message(text, error = false) {
  $("#message-bar").textContent = text;
  $("#message-bar").classList.toggle("is-error", error);
}
let toastTimer;
function toast(text, error = false) {
  clearTimeout(toastTimer);
  $("#toast").hidden = false;
  $("#toast").textContent = text;
  $("#toast").classList.toggle("is-error", error);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 6000);
}
function showError(error) {
  message(error.message, true);
  toast(error.message, true);
}
function setBusy(value) {
  state.busy = value;
  document
    .querySelectorAll("button, input, textarea, select")
    .forEach((element) => {
      element.disabled = value;
    });
  $("#slug").readOnly = Boolean(
    state.article?.revision || state.article?.baseHash,
  );
}
function collect() {
  return {
    ...state.article,
    title: $("#title").value,
    description: $("#description").value,
    slug: $("#slug").value.trim(),
    date: $("#date").value || state.article.date,
    category: $("#category").value,
    tags: $("#tags")
      .value.split(/[,，]/)
      .map((value) => value.trim())
      .filter(Boolean),
    featured: $("#featured").checked,
    markdown: $("#manuscript").value,
  };
}
function hydrate(article) {
  clearTimeout(state.autosave);
  state.article = article;
  state.dirty = false;
  state.conflict = false;
  state.version++;
  document.body.classList.remove("library-open");
  $("#toggle-library").setAttribute("aria-expanded", "false");
  for (const name of ["title", "description", "slug", "date", "category"])
    $(`#${name}`).value = article[name] || "";
  $("#tags").value = (article.tags || []).join(", ");
  $("#featured").checked = article.featured;
  $("#manuscript").value = article.markdown || "";
  $("#slug").readOnly = Boolean(article.revision || article.baseHash);
  $("#document-label").textContent = article.title || "一张新的白纸";
  $("#save-state").textContent =
    article.state === "published"
      ? "已发布 · 编辑后存为草稿"
      : article.revision
        ? savedLabel(article.savedAt)
        : "本地草稿";
  $("#save-state").classList.remove("is-error");
  renderLibrary();
  updateCounts();
  requestPreview();
  history.replaceState(
    null,
    "",
    article.state === "new" ? location.pathname : `#${article.slug}`,
  );
}
function savedLabel(timestamp) {
  return timestamp
    ? `已保存 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(timestamp))}`
    : "已保存到本机";
}
async function refreshLibrary() {
  state.posts = (await api("/api/posts")).posts;
  renderLibrary();
}
function renderLibrary() {
  $("#all-count").textContent = state.posts.length;
  $("#draft-count").textContent = state.posts.filter(
    (post) => post.state === "draft",
  ).length;
  const search = $("#search").value.trim().toLowerCase();
  const visible = state.posts.filter(
    (post) =>
      (state.filter === "all" || post.state === state.filter) &&
      `${post.title} ${post.category} ${(post.tags || []).join(" ")}`
        .toLowerCase()
        .includes(search),
  );
  const list = $("#notes");
  list.replaceChildren();
  if (!visible.length) {
    const empty = document.createElement("p");
    empty.className = "empty-library";
    empty.textContent =
      state.filter === "draft"
        ? "这里会收好尚未发布的文字。"
        : search
          ? "没有找到这篇文章。"
          : "写下第一篇，慢慢来。";
    list.append(empty);
  }
  for (const post of visible) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "note-item";
    button.classList.toggle("is-active", post.slug === state.article?.slug);
    if (post.slug === state.article?.slug)
      button.setAttribute("aria-current", "page");
    const meta = document.createElement("span");
    meta.className = "note-meta";
    meta.textContent = `${post.date} · ${post.state === "draft" ? "草稿" : post.category}`;
    const title = document.createElement("span");
    title.className = "note-title";
    title.textContent = post.title || "无标题文章";
    button.append(meta, title);
    button.addEventListener("click", () => openArticle(post.slug));
    list.append(button);
  }
}
async function beforeSwitch() {
  clearTimeout(state.autosave);
  if (state.saving) await state.saving;
  if (state.dirty) await saveDraft(true);
  return !state.dirty || confirm("最新修改尚未保存。确定离开当前文章吗？");
}
async function openArticle(slug) {
  if (state.busy || !(await beforeSwitch())) return;
  try {
    hydrate((await api(`/api/posts/${encodeURIComponent(slug)}`)).article);
    message("改动会自动保存为本地草稿。点击发布，才会更新线上文章。");
  } catch (error) {
    showError(error);
  }
}
async function newArticle() {
  if (state.busy || !(await beforeSwitch())) return;
  try {
    hydrate((await api("/api/template")).article);
    message("从一张白纸开始。你写下的文字会自动保存到本机。");
    $("#title").focus();
  } catch (error) {
    showError(error);
  }
}
function changed() {
  if (!state.article) return;
  state.dirty = true;
  state.version++;
  $("#document-label").textContent = $("#title").value || "一张新的白纸";
  $("#save-state").textContent = state.conflict
    ? "保存冲突 · 请重新打开"
    : "尚未保存";
  updateCounts();
  requestPreview();
  clearTimeout(state.autosave);
  if (!state.conflict) state.autosave = setTimeout(() => saveDraft(true), 1200);
}
async function saveDraft(quiet = false) {
  if (state.saving) return state.saving;
  if (!state.article || !state.dirty) return true;
  clearTimeout(state.autosave);
  const version = state.version;
  const article = collect();
  state.saving = (async () => {
    $("#save-state").textContent = "保存中…";
    try {
      const result = await api("/api/save", { article });
      state.article = { ...state.article, ...result.article };
      $("#slug").readOnly = true;
      state.dirty = version !== state.version;
      $("#save-state").textContent = state.dirty
        ? "尚未保存"
        : savedLabel(result.article.savedAt);
      $("#save-state").classList.remove("is-error");
      history.replaceState(null, "", `#${result.article.slug}`);
      await refreshLibrary().catch(() => {});
      if (!quiet) {
        toast("已保存到本机，尚未发布。");
        message("草稿已保存。其他未完成的文章不会随当前文章一起发布。");
      }
      return true;
    } catch (error) {
      state.conflict = error.code === "DRAFT_CONFLICT";
      $("#save-state").textContent = state.conflict
        ? "保存冲突"
        : "保存失败 · 请重试";
      $("#save-state").classList.add("is-error");
      showError(error);
      return false;
    } finally {
      state.saving = null;
      if (state.dirty && !state.conflict && version !== state.version)
        state.autosave = setTimeout(() => saveDraft(true), 1200);
    }
  })();
  return state.saving;
}
function updateCounts() {
  const body = $("#manuscript").value;
  const cjk = (body.match(/[\u3400-\u9fff]/g) || []).length;
  const words = (
    body.replace(/[\u3400-\u9fff]/g, "").match(/[\p{L}\p{N}]+/gu) || []
  ).length;
  $("#word-count").textContent = `${(cjk + words).toLocaleString()} 字 / 词`;
  $("#reading-time").textContent =
    `约 ${Math.max(1, Math.ceil(cjk / 400 + words / 220))} 分钟`;
}
function requestPreview() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(async () => {
    const id = ++state.previewId;
    try {
      const { html } = await api("/api/preview", {
        article: collect(),
        presentation: state.presentation,
      });
      if (id === state.previewId) {
        const frame = $("#reading-preview");
        let scroll = 0;
        try {
          scroll = frame.contentWindow.scrollY;
        } catch {}
        frame.onload = () => {
          try {
            frame.contentWindow.scrollTo(0, scroll);
          } catch {}
        };
        frame.srcdoc = html;
      }
    } catch {
      /* Transient invalid metadata does not interrupt writing. Saving reports errors. */
    }
  }, 280);
}
function replaceSelection(before, after = "", placeholder = "") {
  const input = $("#manuscript");
  input.focus();
  const start = input.selectionStart,
    end = input.selectionEnd;
  const selected = input.value.slice(start, end) || placeholder;
  input.setRangeText(before + selected + after, start, end, "end");
  input.setSelectionRange(
    start + before.length,
    start + before.length + selected.length,
  );
  changed();
}
function format(kind) {
  if (state.busy) return;
  if (kind === "image") {
    $("#image-file").click();
    return;
  }
  const pairs = {
    h2: ["\n## ", "\n", ""],
    bold: ["**", "**", ""],
    italic: ["*", "*", ""],
    quote: ["\n> ", "\n", ""],
    list: ["\n- ", "\n", ""],
    link: ["[", "](https://)", "链接文字"],
    code: ["\n```text\n", "\n```\n", ""],
    table: ["\n| 标题 | 标题 |\n| --- | --- |\n| ", " |  |\n", ""],
  };
  if (pairs[kind]) replaceSelection(...pairs[kind]);
}
async function uploadImage(file) {
  if (!file || state.busy || !state.article) return;
  if (file.size > 8_000_000) {
    toast("请选择小于 8 MB 的图片。", true);
    return;
  }
  setBusy(true);
  try {
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
    const { asset } = await api("/api/assets", {
      slug: $("#slug").value,
      fileName: file.name,
      dataUrl,
    });
    setBusy(false);
    replaceSelection(
      `\n![${file.name.replace(/[\[\]]/g, "")}](${asset.src})\n`,
    );
    toast("图片已保存到本机，将随当前文章一起发布。");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    $("#image-file").value = "";
  }
}
async function openPublish() {
  if (state.busy) return;
  if (!$("#title").value.trim() || !$("#manuscript").value.trim()) {
    toast("先写好标题和正文，再分享给读者。", true);
    return;
  }
  if (state.saving) await state.saving;
  if (!(await saveDraft(true)) || state.dirty) return;
  try {
    const { status } = await api("/api/status");
    $("#publish-title").textContent = collect().title;
    $("#publish-target").textContent = `${status.remote} · ${status.branch}`;
    $("#commit-message").value = `publish: ${collect().title}`.slice(0, 160);
    const warnings = [];
    if (status.ahead)
      warnings.push(
        `当前分支还有 ${status.ahead} 个待推送提交，本次 Git 推送会一并包含。`,
      );
    if (status.behind) warnings.push("当前分支落后远程，需要先同步仓库。");
    if (state.article.baseHash)
      warnings.push(
        "正文改动会同步到两版。Markdown 中未保留的简约版专用交互，不会自动重建。",
      );
    $("#publish-warning").textContent = warnings.join(" ");
    $("#publish-warning").hidden = !warnings.length;
    $("#confirm-publish").disabled = Boolean(
      status.behind || !status.hasOrigin,
    );
    if (state.saving) await state.saving;
    if (state.dirty && !(await saveDraft(true))) return;
    $("#publish-dialog").showModal();
  } catch (error) {
    showError(error);
  }
}
async function publishArticle() {
  if (state.busy) return;
  if (state.saving) await state.saving;
  if (!(await saveDraft(true)) || state.dirty) return;
  clearTimeout(state.autosave);
  setBusy(true);
  $("#confirm-publish").textContent = "正在推送，请稍候…";
  message("正在同步两版文章并推送到 GitHub…");
  try {
    const result = await api("/api/publish", {
      article: collect(),
      commitMessage: $("#commit-message").value,
    });
    $("#publish-dialog").close();
    hydrate(result.article);
    await refreshLibrary();
    message(
      result.publish.pushed
        ? `已推送 ${result.publish.commit}，GitHub Pages 正在部署两版博客。`
        : "文章与线上源文件一致，没有新的内容需要发布。",
    );
    toast(
      result.publish.pushed
        ? "已推送，等待 GitHub Pages 部署。"
        : "文章没有新的变化。",
    );
  } catch (error) {
    if (error.context?.savedArticle) {
      state.article = { ...state.article, ...error.context.savedArticle };
      state.dirty = false;
      $("#save-state").textContent = "草稿保留 · 可重试发布";
    }
    $("#publish-dialog").close();
    showError(error);
  } finally {
    setBusy(false);
    $("#confirm-publish").textContent = "确认发布并推送 ↗";
  }
}

for (const name of fields) $(`#${name}`).addEventListener("input", changed);
$("#new-note").addEventListener("click", newArticle);
$("#save").addEventListener("click", () => saveDraft());
$("#publish").addEventListener("click", openPublish);
$("#confirm-publish").addEventListener("click", publishArticle);
$("#search").addEventListener("input", renderLibrary);
$("#refresh-library").addEventListener("click", () =>
  refreshLibrary().catch(showError),
);
$("#settings").addEventListener("click", () => {
  const panel = $("#article-settings");
  panel.hidden = !panel.hidden;
  $("#settings").setAttribute("aria-expanded", String(!panel.hidden));
});
$("#focus-mode").addEventListener("click", () => {
  const active = document.body.classList.toggle("is-focused");
  $("#focus-mode").textContent = active ? "退出专注" : "专注";
  $("#focus-mode").setAttribute("aria-pressed", String(active));
});
$("#toggle-library").addEventListener("click", () => {
  const active = document.body.classList.toggle("library-open");
  $("#toggle-library").setAttribute("aria-expanded", String(active));
});
document.querySelectorAll("[data-filter]").forEach((button) =>
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document
      .querySelectorAll("[data-filter]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
    renderLibrary();
  }),
);
document.querySelectorAll("[data-view]").forEach((button) =>
  button.addEventListener("click", () => {
    $(".editor-grid").dataset.view = button.dataset.view;
    document
      .querySelectorAll("[data-view]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
  }),
);
document.querySelectorAll("[data-presentation]").forEach((button) =>
  button.addEventListener("click", () => {
    state.presentation = button.dataset.presentation;
    document
      .querySelectorAll("[data-presentation]")
      .forEach((item) =>
        item.setAttribute("aria-pressed", String(item === button)),
      );
    requestPreview();
  }),
);
document
  .querySelectorAll("[data-format]")
  .forEach((button) =>
    button.addEventListener("click", () => format(button.dataset.format)),
  );
$("#image-file").addEventListener("change", (event) =>
  uploadImage(event.target.files[0]),
);
$("#manuscript").addEventListener("dragover", (event) =>
  event.preventDefault(),
);
$("#manuscript").addEventListener("drop", (event) => {
  if (event.dataTransfer.files.length) {
    event.preventDefault();
    uploadImage(event.dataTransfer.files[0]);
  }
});
$("#manuscript").addEventListener("paste", (event) => {
  const image = [...event.clipboardData.files].find((file) =>
    file.type.startsWith("image/"),
  );
  if (image) {
    event.preventDefault();
    uploadImage(image);
  }
});
document.addEventListener("keydown", (event) => {
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && event.key.toLowerCase() === "s") {
    event.preventDefault();
    saveDraft();
  }
  if (
    modifier &&
    document.activeElement === $("#manuscript") &&
    ["b", "i", "k"].includes(event.key.toLowerCase())
  ) {
    event.preventDefault();
    format({ b: "bold", i: "italic", k: "link" }[event.key.toLowerCase()]);
  }
  if (event.key === "Escape" && document.body.classList.contains("is-focused"))
    $("#focus-mode").click();
  if (
    !modifier &&
    event.key === "n" &&
    !event.target.closest("input,textarea,select,[contenteditable]")
  ) {
    event.preventDefault();
    newArticle();
  }
});
window.addEventListener("beforeunload", (event) => {
  if (state.dirty || state.saving) {
    event.preventDefault();
    event.returnValue = "";
  }
});
try {
  state.workspace = (await api("/api/workspace")).workspace;
  $("#site-label").textContent = state.workspace.label;
  $("#site-label").title = state.workspace.siteRoot;
  $("#visit-site").href = state.workspace.siteUrl;
  await refreshLibrary();
  const slug = location.hash.slice(1);
  if (
    /^[a-z0-9-]+$/.test(slug) &&
    state.posts.some((post) => post.slug === slug)
  )
    hydrate((await api(`/api/posts/${slug}`)).article);
  else hydrate((await api("/api/template")).article);
} catch (error) {
  showError(error);
}
