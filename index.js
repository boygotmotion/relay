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

// --- OCR with OCR.space (Free, no registration) ---
async function extractTextWithOCR(imageBuffer) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); // Free OCR.space API key
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', 'eng');
        formData.append('OCREngine', '2'); // Engine 2 is more accurate

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 15000
        });

        if (response.data && response.data.OCRExitCode === 1) {
            const parsedText = response.data.ParsedResults[0].ParsedText;
            return parsedText.trim();
        } else if (response.data && response.data.ErrorMessage) {
            console.error('OCR Error:', response.data.ErrorMessage);
            return null;
        }
        return null;
    } catch (e) {
        console.error('OCR Exception:', e.message);
        return null;
    }
}

// --- MAIN ENDPOINT (Image-to-Image) ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const image = await Jimp.read(req.file.buffer);
        const width = image.bitmap.width;
        const height = image.bitmap.height;

        // Step 1: OCR - Extract text from image
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
        
        console.log(`📝 Extracted text: ${extractedText.substring(0, 100)}...`);

        // Step 2: Translate the extracted text
        const dstText = (await translateWithGoogle(extractedText, fromRequested, toRequested)) || extractedText;
        console.log(`📝 Translated text: ${dstText.substring(0, 100)}...`);

        // Step 3: Render translated text on the image
        const padding = 20;
        const x = padding;
        const y = padding;
        const maxWidth = width - (padding * 2);
        const textBgHeight = Math.min(120, height - (padding * 2));

        // Paint white background box for readability
        image.scan(x, y, maxWidth, textBgHeight, function(px, py, idx) {
            this.bitmap.data[idx + 0] = 255;
            this.bitmap.data[idx + 1] = 255;
            this.bitmap.data[idx + 2] = 255;
            this.bitmap.data[idx + 3] = 200;
        });

        // Draw translated text
        const font = await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK);
        const wrappedText = Jimp.wrapText(font, dstText, maxWidth - 20);
        image.print(font, x + 10, y + 10, wrappedText, maxWidth - 20, textBgHeight - 20);

        // Step 4: Return rendered image
        const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        const base64Image = imageBuffer.toString("base64");

        const resRegions = [{
            context: extractedText.substring(0, 200),
            tranContent: dstText.substring(0, 200),
            boundingBox: `${x},${y},${maxWidth},${textBgHeight}`
        }];

        console.log(`📤 Sending response with rendered image`);

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
