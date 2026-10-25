// inject.js — 注入页面主世界(MAIN world):
//  1. 从 localStorage / 真实请求头中抓取 X-Access-Token
//  2. 代理 API 请求(用页面自身的 fetch, 与网站行为一致, 无跨域问题)
//  与 content.js 通过 window.postMessage 通信
(function () {
  if (window.__JCE_INJECT__) return;
  window.__JCE_INJECT__ = true;

  var API_BASE = "http://ncepu.jcedutec.cn:8800/jeecg-boot";

  function findToken() {
    // jeecg-boot 常见键; pro__Access-Token 存的是 {"value":"<jwt>","expire":...}
    var keys = ["X-Access-Token", "x_access_token", "pro__Access-Token", "token"];
    for (var i = 0; i < keys.length; i++) {
      var t = unwrapToken(localStorage.getItem(keys[i]));
      if (t) return t;
    }
    // 兜底: 遍历所有键
    for (var j = 0; j < localStorage.length; j++) {
      var k = localStorage.key(j);
      if (/token/i.test(k)) {
        var t2 = unwrapToken(localStorage.getItem(k));
        if (t2) return t2;
      }
    }
    return null;
  }

  function unwrapToken(v) {
    if (typeof v !== "string") return null;
    var s = v;
    if (s.charAt(0) === "{") {
      try { s = String(JSON.parse(s).value || ""); } catch (e) { return null; }
    }
    return (s.split(".").length === 3) ? s : null;
  }

  function reportToken(t) {
    if (t && typeof t === "string" && t.split(".").length === 3) {
      window.postMessage({ type: "JCE_TOKEN", token: t }, "*");
    }
  }

  // ---- hook XHR: 抓最新 token, 保证过期重登后自动跟随 ----
  var origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (/x-access-token/i.test(name)) reportToken(value);
    } catch (e) {}
    return origSetHeader.call(this, name, value);
  };

  // ---- hook fetch ----
  var origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      var h = init && init.headers;
      if (h) {
        if (typeof Headers !== "undefined" && h instanceof Headers) {
          reportToken(h.get("X-Access-Token"));
        } else if (h["X-Access-Token"]) {
          reportToken(h["X-Access-Token"]);
        }
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  // ---- API 代理: content.js 发 JCE_API, 这里用页面自身身份发请求 ----
  window.addEventListener("message", function (ev) {
    if (ev.source !== window) return;
    var d = ev.data;
    if (!d || d.type !== "JCE_API") return;

    (async function () {
      var resp;
      try {
        var token = d.token || findToken() || "";
        var opt = {
          method: d.method,
          headers: {
            "Content-Type": "application/json",
            "X-Access-Token": token,
            "tenant-id": "0"
          }
        };
        if (d.body != null) opt.body = JSON.stringify(d.body);
        var r = await origFetch(API_BASE + d.path, opt);
        resp = await r.json();
      } catch (e) {
        resp = { success: false, message: "网络错误: " + String(e && e.message || e) };
      }
      window.postMessage({ type: "JCE_API_RESULT", seq: d.seq, resp: resp }, "*");
    })();
  });

  // 启动即上报一次已有 token
  setTimeout(function () { reportToken(findToken()); }, 500);
})();
