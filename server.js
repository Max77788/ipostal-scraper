import express from "express";
import archiver from "archiver";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";

dotenv.config();

puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

const USERNAME = process.env.USERNAME_APP;
const PASSWORD = process.env.PASSWORD_APP;
const LOGIN_URL = "https://my.ipostal1.com/login";

if (!USERNAME || !PASSWORD) {
  throw new Error("Missing USERNAME or PASSWORD env vars");
}

/* ---------- UTILS ---------- */

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function getTodayString() {
  const d = new Date();
  const day = String(d.getDate()).padStart(2, "0");

  const months = [
    "Jan","Feb","Mar","Apr","May","Jun",
    "Jul","Aug","Sep","Oct","Nov","Dec"
  ];

  // return "17-Mar-2026";
  return `${day}-${months[d.getMonth()]}-${d.getFullYear()}`;
}

async function typeLikeHuman(page, selector, text) {
  await page.waitForSelector(selector, { visible: true });

  const input = await page.$(selector);

  await input.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");

  await sleep(400);

  await page.type(selector, String(text), {
    delay: 80 + Math.random() * 120
  });

  await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, selector);
}

/* ---------- CORE SCRAPER ---------- */

async function scrapeMailbox(page, archive) {

  // Use domcontentloaded -- networkidle2 never fires behind Cloudflare
  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30000 });

  // Cloudflare challenge — wait for it to resolve before looking for #username
  await page.waitForFunction(() => {
    const title = document.querySelector("title");
    return title && !title.textContent.includes("Just a moment");
  }, { timeout: 30000 }).catch(() => {
    console.log("Cloudflare check timed out, proceeding anyway");
  });

  // Extra safety: wait for any form field to appear (page fully mounted)
  await page.waitForSelector("input", { timeout: 15000 }).catch(() => {});

  await typeLikeHuman(page, "#username", USERNAME);
  await typeLikeHuman(page, "#password", PASSWORD);

  await page.click("#login_btn");

  // Wait for navigation from my.ipostal1.com/login to portal.ipostal1.com
  await page.waitForFunction(() => {
    return window.location.hostname.includes("portal.ipostal1.com");
  }, { timeout: 30000 });

  console.log("Mailbox loaded —", page.url());

  // Check if any mail-item cards exist (inbox might be empty)
  const cards = await page.$$("article.mail-item-card");

  if (cards.length === 0) {
    console.log("No mail items in inbox — returning empty ZIP");
    archive.append("No mail items found for today.", { name: "empty.txt" });
    return;
  }

  const today = getTodayString();

  for (const card of cards) {

    const received = await card.$eval(
      ".received-date",
      el => el.innerText.trim()
    ).catch(() => null);

    if (!received || !received.includes(today)) continue;

    const id = await page.evaluate(el => el.id, card);

    const src = await card.$eval(
      "img.item-img",
      el => el.src
    ).catch(() => null);

    if (!src) continue;

    try {
      // 🔥 fetch INSIDE browser to keep session (fixes 403)
      const bufferArray = await page.evaluate(async (url) => {
        const res = await fetch(url, {
          credentials: "include"
        });

        if (!res.ok) {
          throw new Error("Fetch failed: " + res.status);
        }

        const blob = await res.blob();
        const arrayBuffer = await blob.arrayBuffer();

        return Array.from(new Uint8Array(arrayBuffer));
      }, src);

      const buffer = Buffer.from(bufferArray);

      archive.append(buffer, { name: `${id}.jpg` });

      console.log("Downloaded:", id);

    } catch (err) {
      console.log("Failed:", id, err.message);
    }
  }
}

/* ---------- API ROUTE ---------- */

app.get("/mailbox", async (req, res) => {

  let browser;

  try {

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      "attachment; filename=mailbox_today.zip"
    );

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.pipe(res);

    const chromePath = process.env.PUPPETEER_EXECUTABLE_PATH
      || "/mnt/HC_Volume_105739285/playwright/chromium-1223/chrome-linux/chrome";

    browser = await puppeteer.launch({
      headless: "new",
      executablePath: chromePath,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-gpu"
      ]
    });

    const page = await browser.newPage();

    await page.setViewport({ width: 1366, height: 768 });

    await scrapeMailbox(page, archive);

    await archive.finalize();

  } catch (err) {

    console.error(err);

    if (!res.headersSent) {
      res.status(500).send(err.toString());
    }

  } finally {

    if (browser) await browser.close();
  }

});

/* ---------- START SERVER ---------- */

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port", PORT);
});