const express = require("express");
const axios = require("axios");
const multer = require("multer");
const Jimp = require("jimp");
const FormData = require("form-data");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

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

async function extractTextWithOCR(imageBuffer) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld');
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', 'eng');
        formData.append('OCREngine', '2');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 15000
        });

        if (response.data && response.data.OCRExitCode === 1) {
            return response.data.ParsedResults[0].ParsedText.trim();
        }
        return null;
    } catch (e) {
        console.error('OCR Exception:', e.message);
        return null;
    }
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const image = await Jimp.read(req.file.buffer);
        const width = image.bitmap.width;
        const height = image.bitmap.height;

        console.log('🔍 Running OCR...');
        const extractedText = await extractTextWithOCR(req.file.buffer);
        
        if (!extractedText) {
            return res.json({ 
                errorCode: 1, 
                msg: "No text found in image",
                render_image: req.file.buffer.toString("base64"),
                resRegions: []
            });
        }
        
        console.log(`📝 Extracted: ${extractedText.substring(0, 100)}...`);

        const dstText = (await translateWithGoogle(extractedText, fromRequested, toRequested)) || extractedText;
        console.log(`📝 Translated: ${dstText.substring(0, 100)}...`);

        const padding = 20;
        const x = padding;
        const y = padding;
        const maxWidth = width - (padding * 2);
        const textBgHeight = Math.min(120, height - (padding * 2));

        // Paint white background
        image.scan(x, y, maxWidth, textBgHeight, function(px, py, idx) {
            this.bitmap.data[idx + 0] = 255;
            this.bitmap.data[idx + 1] = 255;
            this.bitmap.data[idx + 2] = 255;
            this.bitmap.data[idx + 3] = 200;
        });

        // ✅ FIX: Use Jimp's built-in font (FONT_SANS_32_BLACK is available)
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
        
        // Split text into lines manually if wrapText fails
        const maxCharsPerLine = Math.floor((maxWidth - 20) / 16);
        const lines = [];
        let currentLine = '';
        const words = dstText.split(' ');
        for (const word of words) {
            if ((currentLine + ' ' + word).length <= maxCharsPerLine) {
                currentLine += (currentLine ? ' ' : '') + word;
            } else {
                if (currentLine) lines.push(currentLine);
                currentLine = word;
            }
        }
        if (currentLine) lines.push(currentLine);

        // Draw each line
        const lineHeight = 36;
        let currentY = y + 10;
        for (const line of lines) {
            if (currentY + lineHeight > y + textBgHeight - 10) break;
            image.print(font, x + 10, currentY, line, maxWidth - 20, lineHeight);
            currentY += lineHeight;
        }

        const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        const base64Image = imageBuffer.toString("base64");

        const resRegions = [{
            context: extractedText.substring(0, 200),
            tranContent: dstText.substring(0, 200),
            boundingBox: `${x},${y},${maxWidth},${textBgHeight}`
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
