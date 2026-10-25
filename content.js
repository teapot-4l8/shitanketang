// content.js — 页面端编排器(顶层 frame)
// 基于 chunk-c2e0af64.d1982fb8.js 逆向的真实 DOM 结构:
//   视频: 原生 <video> (ref=videoPlayer), 每10s上报 finishRate, ended 上报 finish
//   目录: .custom-tree (a-tree), 节点标题在 .ant-tree-title, 点击 .ant-tree-node-content-wrapper 触发 onSelect
//   弹题: .ant-modal (title=视频习题), 单选 .ant-radio-wrapper / 多选 .ant-checkbox-wrapper,
//         答对后 showModal=false 并自动恢复播放 (以此判断答案正确)
//   防快进: currentTime 相邻差 >3s 会被回退 → 只能倍速, 不能 seek

/* global ANSWER_BANK */

(function () {
  if (window.top !== window) return;
  if (window.__JCE_CONTENT__) return;
  window.__JCE_CONTENT__ = true;

  // ---------------------------------------------------------------- API 代理(inject.js)

  var seq = 0;
  var apiPending = {};
  var pageToken = null;
  var tokenOverride = null;

  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d) return;
    if (d.type === "JCE_TOKEN") {
      pageToken = d.token;
      if (pageToken) chrome.storage.local.set({ jce_token: pageToken, jce_token_ts: Date.now() });
    } else if (d.type === "JCE_API_RESULT" && apiPending[d.seq]) {
      var resolve = apiPending[d.seq];
      delete apiPending[d.seq];
      resolve(d.resp);
    }
  });

  function injectScript() {
    var s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.onload = function () { s.remove(); };
    s.onerror = function () {
      log("inject.js 加载失败: 请在扩展管理页点击刷新按钮重新加载插件后重试");
      s.remove();
    };
    (document.head || document.documentElement).appendChild(s);
    // 5s 内没有收到任何页面消息 → 注入大概率失败
    setTimeout(function () {
      if (!pageToken && state.status === "idle" && !state.running) {
        log("提示: 尚未收到页面 token。若一直报请求超时, 请刷新网站页面并重载扩展");
      }
    }, 5000);
  }

  function api(method, path, body) {
    return new Promise(function (resolve) {
      var my = ++seq;
      apiPending[my] = resolve;
      window.postMessage({
        type: "JCE_API", seq: my, method: method, path: path,
        body: body == null ? null : body,
        token: tokenOverride || null
      }, "*");
      setTimeout(function () {
        if (apiPending[my]) {
          delete apiPending[my];
          resolve({ success: false, message: "请求超时(页面代理无响应,请刷新页面并重载扩展)" });
        }
      }, 15000);
    });
  }

  // ---------------------------------------------------------------- 状态/日志

  var state = {
    running: false, status: "idle",
    currentCourse: "", currentNode: "",
    total: 0, finished: 0, quizHandled: 0, log: []
  };

  var flushTimer = null;
  function flush() {
    if (flushTimer) return;
    flushTimer = setTimeout(function () {
      flushTimer = null;
      chrome.storage.local.set({
        jce_state: { running: state.running, status: state.status,
          currentCourse: state.currentCourse, currentNode: state.currentNode,
          total: state.total, finished: state.finished,
          quizHandled: state.quizHandled, log: state.log.slice(-60) }
      });
    }, 200);
  }

  function log(msg) {
    var line = "[" + new Date().toLocaleTimeString("zh-CN", { hour12: false }) + "] " + msg;
    state.log.push(line);
    if (state.log.length > 300) state.log.shift();
    console.log("[JCE]", msg);
    flush();
  }

  // ---------------------------------------------------------------- 答案库

  var bankStem = {};
  (function buildBank() {
    if (typeof ANSWER_BANK !== "undefined") {
      Object.keys(ANSWER_BANK).forEach(function (qid) {
        var e = ANSWER_BANK[qid];
        if (e.stem) bankStem[normStem(e.stem)] = e.option || e.answer;
      });
    }
    chrome.storage.local.get("jce_learned", function (r) {
      var learned = r.jce_learned || {};
      Object.keys(learned).forEach(function (k) {
        if (!(k in bankStem)) bankStem[k] = learned[k];
      });
    });
  })();

  function normStem(s) {
    return String(s || "").replace(/[\s\u3000.,，。;；:：?？!！'’"“”()（）【】\[\]0-9]/g, "").toLowerCase();
  }

  function learnAnswer(stem, option) {
    var k = normStem(stem);
    if (!k || !option) return;
    bankStem[k] = option;
    chrome.storage.local.get("jce_learned", function (r) {
      var learned = r.jce_learned || {};
      learned[k] = option;
      if (Object.keys(learned).length > 4000) learned = {};
      chrome.storage.local.set({ jce_learned: learned });
    });
  }

  // ---------------------------------------------------------------- 工具

  // Worker 计时器: 后台标签页的 window 定时器会被 Chrome 强节流(隐藏久后最狠 1次/分钟),
  // 导致切走后弹题长时间无人处理。Worker 计时不受可见性影响。
  var workerTimer = null;
  try {
    var blob = new Blob(["setInterval(function(){postMessage(0)},250);"], { type: "text/javascript" });
    workerTimer = new Worker(URL.createObjectURL(blob));
  } catch (e) { workerTimer = null; }

  function sleep(ms) {
    if (!workerTimer) return new Promise(function (r) { setTimeout(r, ms); });
    return new Promise(function (resolve) {
      var start = Date.now();
      var onTick = function () {
        if (Date.now() - start >= ms) {
          workerTimer.removeEventListener("message", onTick);
          resolve();
        }
      };
      workerTimer.addEventListener("message", onTick);
    });
  }
  function randDelay(a, b) { return sleep(a + Math.random() * (b - a)); }

  function decodeExp(token) {
    try {
      var j = JSON.parse(decodeURIComponent(escape(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));
      return j.exp || 0;
    } catch (e) { return 0; }
  }

  // 页面树标题带 "(学完) "/"(未学) "/"(79%)" 等前缀, 匹配时统一去掉
  function stripTitle(t) {
    return String(t || "")
      .replace(/^\s*[（(]\s*(?:学完|未学|已学|\d+%)[^)）]*[)）]\s*/, "")
      .replace(/^\s*\d+[.\s]\s*/, "")
      .trim();
  }

  // myCourseTypeTree 的叶子: children 为空即叶子(isLeaf 恒为 false)
  function collectLeaves(nodes, out) {
    (nodes || []).forEach(function (n) {
      if (!n.children || !n.children.length) {
        if (n.key) out.push({ id: n.key, title: stripTitle(n.title) });
      } else collectLeaves(n.children, out);
    });
    return out;
  }

  function visible(el) {
    var s = window.getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden" && el.offsetWidth > 0 && el.offsetHeight > 0;
  }

  function realClick(el) {
    if (!el) return;
    var r = el.getBoundingClientRect();
    var opt = { bubbles: true, cancelable: true, view: window,
                clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    ["mousedown", "mouseup", "click"].forEach(function (t) {
      el.dispatchEvent(new MouseEvent(t, opt));
    });
    if (el.click) el.click();
  }

  // ---------------------------------------------------------------- 目录树操作

  // 展开所有折叠的父节点(反复点击 switcher 直到没有 _close)
  async function expandAllTree() {
    for (var round = 0; round < 12; round++) {
      var closed = document.querySelectorAll(".custom-tree .ant-tree-switcher_close");
      if (!closed.length) return;
      Array.prototype.forEach.call(closed, function (sw) { realClick(sw); });
      await sleep(600);
    }
  }

  // 精确点击目录树节点标题(DOM 标题带 (学完)/(未学) 前缀, 用 stripTitle 对齐)
  function clickTreeNode(title) {
    var titles = document.querySelectorAll(".custom-tree .ant-tree-title");
    var target = null;
    for (var i = 0; i < titles.length; i++) {
      if (stripTitle(titles[i].textContent) === title) { target = titles[i]; break; }
    }
    // 容错: 互相包含
    if (!target) {
      for (var j = 0; j < titles.length; j++) {
        var t2 = stripTitle(titles[j].textContent);
        if (title.length > 6 && (t2.indexOf(title) !== -1 || title.indexOf(t2) !== -1)) {
          target = titles[j]; break;
        }
      }
    }
    if (!target) return false;
    var wrapper = target.closest(".ant-tree-node-content-wrapper") || target;
    realClick(wrapper);
    return true;
  }

  // ---------------------------------------------------------------- 弹题处理(ant-modal)

  function findQuizModal() {
    var fallback = null;
    var wraps = document.querySelectorAll(".ant-modal-wrap");
    for (var i = 0; i < wraps.length; i++) {
      var w = wraps[i];
      var m = w.querySelector(".ant-modal");
      if (!m) continue;
      var txt = (m.textContent || "");
      if (!/视频习题/.test(txt)) continue;
      if (visible(w)) return m;
      // 后台标签页 offsetWidth 可能为 0 → 记为候选而不是直接放弃
      if (!fallback) fallback = m;
    }
    return fallback;
  }

  function modalStem(modal) {
    var st = modal.querySelector(".sub-title");
    if (st) {
      // 去掉开头的 "(单选)" 等题型标注
      return (st.textContent || "").replace(/^\s*[（(][^)）]*[)）]\s*/, "").trim();
    }
    return "";
  }

  // 弹窗内的选项容器(.mb-12.d-f 每行一个选项, .letter 为 A:/B:...)
  function modalOptionRows(modal) {
    var rows = [];
    Array.prototype.forEach.call(modal.querySelectorAll(".mb-12"), function (row) {
      var letter = row.querySelector(".letter");
      if (!letter) return;
      var m = (letter.textContent || "").trim().match(/^([A-D])\s*[:：]?/);
      if (!m) return;
      rows.push({ letter: m[1], row: row,
        radio: row.querySelector(".ant-radio-wrapper"),
        check: row.querySelector(".ant-checkbox-wrapper") });
    });
    return rows;
  }

  function modalSubmitBtn(modal) {
    var btns = modal.querySelectorAll("button");
    for (var i = 0; i < btns.length; i++) {
      // 注意: antd 按钮文案是"提 交"(中间带空格), 必须容忍空白
      var t = (btns[i].textContent || "").replace(/\s+/g, "");
      if (/^(确定|提交|确认|提交答案|确定答案)$/.test(t)) return btns[i];
    }
    return btns.length ? btns[btns.length - 1] : null;
  }

  function optionChecked(row) {
    var el = row.radio || row.check;
    if (!el) return false;
    var input = el.querySelector("input");
    if (input) return !!input.checked;
    return el.classList.contains("ant-radio-wrapper-checked") ||
           el.classList.contains("ant-checkbox-wrapper-checked");
  }

  function findRowByLetter(modal, letter) {
    var rows = modalOptionRows(modal);
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].letter === letter) return rows[i];
    }
    return null;
  }

  // 关键修复(v1.1.0): 点击后 Vue 会重渲染弹窗, 旧的 DOM 引用会失效——
  // 之前"点击明明生效却判未选中"就是因为拿着旧节点读状态。
  // 因此每次读取状态/点击都基于 findQuizModal() 的最新查询, 不缓存元素引用。
  async function setOptionState(letter, on) {
    for (var i = 0; i < 4; i++) {
      var m = findQuizModal();
      if (!m) return true; // 弹窗已关, 视为成功
      var row = findRowByLetter(m, letter);
      if (!row) return false;
      if (optionChecked(row) === !!on) return true;
      var el = row.radio || row.check;
      var input = el.querySelector("input");
      if (input) { try { input.click(); } catch (e) {} }
      else realClick(el);
      await sleep(350);
    }
    var m2 = findQuizModal();
    if (!m2) return true;
    var row2 = findRowByLetter(m2, letter);
    return row2 ? optionChecked(row2) : false;
  }

  // 返回 'answered' | 'closed' | 'failed'
  async function handleQuiz(cfg) {
    var modal = findQuizModal();
    if (!modal) return "closed";
    var stem = modalStem(modal);
    var known = bankStem[normStem(stem)];
    log("弹题: " + (stem ? stem.slice(0, 36) : "(题干未识别)") + (known ? " → 库中答案 " + known : " → 暴力尝试"));

    // 人类反应时间: 弹题出现后停顿一下再作答(≤3s)。
    await randDelay(1500, 3000);

    var letters = known ? (String(known).match(/[A-D]/g) || []) : null;
    var candidates = letters || ["A", "B", "C", "D"];

    if (cfg.quizMode === "skip" && !letters) {
      modal = findQuizModal();
      var closeX = modal && modal.querySelector(".ant-modal-close");
      if (closeX) { realClick(closeX); await sleep(600); }
      if (!findQuizModal()) { log("弹题已跳过"); return "closed"; }
      log("跳过失败, 回退自动答题");
    }

    modal = findQuizModal();
    if (!modal) return "closed";
    var isMulti = !!modal.querySelector(".ant-checkbox-group");

    for (var ci = 0; ci < candidates.length; ci++) {
      var pick = candidates[ci];
      var combo;
      if (isMulti) combo = (known && letters) ? letters : [pick];
      else combo = [pick];

      // 单选: 直接选目标(radio 自动互斥); 多选: 逐个设置目标组合状态
      var allOk = true;
      if (isMulti) {
        var allLetters = ["A", "B", "C", "D"];
        for (var li = 0; li < allLetters.length; li++) {
          var L = allLetters[li];
          if (!(await setOptionState(L, combo.indexOf(L) !== -1))) { allOk = false; }
        }
      } else {
        allOk = await setOptionState(pick, true);
      }
      if (!allOk) {
        log("选项点击未生效, 换方式重试中...");
        await sleep(600);
        continue;
      }

      await randDelay(400, 900);   // 选完到提交之间再停顿一下
      modal = findQuizModal();     // 重新拿最新弹窗引用再点提交
      if (!modal) {
        log("弹题答对: " + (isMulti ? combo.join("") : pick));
        if (stem) learnAnswer(stem, isMulti ? combo.join("") : pick);
        state.quizHandled++;
        return "answered";
      }
      var btn = modalSubmitBtn(modal);
      if (btn) realClick(btn);
      await sleep(1000);
      // 答对时网站自己关弹窗并恢复播放
      if (!findQuizModal()) {
        log("弹题答对: " + (isMulti ? combo.join("") : pick));
        if (stem) learnAnswer(stem, isMulti ? combo.join("") : pick);
        state.quizHandled++;
        return "answered";
      }
    }
    // 最后尝试直接关闭
    var lastM = findQuizModal();
    var cx = lastM && lastM.querySelector(".ant-modal-close");
    if (cx) { realClick(cx); await sleep(600); }
    return findQuizModal() ? "failed" : "closed";
  }

  // ---------------------------------------------------------------- 节点接口

  function nodeIdTail(id) { return String(id).slice(-6); }

  async function getNodeInfo(id, gid) {
    var r = await api("GET", "/jcedutec/courseSource/getById?id=" + id + "&graphId=" + gid);
    if (!r || r.success === false || !r.result) {
      r = await api("GET", "/jcedutec/courseSource/queryById?id=" + id + "&graphId=" + gid);
    }
    return (r && r.result) || null;
  }

  async function isNodeFinished(id, gid) {
    var info = await getNodeInfo(id, gid);
    return !!(info && String(info.isFinish) === "1");
  }

  // ---------------------------------------------------------------- 播放单个视频

  function getVideo() {
    var v = document.querySelector("video");
    return v || null;
  }

  // v1.0.8: 按用户要求移除一切插件自发的写入上报(追赶上报/assistFinish)。
  // 进度只由浏览器原生流程产生: 网站播放器自身的每10s finishRate + ended finish。
  // 插件仅保留: 只读轮询(getById) + DOM 操作(点目录树/答弹题)。

  async function playNode(node, gid, cfg, duration) {
    state.currentNode = node.title;
    log("→ " + node.title + " (" + nodeIdTail(node.id) + ", " + Math.round(duration) + "s)");

    // 确保树全部展开后点击节点
    var titles = document.querySelectorAll(".custom-tree .ant-tree-title");
    var needExpand = !Array.prototype.some.call(titles, function (el) {
      return stripTitle(el.textContent) === node.title;
    });
    if (needExpand) await expandAllTree();
    var clicked = clickTreeNode(node.title);

    // 等待视频 src 切换/出现
    var video = null;
    var oldSrc = getVideo() ? getVideo().src : "";
    for (var t = 0; t < 25; t++) {
      video = getVideo();
      if (video && (!oldSrc || video.src !== oldSrc || video.readyState >= 1)) break;
      await sleep(500);
    }

    if (!video || !clicked) {
      log("  无法定位(点击:" + clicked + " 视频:" + !!video + "), 请确认打开的是课程学习页(左侧目录树)");
      return false;
    }

    video.muted = true;
    try { video.playbackRate = cfg.speed; } catch (e) {}
    var playIt = function () {
      try {
        video.muted = true;
        var p = video.play();
        if (p && p.catch) p.catch(function () {});
      } catch (e) {}
    };
    playIt();

    var deadline = Date.now() + Math.max(180, (duration / cfg.speed) * 2.5 + 240) * 1000;
    var lastPoll = 0;
    var lastSrcCheck = video.src;
    var replayCount = 0;    // 播完未标记时的重播次数
    var stuckCount = 0, lastTime = -1;

    while (Date.now() < deadline && state.running) {
      await sleep(2000);
      if (!state.running) break;

      // 视频被 Vue 重载(src 变了) → 重新拿引用并继续播
      if (video.src !== lastSrcCheck) {
        lastSrcCheck = video.src;
        video = getVideo() || video;
        try { video.playbackRate = cfg.speed; } catch (e) {}
        replayCount = 0;
      }

      try {
        if (video.playbackRate !== cfg.speed) video.playbackRate = cfg.speed;
        if (!video.muted) video.muted = true;
        if (video.paused && !video.ended) {
          // 有弹窗时不要急着恢复播放(真人不会边看题边让视频跑),
          // 先处理弹题, 处理完由 handleQuizGuarded 恢复播放
          if (findQuizModal()) {
            await handleQuizGuarded(cfg);
          } else {
            playIt();
          }
        }
        // 卡住检测(非暂停也不走)
        if (!video.paused && !video.ended) {
          if (Math.abs(video.currentTime - lastTime) < 0.1) {
            stuckCount++;
            if (stuckCount >= 4) { playIt(); stuckCount = 0; }
          } else stuckCount = 0;
          lastTime = video.currentTime;
        }
      } catch (e) { video = getVideo() || video; }

      // 每 12s 轮询完成状态(只读)
      if (Date.now() - lastPoll > 12000) {
        lastPoll = Date.now();
        if (await isNodeFinished(node.id, gid)) {
          log("  ✔ 完成: " + node.title);
          return true;
        }
      }

      // 自然播完: 网站自己会 finish。若服务器没标记, 重播(最多2次)让网站的
      // 上报流程再走一遍 — 不自己发任何写入请求
      if (video.ended) {
        await sleep(3000);
        if (await isNodeFinished(node.id, gid)) {
          log("  ✔ 播完完成: " + node.title);
          return true;
        }
        if (replayCount < 2) {
          replayCount++;
          log("  播完未标记, 从头重播(第 " + replayCount + "/2 次)");
          try { video.currentTime = 0; } catch (e) {}
          playIt();
        } else {
          log("  ✘ 重播2次仍未标记, 跳过(下轮运行会自动补刷)");
          return false;
        }
      }
    }

    // 超时: 只确认, 不补报
    var fin = await isNodeFinished(node.id, gid);
    log(fin ? "  ✔ (延迟标记确认) " + node.title
            : "  ✘ 超时未完成, 跳过(下轮运行会自动补刷): " + node.title);
    return fin;
  }

  // ---------------------------------------------------------------- 主循环

  async function mainLoop(cfg) {
    state.running = true;
    state.status = "running";
    state.finished = 0;
    state.quizHandled = 0;
    state.currentNode = "";
    flush();

    var tok = tokenOverride || pageToken;
    if (!tok) { state.status = "error"; log("未获取到 token"); flush(); return; }
    var exp = decodeExp(tok);
    if (exp && Date.now() / 1000 > exp - 300) {
      state.status = "error";
      log("token 已过期, 重新登录网站后插件会自动抓新 token");
      flush(); return;
    }
    log("token 有效期至 " + new Date(exp * 1000).toLocaleString("zh-CN"));

    if (!document.querySelector(".custom-tree")) {
      state.status = "error";
      log("当前页面没有目录树, 请打开课程学习页(点开任意一节课的页面)再开始");
      flush(); return;
    }

    for (var ci = 0; ci < cfg.graphIds.length && state.running; ci++) {
      var gid = cfg.graphIds[ci];
      var name = cfg.courseNames[ci] || gid;
      state.currentCourse = name;
      log("=== " + name + " ===");

      // 课程页树 = myCourseTypeTree(和页面 DOM 一致), 需要 id 参数(任意节点id)
      var urlId = new URLSearchParams(location.search).get("id") || "";
      var urlGid = new URLSearchParams(location.search).get("graphId") || "";
      if (urlGid && urlGid !== gid) {
        log("提示: 当前页面是 graphId=" + urlGid.slice(-6) + " 的课程页, 切换视频可能无效, 请打开对应课程页");
      }
      var seed = urlId;
      if (!seed) {
        var gtree = await api("GET", "/jcedutec/knowledgeGraph/queryGraphTree?graphId=" + gid);
        var firstLeaf = null;
        (function pick(ns) {
          (ns || []).some(function (n) {
            if (!n.children || !n.children.length) { if (n.key) { firstLeaf = n.key; return true; } }
            else if (pick(n.children)) return true;
            return false;
          });
        })(gtree && gtree.result);
        seed = firstLeaf || "";
        if (seed) log("未从 URL 取到节点 id, 用首节点 seed=" + nodeIdTail(seed));
      }
      var tree = await api("GET", "/jcedutec/courseSource/myCourseTypeTree?id=" + seed + "&graphId=" + gid);
      if (!tree || !tree.success) { log("知识树获取失败: " + (tree && tree.message)); continue; }
      var leaves = collectLeaves(tree.result, []);
      log("共 " + leaves.length + " 个视频节点");

      var done = 0;
      for (var ni = 0; ni < leaves.length && state.running; ni++) {
        var node = leaves[ni];
        var info = await getNodeInfo(node.id, gid);
        var dur = Number((info && info.duration) || 0);
        if (info && String(info.isFinish) === "1") {
          done++;
          setProgress(done, leaves.length);
          continue;
        }
        var ok = await playNode(node, gid, cfg, dur);
        if (ok) done++;
        else await randDelay(1500, 3000);
        setProgress(done, leaves.length);
        await randDelay(600, 1500);
      }
      log("=== " + name + ": " + done + "/" + leaves.length + " ===");
      setProgress(done, leaves.length);
    }

    state.running = false;
    state.currentNode = "";
    if (state.status !== "stopped") state.status = "done";
    log("全部任务结束 ✔");
    flush();
  }

  function setProgress(finished, total) {
    state.finished = finished;
    state.total = total;
    flush();
  }

  // ---------------------------------------------------------------- 消息入口

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg.cmd === "ping") {
      sendResponse({ ok: true, running: state.running, status: state.status,
        hasPageToken: !!pageToken, hasTree: !!document.querySelector(".custom-tree") });
      return false;
    }
    if (msg.cmd === "start") {
      if (state.running) { sendResponse({ ok: false, message: "已在运行中" }); return false; }
      tokenOverride = msg.token || null;
      currentCfg = msg.cfg || { speed: 8, quizMode: "auto" };
      // 倍速防御: 限制 0.5-16, 非法值回落 8x
      var sp = Number(currentCfg.speed);
      currentCfg.speed = (isNaN(sp) || sp < 0.5 || sp > 16) ? 8 : sp;
      state.status = "running";
      mainLoop(currentCfg);
      sendResponse({ ok: true });
      return false;
    }
    if (msg.cmd === "setSpeed") {
      // 运行中实时改倍速: 更新 cfg(playNode 每轮读它) + 立刻改当前视频
      var sp = Number(msg.speed);
      if (isNaN(sp) || sp < 0.5 || sp > 16) {
        sendResponse({ ok: false, message: "倍速需在 0.5-16 之间" });
        return false;
      }
      if (currentCfg) currentCfg.speed = sp;
      var vNow = getVideo();
      if (vNow) { try { vNow.playbackRate = sp; } catch (e) {} }
      log("倍速已实时调整为 " + sp + "x");
      sendResponse({ ok: true });
      return false;
    }
    if (msg.cmd === "stop") {
      state.running = false;
      state.status = "stopped";
      log("已手动停止");
      flush();
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  // ---------------------------------------------------------------- 弹窗即时响应

  // 后台标签页定时器被强节流, 轮询式看门狗会迟到 → 用 MutationObserver 事件驱动:
  // 弹题一出现(哪怕人在别的窗口)立刻处理, 处理完网站自己恢复播放
  var currentCfg = null;
  var quizBusy = false;

  // 并发守卫: MutationObserver 与播放看门狗共用, 防止同时答两份
  function handleQuizGuarded(cfg) {
    if (quizBusy) return Promise.resolve("busy");
    quizBusy = true;
    return handleQuiz(cfg || { speed: 2, quizMode: "auto" })
      .then(function (res) {
        if (res === "failed") log("弹题自动处理失败, 等待重试");
        return res;
      })
      .catch(function () { return "failed"; })
      .then(function (res) {
        quizBusy = false;
        var v = getVideo();
        if (v && v.paused && !v.ended) {
          try { v.muted = true; var p = v.play(); if (p && p.catch) p.catch(function () {}); } catch (e) {}
        }
        return res;
      });
  }

  var quizObserver = new MutationObserver(function () {
    if (!state.running || quizBusy) return;
    if (!findQuizModal()) return;
    handleQuizGuarded(currentCfg);
  });
  try { quizObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}

  // ---------------------------------------------------------------- 后台保活

  // Edge/Chrome 会挂起后台标签页的(静音)视频。实测: 标签页有"非静音且非数字静音"
  // 的音频在播时, 视频不会被挂起。放一个 40Hz/幅度300/音量0.05 的循环音——
  // 人耳听不见, 但浏览器认为"正在播放声音"。(纯静音 WAV 会被浏览器的静音检测识破)
  function startKeepAliveAudio() {
    try {
      if (document.getElementById("jce-keepalive-audio")) return;
      var sr = 8000, secs = 2, amp = 300, n = sr * secs;
      var buf = new ArrayBuffer(44 + n * 2), dv = new DataView(buf);
      var ws = function (o, s) { for (var i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
      ws(0, "RIFF"); dv.setUint32(4, 36 + n * 2, true); ws(8, "WAVE"); ws(12, "fmt ");
      dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
      dv.setUint32(24, sr, true); dv.setUint32(28, sr * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
      ws(36, "data"); dv.setUint32(40, n * 2, true);
      for (var i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(amp * Math.sin(2 * Math.PI * 40 * i / sr)), true);
      var a = document.createElement("audio");
      a.id = "jce-keepalive-audio";
      a.src = URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
      a.loop = true; a.volume = 0.05; a.style.display = "none";
      (document.body || document.documentElement).appendChild(a);
      var p = a.play();
      if (p && p.catch) p.catch(function () {});
    } catch (e) {}
  }

  injectScript();
  startKeepAliveAudio();
  log("内容脚本已注入, 等待指令");
})();
