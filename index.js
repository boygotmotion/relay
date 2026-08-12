const express = require("express");
const axios = require("axios");
const multer = require("multer");
const { OCRClient } = require("ya-ocr");
const { Converter } = require("svg-to-png");
const FormData = require("form-data");
const fs = require("fs");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const converter = new Converter();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        // Upload to imgbb (free, no registration)
        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));

        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: formData.getHeaders(),
            params: { key: '3d82321f5628ca768792c1c1d0297ca3' } // Get free key from imgbb.com
        });

        const imageUrl = uploadResponse.data.data.url;
        console.log(`📤 Image uploaded to: ${imageUrl}`);

        // Run ya-ocr
        const client = new OCRClient({ withTranslate: true });
        const result = await client.scanByUrl(imageUrl);

        console.log(`📝 Extracted: ${result.text.substring(0, 100)}...`);
        console.log(`📝 Translated: ${result.translatedText.substring(0, 100)}...`);

        // Convert SVG to PNG
        const pngBuffer = await converter.convert(result.svg);

        // Return the rendered image
        const base64Image = pngBuffer.toString('base64');

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
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

module.exports = app;
