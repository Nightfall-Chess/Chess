const PROFILE_KEY = "nightfall-chess-player-profile-v1";
const IDENTITY_KEY = "nightfall-orbit-identity-v1";
const $ = id => document.getElementById(id);

const copy = {
  en: {
    title: "Orbit Identity · GitHub",
    description: "Use your public GitHub profile to sync your display name and avatar with Orbit projects.",
    label: "GitHub username",
    placeholder: "e.g. octocat",
    connect: "Connect / refresh",
    disconnect: "Disconnect",
    idle: "Enter your GitHub username. Only public profile information is read.",
    loading: "Fetching your public GitHub profile…",
    connected: "Public profile synced. Use the same GitHub username in Orbit to show the same identity.",
    disconnected: "Disconnected. Your last synced Nightfall profile remains unchanged.",
    avatarFallback: "Name synced; GitHub avatar could not be downloaded. Your current picture was kept.",
    invalid: "Enter a valid GitHub username (1–39 letters, numbers or hyphens).",
    notFound: "That GitHub user could not be found.",
    rateLimit: "GitHub's public API rate limit was reached. Try again later.",
    failed: "Could not sync the GitHub profile. Check your connection and try again.",
    ownership: "This reads public profile data only; it does not verify account ownership."
  },
  fa: {
    title: "هویت Orbit · گیت‌هاب",
    description: "با پروفایل عمومی GitHub، نام نمایشی و تصویرت را بین پروژه‌های Orbit هماهنگ کن.",
    label: "نام کاربری GitHub",
    placeholder: "مثلاً octocat",
    connect: "اتصال / به‌روزرسانی",
    disconnect: "قطع اتصال",
    idle: "نام کاربری GitHub را وارد کن. فقط اطلاعات عمومی خوانده می‌شود.",
    loading: "در حال دریافت پروفایل عمومی GitHub…",
    connected: "پروفایل همگام شد. برای نمایش همین هویت در Orbit، همین نام کاربری را آنجا هم وارد کن.",
    disconnected: "اتصال قطع شد. پروفایل فعلی Nightfall بدون تغییر باقی ماند.",
    avatarFallback: "نام همگام شد، اما دریافت عکس GitHub ممکن نشد؛ تصویر فعلی حفظ شد.",
    invalid: "نام کاربری معتبر GitHub را وارد کن (۱ تا ۳۹ حرف، عدد یا خط تیره).",
    notFound: "این کاربر GitHub پیدا نشد.",
    rateLimit: "محدودیت درخواست عمومی GitHub تمام شده است. کمی بعد دوباره تلاش کن.",
    failed: "همگام‌سازی پروفایل انجام نشد. اتصال اینترنت را بررسی و دوباره تلاش کن.",
    ownership: "این قابلیت فقط اطلاعات عمومی را می‌خواند و مالکیت حساب را تأیید نمی‌کند."
  }
};

let connectedIdentity = null;

function language() {
  return document.documentElement.lang === "fa" ? "fa" : "en";
}
function t(key) {
  return copy[language()][key];
}
function status(message, state = "") {
  const node = $("githubIdentityStatus");
  if (!node) return;
  node.textContent = message;
  node.dataset.state = state;
}
function readSavedIdentity() {
  try {
    const value = JSON.parse(localStorage.getItem(IDENTITY_KEY) || "null");
    if (value && typeof value.login === "string" && /^[A-Za-z0-9-]{1,39}$/.test(value.login)) return value;
  } catch (error) {
    console.warn("Saved GitHub identity could not be read:", error);
  }
  return null;
}
function renderCopy() {
  const root = $("githubIdentityPanel");
  if (!root) return;
  root.querySelector("[data-copy=title]").textContent = t("title");
  root.querySelector("[data-copy=description]").textContent = t("description");
  root.querySelector("[data-copy=label]").textContent = t("label");
  root.querySelector("[data-copy=connect]").textContent = t("connect");
  root.querySelector("[data-copy=disconnect]").textContent = t("disconnect");
  root.querySelector("[data-copy=ownership]").textContent = t("ownership");
  $("githubIdentityUsername").placeholder = t("placeholder");
  if (!connectedIdentity && !root.dataset.hasStatus) status(t("idle"));
}
function mount() {
  const fields = document.querySelector(".profile-editor-fields");
  if (!fields || $("githubIdentityPanel")) return;
  const panel = document.createElement("section");
  panel.id = "githubIdentityPanel";
  panel.className = "github-identity-panel";
  panel.innerHTML = '<div class="github-identity-heading"><strong data-copy="title"></strong><span class="github-identity-mark" aria-hidden="true">GH</span></div><p class="github-identity-description" data-copy="description"></p><label class="field github-identity-field"><span class="field-label" data-copy="label"></span><input id="githubIdentityUsername" type="text" maxlength="39" autocomplete="off" autocapitalize="none" spellcheck="false"></label><div class="github-identity-actions"><button class="primary-button" id="githubIdentityConnect" type="button" data-copy="connect"></button><button class="subtle-button" id="githubIdentityDisconnect" type="button" data-copy="disconnect"></button></div><p class="github-identity-status" id="githubIdentityStatus" role="status" aria-live="polite"></p><p class="github-identity-note" data-copy="ownership"></p>';
  fields.append(panel);
  connectedIdentity = readSavedIdentity();
  if (connectedIdentity) {
    $("githubIdentityUsername").value = connectedIdentity.login;
    status(t("connected") + " (@" + connectedIdentity.login + ")", "ready");
    panel.dataset.hasStatus = "true";
  }
  $("githubIdentityConnect").addEventListener("click", () => void connect());
  $("githubIdentityUsername").addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      void connect();
    }
  });
  $("githubIdentityDisconnect").addEventListener("click", disconnect);
  renderCopy();
}
function validateLogin(value) {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(value) && !value.includes("--");
}
async function fetchPublicProfile(login) {
  const response = await fetch("https://api.github.com/users/" + encodeURIComponent(login), {
    headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
    cache: "no-store",
    credentials: "omit"
  });
  if (response.status === 404) throw new Error("GITHUB_USER_NOT_FOUND");
  if (response.status === 403 || response.status === 429) throw new Error("GITHUB_RATE_LIMIT");
  if (!response.ok) throw new Error("GITHUB_HTTP_" + response.status);
  const profile = await response.json();
  if (!profile || typeof profile.login !== "string" || typeof profile.avatar_url !== "string") {
    throw new Error("GITHUB_INVALID_PROFILE");
  }
  return profile;
}
async function makeAvatarFile(avatarUrl) {
  const url = new URL(avatarUrl);
  if (url.hostname !== "avatars.githubusercontent.com") throw new Error("Unexpected GitHub avatar host.");
  url.searchParams.set("size", "256");
  const response = await fetch(url, { mode: "cors", credentials: "omit", cache: "no-store" });
  if (!response.ok) throw new Error("Avatar request failed (" + response.status + ").");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/") || blob.size > 5 * 1024 * 1024) throw new Error("Invalid avatar image.");
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = document.createElement("canvas");
    const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable.");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const compressed = await new Promise((resolve, reject) => {
      canvas.toBlob(value => value ? resolve(value) : reject(new Error("Avatar compression failed.")), "image/jpeg", 0.78);
    });
    if (compressed.size > 130000) throw new Error("Compressed avatar is too large.");
    return new File([compressed], "github-avatar.jpg", { type: "image/jpeg" });
  } finally {
    bitmap.close();
  }
}
function waitForPreview(timeoutMs = 6000) {
  return new Promise(resolve => {
    const preview = $("profileAvatarPreview");
    let finished = false;
    const observer = new MutationObserver(() => finish());
    const finish = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      clearTimeout(timer);
      resolve(Boolean(preview.querySelector("img")));
    };
    observer.observe(preview, { childList: true, subtree: true, attributes: true });
    const timer = setTimeout(finish, timeoutMs);
  });
}
async function applyProfile(profile, avatarFile) {
  const name = String(profile.name || profile.login).trim().slice(0, 24) || profile.login.slice(0, 24);
  $("profileName").value = name;
  if (avatarFile) {
    const transfer = new DataTransfer();
    transfer.items.add(avatarFile);
    $("profileImage").files = transfer.files;
    const ready = waitForPreview();
    $("profileImage").dispatchEvent(new Event("change", { bubbles: true }));
    await ready;
  }
  $("saveProfileButton").click();
  const identity = {
    login: profile.login,
    name: profile.name || "",
    avatarUrl: profile.avatar_url,
    profileUrl: profile.html_url,
    bio: profile.bio || "",
    syncedAt: new Date().toISOString()
  };
  localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  connectedIdentity = identity;
  $("githubIdentityUsername").value = profile.login;
  $("githubIdentityPanel").dataset.hasStatus = "true";
  status((avatarFile ? t("connected") : t("avatarFallback")) + " (@" + profile.login + ")", "ready");
}
async function connect() {
  const input = $("githubIdentityUsername");
  const login = input.value.trim();
  if (!validateLogin(login)) {
    status(t("invalid"), "error");
    input.focus();
    return;
  }
  const button = $("githubIdentityConnect");
  button.disabled = true;
  status(t("loading"), "pending");
  try {
    const profile = await fetchPublicProfile(login);
    let avatarFile = null;
    try {
      avatarFile = await makeAvatarFile(profile.avatar_url);
    } catch (error) {
      console.warn("GitHub avatar could not be synced; keeping the current picture:", error);
    }
    await applyProfile(profile, avatarFile);
  } catch (error) {
    console.error("GitHub profile sync failed:", error);
    const message = error.message === "GITHUB_USER_NOT_FOUND" ? t("notFound")
      : error.message === "GITHUB_RATE_LIMIT" ? t("rateLimit")
        : t("failed");
    status(message, "error");
  } finally {
    button.disabled = false;
  }
}
function disconnect() {
  localStorage.removeItem(IDENTITY_KEY);
  connectedIdentity = null;
  $("githubIdentityUsername").value = "";
  $("githubIdentityPanel").dataset.hasStatus = "true";
  status(t("disconnected"), "");
}
function observeLanguage() {
  const observer = new MutationObserver(renderCopy);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["lang"] });
}
mount();
observeLanguage();
