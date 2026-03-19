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

  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

  await typeLikeHuman(page, "#username", USERNAME);
  await typeLikeHuman(page, "#password", PASSWORD);

  await page.click("#login_btn");

  await page.waitForSelector("article.mail-item-card", {
    timeout: 120000
  });

  console.log("Mailbox loaded");

  const today = getTodayString();

  const cards = await page.$$("article.mail-item-card");

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

    browser = await puppeteer.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage"
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