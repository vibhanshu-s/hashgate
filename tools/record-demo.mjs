// Records the demo video against the live site with narration, and prints the pitch deck to PDF.
// Output: media/hashgate-demo.mp4, media/hashgate-deck.pdf, media/poster.png
// Needs: Chrome installed, FFMPEG (path to an ffmpeg binary). Usage: node tools/record-demo.mjs
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

const SITE = process.env.SITE ?? "https://hashgate-three.vercel.app";
const FF = process.env.FFMPEG ?? "ffmpeg";
const OUT = path.resolve("media");
const TMP = path.join(OUT, "tmp");
fs.mkdirSync(TMP, { recursive: true });

const LINES = {
  hook: "On Q-Day, a quantum computer can forge any E-C-D-S-A signature, including the key your AI agent spends with. Hashgate gives agents a post-quantum E-R-C forty-three thirty-seven smart account on QDay Aevum, where every user operation is signed with hash-based keys instead.",
  vault: "No wallet needed. The browser derives thirty-two one-time Winternitz keys, and a factory deploys a smart account owned by their Merkle root. There is no E-C-D-S-A owner at all.",
  session: "The owner gives the agent a scoped session: two cents per payment, four cents in total, twenty-four hours, and three approved vendors. The owner signs this user operation with one one-time key, it goes through QDay's own bundler, and our paymaster sponsors the gas.",
  agent: "Now the agent reads the inbox with Gemini. We tell it to behave as if it's compromised, so it obeys instructions hidden inside invoices. Two invoices are paid, each user operation signed with a fresh one-time key. The over-cap invoice is refused. And the hidden instruction to pay an attacker is refused too: payee not allowed.",
  proof: "The bundler would never include that payment. Pushed straight into the entry point anyway, it reverts on-chain, with the account's own error.",
  drill: "Now assume Q-Day has arrived, and the attacker holds every E-C-D-S-A key in the system. A forged withdrawal fails the signature check. Replaying a real agent operation fails: that one-time key is spent. And one owner operation revokes the agent, instantly.",
  close: "Every step is a real user operation on Aevum testnet, through QDay's bundler. The account, paymaster, SDK and agent are open source. Hashgate. The agent can ask. Only a hash chain can pay.",
};

async function speak(text) {
  for (let attempt = 1; ; attempt++) {
    try {
      const tts = new MsEdgeTTS();
      await tts.setMetadata("en-US-AndrewNeural", OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const { audioStream } = tts.toStream(text);
      const chunks = [];
      await new Promise((res, rej) => {
        audioStream.on("data", (d) => chunks.push(d));
        audioStream.on("end", res);
        audioStream.on("error", rej);
      });
      tts.close?.();
      return Buffer.concat(chunks);
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function narrate() {
  for (const [k, text] of Object.entries(LINES)) {
    const file = path.join(TMP, `${k}.mp3`);
    if (fs.existsSync(file) && fs.statSync(file).size > 1000) continue;
    fs.writeFileSync(file, await speak(text));
  }
}

function durationMs(file) {
  let log = "";
  try { execFileSync(FF, ["-i", file], { stdio: ["ignore", "pipe", "pipe"] }); } catch (e) { log = String(e.stderr ?? ""); }
  const m = log.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
  if (!m) throw new Error(`no duration for ${file}`);
  return (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) * 1000;
}

const CAPTION = `(t) => {
  let el = document.getElementById("__cap");
  if (!el) {
    el = document.createElement("div");
    el.id = "__cap";
    el.style.cssText = "position:fixed;left:50%;bottom:18px;transform:translateX(-50%);max-width:1100px;width:max-content;z-index:99999;background:rgba(5,7,10,.92);color:#e8edf2;border:1px solid #2c3540;padding:10px 18px;border-radius:10px;font:500 19px/1.4 Inter,system-ui,sans-serif;text-align:center";
    document.body.appendChild(el);
  }
  el.textContent = t;
  el.style.display = t ? "block" : "none";
}`;

const scenes = [];
let videoStart = 0;
let t0 = 0;
async function say(page, scene) {
  scenes.push({ scene, at: Date.now() - videoStart });
  await page.evaluate(`(${CAPTION})(${JSON.stringify(LINES[scene])})`);
  t0 = Date.now();
}
async function finish(page, scene, extra = 400) {
  const left = durationMs(path.join(TMP, `${scene}.mp3`)) - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  await page.waitForTimeout(extra);
}
const btn = (page, name) => page.getByRole("button", { name, exact: false }).first();
const smooth = (page, sel) => page.evaluate((s) => {
  const el = document.querySelector(s);
  if (el) scrollTo({ top: el.getBoundingClientRect().top + scrollY - 80, behavior: "smooth" });
}, sel);
const idle = (page, ms = 120_000) => page.waitForFunction(() => !document.querySelector("main .spinner"), null, { timeout: ms, polling: 300 });

async function record() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, recordVideo: { dir: TMP, size: { width: 1280, height: 720 } } });
  const page = await context.newPage();
  videoStart = Date.now();
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1200);

  await say(page, "hook");
  await page.waitForTimeout(6000);
  await page.evaluate(() => scrollTo({ top: 640, behavior: "smooth" }));
  await finish(page, "hook");

  await page.goto(`${SITE}/console`, { waitUntil: "networkidle" });
  await page.waitForTimeout(600);
  await say(page, "vault");
  await btn(page, "Create my account").click();
  await page.getByText("Account balance").waitFor({ timeout: 60_000 });
  await idle(page);
  await page.locator("aside").getByText(/Demo treasury sent|No demo funds/).first().waitFor({ timeout: 60_000 });
  await finish(page, "vault");

  await smooth(page, "main section:nth-of-type(2)");
  await page.waitForTimeout(700);
  await say(page, "session");
  await btn(page, "Sign & open session").click();
  await page.locator("aside").getByText("Agent session opened").waitFor({ timeout: 60_000 });
  await finish(page, "session");

  await smooth(page, "main section:nth-of-type(3)");
  await page.waitForTimeout(700);
  await say(page, "agent");
  await btn(page, "Run the agent").click();
  await page.waitForTimeout(1500);
  await idle(page);
  await page.evaluate(() => {
    const el = document.querySelector("[aria-live=polite]");
    if (el) scrollTo({ top: el.getBoundingClientRect().top + scrollY - 140, behavior: "smooth" });
  });
  await finish(page, "agent", 1500);

  await say(page, "proof");
  await page.getByRole("button", { name: "sign & record this refusal on-chain" }).last().click();
  await page.locator("aside").getByText("Refusal recorded on-chain").waitFor({ timeout: 60_000 });
  const href = await page.locator("aside li", { hasText: "Refusal recorded on-chain" }).locator("a").first().getAttribute("href");
  await page.waitForTimeout(800);
  await page.goto(href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  await page.evaluate(`(${CAPTION})(${JSON.stringify(LINES.proof)})`);
  await page.getByText(/FailedOpWithRevert|execution reverted|Error/).first().waitFor({ timeout: 20_000 }).catch(() => null);
  await page.evaluate(() => scrollTo({ top: 260, behavior: "smooth" }));
  await finish(page, "proof", 2500);

  await page.goBack({ waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  await smooth(page, "main section:nth-of-type(4)");
  await page.waitForTimeout(700);
  await say(page, "drill");
  await btn(page, "Run the attack").click();
  await page.getByText(/^Withdrawal:/).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  await btn(page, "Revoke current session").click();
  await page.locator("aside").getByText("Session revoked").first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(600);
  await btn(page, "Run the agent").click();
  await page.waitForTimeout(1500);
  await idle(page);
  await page.evaluate(() => {
    const el = document.querySelector("[aria-live=polite]");
    if (el) scrollTo({ top: el.getBoundingClientRect().top + scrollY - 140, behavior: "smooth" });
  });
  await finish(page, "drill", 1500);

  await page.goto(`${SITE}/activity`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await say(page, "close");
  await page.waitForTimeout(5000);
  await page.goto(SITE, { waitUntil: "networkidle" });
  await finish(page, "close", 1500);

  const video = page.video();
  await context.close();
  await browser.close();
  return video.path();
}

function assemble(webm) {
  const TRIM_MS = Math.max(0, scenes[0].at - 800);
  const inputs = ["-ss", String(TRIM_MS / 1000), "-i", webm];
  const filters = [];
  scenes.forEach((s, i) => {
    inputs.push("-i", path.join(TMP, `${s.scene}.mp3`));
    const at = Math.round(s.at - TRIM_MS);
    filters.push(`[${i + 1}:a]adelay=${at}|${at}[a${i}]`);
  });
  const mix = `${scenes.map((_, i) => `[a${i}]`).join("")}amix=inputs=${scenes.length}:normalize=0[a]`;
  execFileSync(FF, ["-y", ...inputs, "-filter_complex", [...filters, mix].join(";"), "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-crf", "24", "-preset", "medium", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "96k",
    "-movflags", "+faststart", path.join(OUT, "hashgate-demo.mp4")], { stdio: "pipe" });
}

async function stills() {
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${SITE}/deck`, { waitUntil: "networkidle" });
  await page.emulateMedia({ media: "print" });
  await page.pdf({ path: path.join(OUT, "hashgate-deck.pdf"), width: "1280px", height: "720px", printBackground: true });
  await page.emulateMedia({ media: "screen" });
  await page.goto(SITE, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT, "poster.png") });
  await browser.close();
}

const only = process.argv[2];
await narrate();
if (!only || only === "stills") await stills();
if (!only || only === "video") {
  const webm = await record();
  assemble(webm);
  console.log(scenes);
  console.log("video bytes", fs.statSync(path.join(OUT, "hashgate-demo.mp4")).size, "duration ms", durationMs(path.join(OUT, "hashgate-demo.mp4")));
}
