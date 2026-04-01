const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer'); // full puppeteer

const app = express();
app.use(cors());

// Test endpoint
app.get('/', (req, res) => {
    res.send('Web Renderer is live!');
});

// Fetch and render any URL
app.get('/fetch', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).send('Missing URL');

    try {
        // Launch Puppeteer with no-sandbox (required on Render)
        const browser = await puppeteer.launch({
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        await page.goto(url, { waitUntil: 'networkidle2' }); // wait for page fully loads

        // Get full rendered HTML
        const html = await page.content();

        await browser.close();
        res.send(html);
    } catch (err) {
        console.error(err);
        res.status(500).send('Failed to fetch site');
    }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
