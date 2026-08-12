const express = require("express");
const axios = require("axios");
const multer = require("multer");
const Jimp = require("jimp");
const ocrad = require("ocrad.js");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

// --- UTILS ---
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "de": "de", "th": "th", "it": "it", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

async function translateWithGoogle(txt, f, t) {
    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 4000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return null;
    } catch (e) { return null; }
}

// --- MAIN ENDPOINT ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const image = await Jimp.read(req.file.buffer);
        
        // Convert image to grayscale for better OCR
        const grayImage = image.clone().grayscale();
        
        // Get image buffer as PNG (ocrad.js works with PNG)
        const pngBuffer = await grayImage.getBufferAsync(Jimp.MIME_PNG);
        
        // ✅ OCRAD.js — pure JavaScript OCR
        const result = ocrad(pngBuffer);
        
        console.log(`📝 OCR Result: ${result}`);

        const resRegions = [];
        
        // ocrad.js returns plain text, no coordinates
        // So we use the entire image as one region
        const srcText = result.trim();
        if (srcText.length > 0) {
            const dstText = (await translateWithGoogle(srcText, fromRequested, toRequested)) || srcText;

            resRegions.push({
                context: srcText,
                tranContent: dstText,
                boundingBox: `0,0,${image.bitmap.width},${image.bitmap.height}`
            });
        }

        const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);

        res.json({
            errorCode: 0,
            render_image: imageBuffer.toString("base64"),
            resRegions: resRegions
        });

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

module.exports = app;
