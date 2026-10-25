// popup.js
var DEFAULT_TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJleHAiOjE3OTI5Mzg0MjgsInVzZXJuYW1lIjoiMTIwMjYxMTAwMTA0In0.LeyP_8TPnj0t0udSGLerZaIkQygvYGeasS-FFEHwvQE";
var API_BASE = "http://ncepu.jcedutec.cn:8800/jeecg-boot";

var $ = function (id) { return document.getElementById(id); };

function decodeExp(token) {
  try {
    var j = JSON.parse(decodeURIComponent(escape(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));
    return j.exp || 0;
  } catch (e) { return 0; }
}

async function getActiveTab() {
  var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0];
}

async function activeToken() {
  var st = await chrome.storage.local.get(["jce_token", "jce_token_ts", "jce_manual_token"]);
  // 页面抓取的 token 24h 内优先(跟随最新登录), 否则用手动填的
  if (st.jce_token && st.jce_token_ts && Date.now() - st.jce_token_ts < 86400000) return st.jce_token;
  var manual = ($("token").value || "").trim();
  return manual || st.jce_manual_token || null;
}

// ---------------------------------------------------------------- token

async function initToken() {
  var st = await chrome.storage.local.get(["jce_token", "jce_token_ts", "jce_token_initialized"]);
  if (!st.jce_token_initialized) {
    $("token").value = DEFAULT_TOKEN;
    await chrome.storage.local.set({ jce_token_initialized: true });
  } else if (!st.jce_token && st.jce_token_ts && Date.now() - st.jce_token_ts > 86400000) {
    // 页面 token 太旧, 填入手动框由用户决定
  }
  var tok = st.jce_token || DEFAULT_TOKEN;
  var exp = decodeExp(tok);
  if (exp) {
    var days = (exp - Date.now() / 1000) / 86400;
    $("tokenInfo").textContent = "当前 token 有效期至 " +
      new Date(exp * 1000).toLocaleString("zh-CN") + "（约 " + days.toFixed(1) + " 天）" +
      (st.jce_token ? " ｜ 已从页面自动抓取" : "");
  }
  $("token").addEventListener("change", function () {
    chrome.storage.local.set({ jce_manual_token: $("token").value.trim() });
  });
}

// ---------------------------------------------------------------- 课程列表

async function loadCourses() {
  var box = $("courses");
  box.innerHTML = '<div class="muted">加载中…</div>';
  var tok = await activeToken();
  if (!tok) { box.innerHTML = '<div class="muted">无 token，请手动填写</div>'; return; }
  try {
    var r = await fetch(API_BASE + "/jcedutec/exam/myExamList?pageNo=1&pageSize=50&_t=" + Date.now(), {
      headers: { "X-Access-Token": tok, "tenant-id": "0" }
    });
    var data = await r.json();
    var rows = (data.result && data.result.records) || [];
    if (!rows.length) { box.innerHTML = '<div class="muted">未找到课程（token 失效？）</div>'; return; }
    box.innerHTML = "";
    var seen = {};
    rows.forEach(function (e) {
      var gid = e.graphId;
      if (!gid || seen[gid]) return;
      seen[gid] = true;
      var div = document.createElement("div");
      div.className = "course";
      div.innerHTML = '<input type="checkbox" checked data-gid="' + gid + '">' +
        '<span class="name" title="' + (e.examName || "") + '">' + (e.examName || "未命名课程") + '</span>' +
        '<span class="rate">' + (e.learnRate || 0) + '%</span>';
      box.appendChild(div);
    });
  } catch (err) {
    box.innerHTML = '<div class="muted">课程加载失败: ' + err.message + '</div>';
  }
}

// ---------------------------------------------------------------- 状态渲染

function renderState(st) {
  if (!st) return;
  var el = $("status");
  el.className = "";
  if (st.running) { el.textContent = "运行中"; el.className = "running"; }
  else if (st.status === "done") { el.textContent = "已完成"; el.className = "done"; }
  else if (st.status === "error") { el.textContent = "出错"; el.className = "error"; }
  else if (st.status === "stopped") { el.textContent = "已停止"; }
  else el.textContent = "就绪";

  var wrap = $("progressWrap");
  if (st.running || st.status === "done") {
    wrap.style.display = "block";
    $("curCourse").textContent = st.currentCourse || "—";
    var pct = st.total ? Math.round(st.finished / st.total * 100) : 0;
    $("progressFill").style.width = pct + "%";
    $("curNode").textContent = "进度 " + st.finished + "/" + st.total +
      (st.quizHandled ? "，弹题已答 " + st.quizHandled : "") +
      (st.currentNode ? " ｜ " + st.currentNode : "");
  } else wrap.style.display = "none";

  if (st.log && st.log.length) {
    var lg = $("log");
    lg.textContent = st.log.slice(-40).join("\n");
    lg.scrollTop = lg.scrollHeight;
  }
  $("startBtn").disabled = !!st.running;
  lastRunning = !!st.running;
}

var lastRunning = false;

// 运行中改倍速 → 实时下发到页面
$("speed").addEventListener("change", async function () {
  var speed = parseFloat($("speed").value);
  if (isNaN(speed) || speed < 0.5 || speed > 16) return; // 非法值等点开始时再拦
  chrome.storage.local.set({ jce_speed: speed });
  if (!lastRunning) return;
  var tab = await getActiveTab();
  if (!tab || !tab.url || tab.url.indexOf("ncepu.jcedutec.cn:8802") === -1) return;
  try {
    var resp = await chrome.tabs.sendMessage(tab.id, { cmd: "setSpeed", speed: speed });
    if (resp && !resp.ok) $("hint").textContent = "倍速调整失败: " + (resp.message || "");
  } catch (e) { /* 页面脚本未加载, 忽略 */ }
});

async function refreshState() {
  var tab = await getActiveTab();
  if (!tab || !tab.url || tab.url.indexOf("ncepu.jcedutec.cn:8802") === -1) {
    $("status").textContent = "请打开学习网站";
    $("hint").textContent = "请先打开 http://ncepu.jcedutec.cn:8802 的课程学习页面";
    return;
  }
  try {
    var resp = await chrome.tabs.sendMessage(tab.id, { cmd: "ping" });
    if (resp && resp.ok) {
      var st = await chrome.storage.local.get("jce_state");
      renderState(st.jce_state || { running: resp.running, status: resp.status });
      if (!resp.hasTree && !resp.running)
        $("hint").textContent = "⚠ 当前页面没有目录树：请点开任意一节课，进入学习页（左侧有章节目录）后再开始";
      else if (!resp.hasPageToken)
        $("hint").textContent = "页面 token 尚未抓到，将使用手动 token";
    }
  } catch (e) {
    $("status").textContent = "请刷新页面";
    $("hint").textContent = "内容脚本未加载，请刷新学习网站页面后重试";
  }
}

// ---------------------------------------------------------------- 启动/停止

$("startBtn").addEventListener("click", async function () {
  var gids = [], names = [];
  document.querySelectorAll("#courses input[type=checkbox]:checked").forEach(function (cb) {
    gids.push(cb.dataset.gid);
    names.push(cb.parentElement.querySelector(".name").textContent);
  });
  if (!gids.length) { alert("请至少勾选一门课程"); return; }
  var speed = parseFloat($("speed").value);
  if (isNaN(speed) || speed < 0.5 || speed > 16) {
    alert("倍速请在 0.5 - 16 之间（超过 8 会被网站防快进打折，实测 8x 最快有效）");
    return;
  }
  chrome.storage.local.set({ jce_speed: speed });
  var tab = await getActiveTab();
  if (!tab || tab.url.indexOf("ncepu.jcedutec.cn:8802") === -1) { alert("请先打开学习网站页面"); return; }
  var manual = $("token").value.trim();
  try {
    var resp = await chrome.tabs.sendMessage(tab.id, {
      cmd: "start",
      token: manual || null,
      cfg: {
        graphIds: gids,
        courseNames: names,
        speed: speed,
        quizMode: $("quizMode").value
      }
    });
    if (!resp.ok) alert(resp.message || "启动失败");
    else setTimeout(refreshState, 800);
  } catch (e) {
    alert("无法连接页面脚本，请刷新学习网站页面");
  }
});

$("stopBtn").addEventListener("click", async function () {
  var tab = await getActiveTab();
  if (!tab) return;
  try { await chrome.tabs.sendMessage(tab.id, { cmd: "stop" }); } catch (e) {}
  setTimeout(refreshState, 500);
});

// ---------------------------------------------------------------- init

// 恢复上次使用的倍速
chrome.storage.local.get("jce_speed", function (r) {
  if (r.jce_speed) $("speed").value = r.jce_speed;
});

chrome.storage.onChanged.addListener(function (ch, area) {
  if (area === "local" && ch.jce_state) renderState(ch.jce_state.newValue);
});

initToken();
refreshState();
loadCourses();
setInterval(refreshState, 3000);
