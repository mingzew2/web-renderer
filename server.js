const express = require("express");
const cors = require("cors");
const puppeteer = require("puppeteer");

const app = express();
app.use(cors());

app.get("/render", async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: "new",
            args: ["--no-sandbox", "--disable-setuid-sandbox"]
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

        const html = await page.content();
        res.send(html);

    } catch (e) {
        console.error(e);
        res.status(500).send("Error loading page");
    } finally {
        if (browser) await browser.close();
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
