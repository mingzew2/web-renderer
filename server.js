// server.js
const express = require("express");
const puppeteer = require("puppeteer");
const cors = require("cors");

const app = express();
app.use(cors());

app.get("/render", async (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).send("Missing url param");

  let browser;
  try {
    // Puppeteer launch for Render free tier
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const page = await browser.newPage();

    // Prevent sites from blocking headless browsers
    await page.setUserAgent(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/112.0.0.0 Safari/537.36"
    );

    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    const html = await page.content();
    res.send(html);
  } catch (err) {
    console.error("Render backend error:", err);
    res.status(500).send("Failed to render page");
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
