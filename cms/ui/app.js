export {};
const $ = id => document.getElementById(id);
let csrf = "",
  posts = [],
  filter = "all",
  current = null,
  dirty = false,
  previewing = false,
  publishing = false;
let editVersion = 0;
const statusNames = { published: "已发布", draft: "草稿", modified: "有修改" };
const dateFormat = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
function theme() {
  document.documentElement.dataset.theme =
    localStorage.getItem("theme") ||
    (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}
theme();
$("theme").onclick = () => {
  localStorage.setItem(
    "theme",
    document.documentElement.dataset.theme === "dark" ? "light" : "dark"
  );
  theme();
};
function message(text, error = false) {
  $("message").textContent = text;
  $("message").classList.toggle("error", error);
  $("message").hidden = !text;
}
function show(view) {
  for (const id of ["login", "list", "editor", "security"])
    $(id).hidden = id !== view;
  $("logout").hidden = view === "login";
  $("security-link").hidden = view === "login";
  if (view !== "security") clearSetup();
}
function clearSetup() {
  $("totp-secret").value = "";
  $("totp-qr").removeAttribute("src");
  $("setup-code").value = "";
  $("security-password").value = "";
  $("disable-code").value = "";
  $("totp-setup").hidden = true;
}
async function api(route, options = {}) {
  const headers = { ...options.headers };
  if (options.body && !(options.body instanceof Blob)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }
  if (options.method && options.method !== "GET")
    headers["X-CSRF-Token"] = csrf;
  const res = await fetch("/admin/api/" + route, { ...options, headers });
  const data = await res.json();
  if (!res.ok) {
    if (res.status === 401 && route !== "login") show("login");
    throw new Error(data.error || "操作失败");
  }
  return data;
}
async function action(button, fn) {
  button.disabled = true;
  message("");
  try {
    await fn();
  } catch (e) {
    message(e.message, true);
  } finally {
    button.disabled = publishing;
  }
}
function renderList() {
  const query = $("search").value.toLowerCase();
  const rows = posts.filter(
    p =>
      (filter === "all" ||
        (filter === "published"
          ? p.status !== "draft"
          : p.status === "draft")) &&
      p.title.toLowerCase().includes(query)
  );
  $("posts").replaceChildren();
  $("count").textContent = `${rows.length} 篇文章`;
  $("empty").hidden = rows.length > 0;
  for (const post of rows) {
    const row = document.createElement("a");
    row.className = "post-row";
    row.href = "#edit";
    const main = document.createElement("div");
    main.className = "post-main";
    const title = document.createElement("div");
    title.className = "post-title";
    title.textContent = post.title;
    const meta = document.createElement("div");
    meta.className = "post-meta";
    const status = document.createElement("span");
    status.className = "post-status";
    status.textContent = statusNames[post.status];
    const date = document.createElement("span");
    date.textContent = dateFormat.format(new Date(post.updatedAt));
    const arrow = document.createElement("span");
    arrow.className = "row-arrow";
    arrow.textContent = "↗";
    arrow.setAttribute("aria-hidden", "true");
    meta.append(status, date);
    main.append(title, meta);
    row.append(main, arrow);
    row.onclick = async e => {
      e.preventDefault();
      try {
        openEditor(await api("post?id=" + encodeURIComponent(post.id)));
      } catch (error) {
        message(error.message, true);
      }
    };
    $("posts").append(row);
  }
}
async function loadList() {
  posts = await api("posts");
  show("list");
  renderList();
}
function localDate(iso) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function openEditor(post) {
  const isPage = post.kind === "page";
  const isHome = post.id === "home:page";
  $("home-socials").hidden = !isHome;
  for (const name of ["github", "x", "linkedin", "mail"])
    $("social-" + name).value =
      (post.socials ?? []).find(s => s.name === name)?.url ?? "";
  for (const id of ["tags", "author", "slug", "date", "featured"]) {
    const field = $(id);
    (id === "featured" ? field.closest("label") : field.parentElement).hidden =
      isPage;
  }
  $("description").previousElementSibling.querySelector("span").textContent =
    isPage ? "选填" : "必填";
  $("settings").querySelector("summary").firstChild.textContent = isPage
    ? "页面设置 "
    : "文章设置 ";
  $("settings").querySelector("summary span").textContent = isHome
    ? "社交链接与摘要"
    : isPage
      ? "页面摘要"
      : "摘要、标签、地址与时间";
  $("visit").href = isHome ? "/" : isPage ? "/about/" : "/posts/";
  if (!publishing) $("job-panel").hidden = true;
  current = post;
  dirty = false;
  previewing = false;
  for (const key of ["title", "body", "description", "author"])
    $(key).value = post[key] || "";
  $("tags").value = (post.tags || []).join(", ");
  $("date").value = localDate(post.pubDatetime);
  $("slug").value = post.id;
  $("slug").disabled = !!post.revision;
  $("delete-post").hidden = isPage || !post.revision;
  $("featured").checked = !!post.featured;
  $("mdx-note").hidden = post.format !== "mdx";
  $("settings").open = false;
  $("body").hidden = false;
  $("preview").hidden = true;
  $("preview-toggle").textContent = "预览";
  $("preview-toggle").setAttribute("aria-pressed", "false");
  $("save-state").textContent = post.revision
    ? statusNames[post.status]
    : "尚未保存";
  $("word-count").textContent = `${post.body.length} 字`;
  show("editor");
  message("");
  window.scrollTo(0, 0);
  $("title").focus();
}
function readEditor() {
  return {
    ...current,
    ...(current.id === "home:page"
      ? {
          socials: ["github", "x", "linkedin", "mail"].flatMap(name => {
            let url = $("social-" + name).value.trim();
            if (!url) return [];
            if (name === "mail" && !url.startsWith("mailto:"))
              url = "mailto:" + url;
            return [{ name, url }];
          }),
        }
      : {}),
    id: $("slug").value.trim(),
    title: $("title").value.trim(),
    description: $("description").value.trim(),
    body: $("body").value,
    author: $("author").value.trim(),
    tags: $("tags")
      .value.split(/[,，]/)
      .map(s => s.trim())
      .filter(Boolean),
    pubDatetime: $("date").value
      ? new Date($("date").value).toISOString()
      : new Date().toISOString(),
    featured: $("featured").checked,
  };
}
async function save() {
  if (current.kind !== "page" && !$("description").value.trim()) {
    $("settings").open = true;
    $("description").focus();
    throw new Error("请填写文章摘要");
  }
  if (!$("title").value.trim()) {
    $("title").focus();
    throw new Error("请填写文章标题");
  }
  const submittedVersion = editVersion;
  const saved = await api("post", { method: "PUT", body: readEditor() });
  current = saved;
  dirty = editVersion !== submittedVersion;
  $("slug").disabled = true;
  $("delete-post").hidden = current.kind === "page";
  $("save-state").textContent = dirty ? "已保存，仍有新的修改" : "草稿已保存";
  return saved;
}
function markDirty() {
  editVersion++;
  dirty = true;
  $("save-state").textContent = "有未保存的修改";
  $("word-count").textContent = `${$("body").value.length} 字`;
}
function canLeave() {
  return !dirty || confirm("修改还没有保存，确定离开吗？");
}
function setPublishing(value) {
  publishing = value;
  for (const id of ["save", "publish", "new", "upload", "delete-post"])
    $(id).disabled = value;
}
async function pollJob() {
  try {
    const job = await api("job");
    if (!job) return;
    $("job-panel").hidden = false;
    $("job-message").textContent = job.message;
    $("job-log").textContent = job.log || "";
    $("visit").hidden = job.status !== "success";
    $("job-details").open = job.status === "failed";
    setPublishing(job.status === "running");
    if (publishing) setTimeout(pollJob, 600);
    else if (job.status === "success") {
      if (job.operation === "delete" && current?.id === job.postId) {
        current = null;
        dirty = false;
        await loadList();
      }
      if (current) {
        current = await api("post?id=" + encodeURIComponent(current.id));
        $("save-state").textContent = dirty
          ? "已发布，仍有未保存的修改"
          : statusNames[current.status];
      }
      if (!$("list").hidden) await loadList();
    }
  } catch (e) {
    message(e.message, true);
    setPublishing(false);
  }
}
$("login-form").onsubmit = async e => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  $("login-error").textContent = "";
  try {
    const result = await api("login", {
      method: "POST",
      body: { password: $("password").value, code: $("login-code").value },
    });
    if (result.requiresTotp) {
      $("login-code-field").hidden = false;
      $("login-code").required = true;
      $("login-code").focus();
      return;
    }
    csrf = result.csrf;
    $("password").value = "";
    $("login-code").value = "";
    $("login-code").required = false;
    $("login-code-field").hidden = true;
    if (current && dirty) show("editor");
    else await loadList();
    await pollJob();
  } catch (error) {
    $("login-error").textContent = error.message;
  } finally {
    button.disabled = false;
  }
};
let totpEnabled = false;
$("security-link").onclick = () =>
  action($("security-link"), async () => {
    if (!canLeave()) return;
    const status = await api("security");
    totpEnabled = status.enabled;
    clearSetup();
    $("security-form").hidden = false;
    $("disable-code-field").hidden = !totpEnabled;
    $("disable-code").required = totpEnabled;
    $("security-status").textContent = totpEnabled
      ? "已启用。登录需要密码和动态验证码。更换设备前，请先关闭当前验证器。"
      : "尚未启用。绑定验证器，为登录增加一道验证。";
    $("security-submit").textContent = totpEnabled
      ? "关闭验证器"
      : "绑定验证器";
    $("job-panel").hidden = true;
    show("security");
  });
$("security-back").onclick = () => action($("security-back"), loadList);
function securityDone(text) {
  csrf = "";
  $("password").value = "";
  $("login-code").value = "";
  $("login-code").required = false;
  $("login-code-field").hidden = true;
  show("login");
  $("login-error").textContent = "";
  message(text);
}
$("security-form").onsubmit = e => {
  e.preventDefault();
  void action(e.submitter, async () => {
    if (totpEnabled) {
      if (!confirm("关闭后将只使用密码登录。确认关闭验证器？")) return;
      await api("security/disable", {
        method: "POST",
        body: {
          password: $("security-password").value,
          code: $("disable-code").value,
        },
      });
      securityDone("验证器已关闭，请重新登录。");
    } else {
      const setup = await api("security/setup", {
        method: "POST",
        body: { password: $("security-password").value },
      });
      $("security-password").value = "";
      $("totp-secret").value = setup.secret;
      $("totp-qr").src = "/admin/api/security/qr?t=" + Date.now();
      $("security-form").hidden = true;
      $("totp-setup").hidden = false;
      $("setup-code").focus();
    }
  });
};
$("totp-setup").onsubmit = e => {
  e.preventDefault();
  void action(e.submitter, async () => {
    await api("security/confirm", {
      method: "POST",
      body: { code: $("setup-code").value },
    });
    securityDone("验证器已启用，请使用密码和下一组动态码重新登录。");
  });
};
$("copy-secret").onclick = () =>
  action($("copy-secret"), async () => {
    await navigator.clipboard.writeText($("totp-secret").value);
    message("密钥已复制，请妥善保管。");
  });
$("logout").onclick = () =>
  action($("logout"), async () => {
    if (!canLeave()) return;
    await api("logout", { method: "POST", body: {} });
    current = null;
    dirty = false;
    $("job-panel").hidden = true;
    show("login");
  });
$("new").onclick = () =>
  openEditor({
    id: `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}.md`,
    revision: null,
    title: "",
    body: "",
    description: "",
    author: "Wenying",
    tags: [],
    pubDatetime: new Date().toISOString(),
    featured: false,
    format: "md",
    status: "draft",
  });
$("delete-post").onclick = () =>
  action($("delete-post"), async () => {
    if (!current?.revision) return;
    if (
      !confirm(
        `确定删除「${current.title}」吗？文章及其草稿会在网站构建成功后移除，未保存的修改也将丢弃。`
      )
    )
      return;
    await api("delete", {
      method: "POST",
      body: { id: current.id, revision: current.revision },
    });
    setPublishing(true);
    await pollJob();
  });
$("edit-home").onclick = () =>
  action($("edit-home"), async () => {
    openEditor(await api("post?id=home%3Apage"));
  });
$("edit-about").onclick = () =>
  action($("edit-about"), async () => {
    openEditor(await api("post?id=about%3Apage"));
  });
$("back").onclick = () =>
  action($("back"), async () => {
    if (canLeave()) {
      current = null;
      dirty = false;
      await loadList();
    }
  });
$("search").oninput = renderList;
document.querySelectorAll("[data-filter]").forEach(
  button =>
    (button.onclick = () => {
      filter = button.dataset.filter;
      document
        .querySelectorAll("[data-filter]")
        .forEach(b => b.setAttribute("aria-pressed", String(b === button)));
      renderList();
    })
);
for (const id of [
  "title",
  "body",
  "description",
  "tags",
  "author",
  "slug",
  "date",
  "featured",
  "social-github",
  "social-x",
  "social-linkedin",
  "social-mail",
])
  $(id).addEventListener("input", markDirty);
$("save").onclick = () =>
  action($("save"), async () => {
    await save();
    message("草稿已保存，线上文章未改变。");
  });
$("publish").onclick = () =>
  action($("publish"), async () => {
    const post = await save();
    await api("publish", {
      method: "POST",
      body: { id: post.id, revision: post.revision },
    });
    setPublishing(true);
    await pollJob();
  });
$("preview-toggle").onclick = () =>
  action($("preview-toggle"), async () => {
    if (!previewing) {
      const result = await api("preview", {
        method: "POST",
        body: { body: $("body").value },
      });
      $("preview").innerHTML = result.html;
    }
    previewing = !previewing;
    $("preview").hidden = !previewing;
    $("body").hidden = previewing;
    $("preview-toggle").textContent = previewing ? "继续编辑" : "预览";
    $("preview-toggle").setAttribute("aria-pressed", String(previewing));
  });
function insert(text, before = "", after = "") {
  const area = $("body");
  const start = area.selectionStart,
    end = area.selectionEnd;
  area.setRangeText(
    before + (area.value.slice(start, end) || text) + after,
    start,
    end,
    "end"
  );
  previewing = false;
  $("preview").hidden = true;
  area.hidden = false;
  $("preview-toggle").textContent = "预览";
  $("preview-toggle").setAttribute("aria-pressed", "false");
  area.focus();
  markDirty();
}
document.querySelectorAll("[data-insert]").forEach(
  button =>
    (button.onclick = () => {
      const type = button.dataset.insert;
      if (type === "heading") insert("小标题", "\n## ", "\n");
      if (type === "bold") insert("加粗文字", "**", "**");
      if (type === "link") insert("链接文字", "[", "](https://example.com)");
    })
);
async function upload(file) {
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) throw new Error("图片不能超过 8 MB");
  message("正在上传图片…");
  const result = await api("upload", { method: "POST", body: file });
  insert(`\n![图片说明](${result.url})\n`);
  message("图片已插入；发布文章后会一起上线。");
}
$("upload").onclick = () => $("image-file").click();
$("image-file").onchange = () =>
  action($("upload"), async () => {
    await upload($("image-file").files[0]);
    $("image-file").value = "";
  });
$("body").addEventListener("paste", e => {
  const file = [...e.clipboardData.files].find(f =>
    f.type.startsWith("image/")
  );
  if (file) {
    e.preventDefault();
    void action($("upload"), () => upload(file));
  }
});
$("body").addEventListener("dragover", e => e.preventDefault());
$("body").addEventListener("drop", e => {
  e.preventDefault();
  if (!publishing)
    void action($("upload"), () => upload(e.dataTransfer.files[0]));
});
window.addEventListener("beforeunload", e => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});
document.addEventListener("keydown", e => {
  if ((e.ctrlKey || e.metaKey) && e.key === "s" && !$("editor").hidden) {
    e.preventDefault();
    if (!publishing) $("save").click();
  }
});
try {
  const session = await api("session");
  csrf = session.csrf;
  await loadList();
  await pollJob();
} catch {
  show("login");
}
