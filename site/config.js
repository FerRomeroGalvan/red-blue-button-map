// Site settings. Edit these, then deploy.
window.APP_CONFIG = {
  // URL of your Cloudflare Worker, e.g. "https://red-blue-api.yourname.workers.dev".
  // Leave empty to run on mock data (no backend needed).
  API_BASE: "https://red-blue-api.fernando-romerogalvan.workers.dev",

  // Counties or states with fewer votes than this are shown as "not enough data".
  MIN_VOTES: 5,

  // Your Ko-fi / Buy Me a Coffee / GitHub Sponsors link.
  SUPPORT_URL: "https://buymeacoffee.com/fernandoromerogalvan",

  // The address people share, e.g. "https://redbluebutton.pages.dev".
  // Leave empty to use whatever address the page is opened at.
  SITE_URL: "https://pressredorblue.com",

  // Map geometry (US counties + states, from the us-atlas package).
  TOPOJSON_URL: "https://cdn.jsdelivr.net/npm/us-atlas@3/counties-10m.json",
};
