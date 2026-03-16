import express from "express";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import dotenv from "dotenv";

dotenv.config();
puppeteer.use(StealthPlugin());

const app = express();
const PORT = process.env.PORT || 8080;

const USERNAME = process.env.USERNAME;
const PASSWORD = process.env.PASSWORD;
const LOGIN_URL = "https://my.ipostal1.com/login";
const MAX_RETRIES = 5;

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function slowType(page, selector, text) {
  await page.focus(selector);

  for (const char of text) {
    await page.keyboard.type(char);
    await sleep(60 + Math.random() * 140);
  }
}

async function scrapeMailbox() {

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
  );

  await page.setViewport({ width: 1366, height: 768 });

  await page.setExtraHTTPHeaders({
    "accept-language": "en-US,en;q=0.9"
  });

  await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });

  let loggedIn = false;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {

    const usernameField = await page.$("#username");

    if (!usernameField) {
      loggedIn = true;
      break;
    }

    await page.click("#username", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await slowType(page, "#username", USERNAME);

    await page.click("#password", { clickCount: 3 });
    await page.keyboard.press("Backspace");
    await slowType(page, "#password", PASSWORD);

    await page.click("#login_btn");

    try {
      await page.waitForSelector("article.mail-item-card", { timeout: 10000 });
      loggedIn = true;
      break;
    } catch {
      await sleep(3000);
    }
  }

  if (!loggedIn) {
    await browser.close();
    throw new Error("Login failed");
  }

  await page.waitForSelector("article.mail-item-card");

  const items = await page.evaluate(() => {
    return [...document.querySelectorAll("article.mail-item-card")]
      .map(el => ({
        id: el.id,
        type: el.querySelector(".item_type_name")?.innerText,
        received: el.querySelector(".received-date")?.innerText,
        expires: el.querySelector(".storage-expiry-date")?.innerText,
        image: el.querySelector("img.item-img")?.src
      }));
  });

  await browser.close();

  return items;
}

app.get("/mailbox", async (req, res) => {

  try {

    const items = await scrapeMailbox();

    res.json({
      success: true,
      items
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      success: false,
      error: err.message
    });

  }

});

app.get("/", (req, res) => {
  res.send("iPostal scraper running");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});