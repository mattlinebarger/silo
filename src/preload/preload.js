const { ipcRenderer } = require("electron");

// Preload script for content views (Google apps)
// Gmail only: watch the document title for the unread count and report it to
// the main process for the dock badge. Title looks like:
//   "Inbox (3) - user@example.com - Gmail"
// Title-watching is far more stable than scraping Gmail's DOM.

if (location.hostname === "mail.google.com") {
  let lastCount = null;

  function reportUnreadFromTitle() {
    const match = document.title.match(/\((\d[\d,.]*)\)/);
    const count = match ? parseInt(match[1].replace(/[,.]/g, ""), 10) : 0;
    if (count !== lastCount) {
      lastCount = count;
      ipcRenderer.send("unread-count", count);
    }
  }

  window.addEventListener("DOMContentLoaded", () => {
    const titleEl = document.querySelector("title");
    if (titleEl) {
      new MutationObserver(reportUnreadFromTitle).observe(titleEl, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
    // Fallback poll in case Gmail replaces the <title> element entirely
    setInterval(reportUnreadFromTitle, 15000);
    reportUnreadFromTitle();
  });
}
