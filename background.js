// background.js — 仅负责角标(进度徽章)展示
chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== "local" || !changes.jce_state) return;
  var st = changes.jce_state.newValue || {};
  if (st.running) {
    var txt = st.total ? (st.finished + "/" + st.total) : "run";
    if (txt.length > 4) txt = st.finished + "";
    chrome.action.setBadgeText({ text: txt });
    chrome.action.setBadgeBackgroundColor({ color: "#e74c3c" });
  } else if (st.status === "done") {
    chrome.action.setBadgeText({ text: "OK" });
    chrome.action.setBadgeBackgroundColor({ color: "#27ae60" });
  } else {
    chrome.action.setBadgeText({ text: "" });
  }
});
