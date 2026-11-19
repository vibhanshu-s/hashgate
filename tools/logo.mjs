// Renders media/logo.png (512×512) from the app's logo mark.
import { chromium } from "playwright";
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#0a0c0f"/><g transform="translate(3 3) scale(.75)"><rect x="2" y="3" width="20" height="4" rx="1.5" fill="#5eead4"/><rect x="4" y="9" width="4" height="4" rx="1" fill="none" stroke="#5eead4" stroke-width="1.6"/><rect x="4" y="15" width="4" height="4" rx="1" fill="none" stroke="#5eead4" stroke-width="1.6"/><rect x="16" y="9" width="4" height="4" rx="1" fill="none" stroke="#5eead4" stroke-width="1.6"/><rect x="16" y="15" width="4" height="4" rx="1" fill="none" stroke="#5eead4" stroke-width="1.6"/></g></svg>`;
const b = await chromium.launch({ channel: "chrome", headless: true });
const p = await b.newPage({ viewport: { width: 512, height: 512 } });
await p.setContent(`<body style="margin:0">${svg}</body>`);
await p.screenshot({ path: "media/logo.png", omitBackground: true });
await b.close();
