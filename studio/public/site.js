const form = document.querySelector("#site-form");
const projects = document.querySelector("#projects-editor");
const socials = document.querySelector("#social-editor");
const message = document.querySelector("#settings-message");
const status = document.querySelector("#settings-state");
const preview = document.querySelector("#home-preview");
const dialog = document.querySelector("#site-publish-dialog");
let dirty = false, busy = false, previewTimer, previewVersion = 0;

function field(labelText, value, className, maxLength = 2000) {
  const label = document.createElement("label");
  label.className = "field";
  const span = document.createElement("span"); span.textContent = labelText;
  const input = document.createElement("input");
  input.className = className; input.value = value; input.maxLength = maxLength; input.required = true;
  label.append(span, input); return label;
}
function button(text, action) {
  const node = document.createElement("button");
  node.type = "button"; node.className = "text-button"; node.textContent = text;
  node.addEventListener("click", action); return node;
}
function linkRow(container, link = { label: "", url: "" }) {
  const row = document.createElement("div"); row.className = "settings-link-row";
  row.append(field("链接文字", link.label, "link-label", 50), field("链接地址", link.url, "link-url"), button("移除链接", () => { row.remove(); changed(); }));
  container.append(row);
}
function projectRow(project = { name: "", description: "", links: [{ label: "GitHub", url: "" }] }) {
  const row = document.createElement("fieldset"); row.className = "settings-project";
  const legend = document.createElement("legend"); legend.textContent = "项目";
  const description = field("项目简介", project.description, "project-description", 200);
  description.querySelector("input").required = false;
  const links = document.createElement("div"); links.className = "project-links-editor";
  project.links.forEach((link) => linkRow(links, link));
  row.append(legend, field("项目名称", project.name, "project-name", 120), description, links,
    button("＋ 添加项目链接", () => { linkRow(links); changed(); }),
    button("移除项目", () => { row.remove(); changed(); }));
  projects.append(row);
}
function collectLinks(container) {
  return [...container.querySelectorAll(".settings-link-row")].map((row) => ({ label: row.querySelector(".link-label").value, url: row.querySelector(".link-url").value }));
}
function collect() {
  return { ...Object.fromEntries(new FormData(form)),
    projects: [...projects.children].map((row) => ({ name: row.querySelector(".project-name").value,
      description: row.querySelector(".project-description").value, links: collectLinks(row) })),
    links: collectLinks(socials) };
}
function changed() {
  dirty = true; status.textContent = "有未保存修改";
  clearTimeout(previewTimer); previewTimer = setTimeout(updatePreview, 350);
}
async function api(url, payload) {
  const response = await fetch(url, payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {});
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error([result.error, result.details].filter(Boolean).join("\n"));
  return result;
}
async function updatePreview() {
  const version = ++previewVersion;
  try {
    const result = await api("/api/site/preview", { site: collect() });
    if (version !== previewVersion) return;
    const doc = new DOMParser().parseFromString(result.html, "text/html");
    doc.querySelectorAll("script").forEach((node) => node.remove());
    const base = doc.createElement("base"); base.href = `${location.origin}/`; doc.head.prepend(base);
    preview.srcdoc = `<!doctype html>${doc.documentElement.outerHTML}`;
    document.querySelector("#preview-state").textContent = "已更新";
  } catch (error) {
    if (version !== previewVersion) return;
    document.querySelector("#preview-state").textContent = "请填完整后预览";
  }
}
function setBusy(value) {
  busy = value;
  form.inert = value;
  document.querySelectorAll("#save-site, #publish-site, #site-confirm-publish").forEach((node) => node.disabled = value);
}
function showError(error) { message.textContent = error.message; message.classList.add("is-error"); }
async function save() {
  const result = await api("/api/site", { site: collect() });
  dirty = false; status.textContent = "已保存到本地";
  message.textContent = result.message; message.classList.remove("is-error");
  return result;
}
form.addEventListener("input", changed);
form.addEventListener("submit", async (event) => {
  event.preventDefault(); if (busy) return; setBusy(true);
  try { await save(); } catch (error) { showError(error); } finally { setBusy(false); }
});
document.querySelector("#add-project").addEventListener("click", () => { projectRow(); changed(); });
document.querySelector("#add-social").addEventListener("click", () => { linkRow(socials); changed(); });
document.querySelector("#publish-site").addEventListener("click", async () => {
  if (busy || !form.reportValidity()) return;
  try {
    const { status: git } = await api("/api/status");
    document.querySelector("#site-publish-target").textContent = `${git.branch} → ${git.remote}`;
    document.querySelector("#site-publish-warning").textContent = `${git.ahead} 个待推送提交；${git.dirtyCount} 项未提交变化。发布范围包含所有已保存的站点内容。`;
    dialog.showModal();
  } catch (error) { showError(error); }
});
document.querySelector("#site-confirm-publish").addEventListener("click", async () => {
  if (busy) return; setBusy(true);
  try {
    await save();
    const result = await api("/api/publish", { commitMessage: document.querySelector("#site-commit-message").value });
    message.textContent = result.message; dialog.close();
  } catch (error) { dialog.close(); showError(error); } finally { setBusy(false); }
});
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); if (!busy) form.requestSubmit(); }
});
setBusy(true);
try {
  const { site } = await api("/api/site");
  for (const [key, value] of Object.entries(site)) { const input = form.elements.namedItem(key); if (input) input.value = value; }
  site.projects.forEach(projectRow); site.links.forEach((link) => linkRow(socials, link));
  status.textContent = "已读取本地配置"; await updatePreview();
} catch (error) { showError(error); status.textContent = "读取失败，请刷新重试"; }
finally { setBusy(false); }
