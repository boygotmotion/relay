const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { OCRClient } = require("ya-ocr");
const svg2img = require("svg2img");
const Jimp = require("jimp");
const fs = require("fs");
const path = require("path");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

// --- MAIN ENDPOINT ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        // Step 1: Save the uploaded image to /tmp (Vercel's temp directory)
        const tempPath = `/tmp/upload_${Date.now()}.jpg`;
        fs.writeFileSync(tempPath, req.file.buffer);

        // Step 2: Upload to a temporary public URL (ya-ocr requires URL)
        // Option A: Use a free image hosting service via API
        // Option B: Use your own Vercel endpoint to serve the image
        // For now, we'll use imgbb.com (free, no registration)
        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));
        
        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: formData.getHeaders(),
            params: { key: 'YOUR_IMGBB_API_KEY' } // Get free key from imgbb.com
        });

        const imageUrl = uploadResponse.data.data.url;
        console.log(`📤 Image uploaded to: ${imageUrl}`);

        // Step 3: Run ya-ocr with translation
        const client = new OCRClient({ withTranslate: true });
        const result = await client.scanByUrl(imageUrl);

        console.log(`📝 Extracted: ${result.text.substring(0, 100)}...`);
        console.log(`📝 Translated: ${result.translatedText.substring(0, 100)}...`);

        // Step 4: Convert SVG to image
        const svgData = result.svg;
        const pngBuffer = await new Promise((resolve, reject) => {
            svg2img(svgData, (error, buffer) => {
                if (error) reject(error);
                else resolve(buffer);
            });
        });

        // Step 5: Return the rendered image as base64
        const base64Image = pngBuffer.toString('base64');

        // Step 6: Build the response
        const resRegions = [{
            context: result.text.substring(0, 200),
            tranContent: result.translatedText.substring(0, 200),
            boundingBox: `0,0,${result.width || 800},${result.height || 600}`
        }];

        res.json({
            errorCode: 0,
            render_image: base64Image,
            resRegions: resRegions
        });

    } catch (err) {
        console.error("❌ Error:", err.message);
        console.error("Stack:", err.stack);
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

module.exports = app;
