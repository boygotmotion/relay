import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import Jimp from "jimp";

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
        formData.append('scale', 'true');
        formData.append('isOverlayRequired', 'true'); // Get word-level coordinates

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 15000
        });

        if (response.data && response.data.OCRExitCode === 1) {
            const result = response.data.ParsedResults[0];
            return {
                text: result.ParsedText.trim(),
                lines: result.TextOverlay ? result.TextOverlay.Lines : []
            };
        }
        return null;
    } catch (e) {
        console.error('OCR Exception:', e.message);
        return null;
    }
}

async function renderTextOnImage(imageBuffer, regions) {
    try {
        const image = await Jimp.read(imageBuffer);
        for (const region of regions) {
            const [x, y, w, h] = region.boundingBox.split(',').map(Number);
            // White background for text
            image.scan(x, y, w, h, function(px, py, idx) {
                this.bitmap.data[idx + 0] = 255;
                this.bitmap.data[idx + 1] = 255;
                this.bitmap.data[idx + 2] = 255;
                this.bitmap.data[idx + 3] = 220;
            });
            // Draw translated text with built-in bitmap font
            const font = Jimp.FONT_SANS_16_BLACK;
            const text = region.tranContent;
            // Wrap text to fit width
            const maxWidth = w - 10;
            const lines = [];
            let currentLine = '';
            const words = text.split(' ');
            for (const word of words) {
                if ((currentLine + ' ' + word).length * 8 < maxWidth) {
                    currentLine += (currentLine ? ' ' : '') + word;
                } else {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);
            let lineY = y + 5;
            for (const line of lines) {
                image.print(font, x + 5, lineY, line);
                lineY += 20;
            }
        }
        return await image.getBufferAsync(Jimp.MIME_JPEG);
    } catch (err) {
        console.error('Render error:', err.message);
        return null;
    }
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const originalBase64 = req.file.buffer.toString('base64');

        console.log('🔍 Running OCR...');
        const ocrResult = await extractTextWithOCR(req.file.buffer);
        
        if (!ocrResult || !ocrResult.text) {
            return res.json({
                errorCode: 1,
                msg: "No text found in image",
                render_image: originalBase64,
                resRegions: []
            });
        }

        console.log(`📝 Extracted: ${ocrResult.text.substring(0, 100)}...`);

        // Build resRegions with translated text and coords
        const resRegions = [];
        for (const line of ocrResult.lines) {
            const srcText = line.LineText.trim();
            if (!srcText) continue;

            const dstText = (await translateWithGoogle(srcText, fromRequested, toRequested)) || srcText;
            
            if (line.Words && line.Words.length > 0) {
                const firstWord = line.Words[0];
                const lastWord = line.Words[line.Words.length - 1];
                const x = Math.round(firstWord.Left);
                const y = Math.round(firstWord.Top);
                const w = Math.round(lastWord.Left + lastWord.Width - firstWord.Left);
                const h = Math.round(Math.max(...line.Words.map(w => w.Top + w.Height)) - y);

                resRegions.push({
                    context: srcText,
                    tranContent: dstText,
                    boundingBox: `${x},${y},${w},${h}`
                });
            }
        }

        // Fallback if no coords
        if (resRegions.length === 0 && ocrResult.text) {
            const dstText = (await translateWithGoogle(ocrResult.text, fromRequested, toRequested)) || ocrResult.text;
            resRegions.push({
                context: ocrResult.text,
                tranContent: dstText,
                boundingBox: `0,0,800,100`
            });
        }

        // Render translated text on image using Jimp
        console.log('🖌️ Rendering text on image...');
        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        let renderImageBase64;
        if (renderedBuffer) {
            renderImageBase64 = renderedBuffer.toString('base64');
            console.log('✅ Image rendered successfully');
        } else {
            // Fallback: return original image (Image-to-Text mode)
            console.warn('⚠️ Rendering failed, returning original image with resRegions');
            renderImageBase64 = originalBase64;
        }

        res.json({
            errorCode: 0,
            render_image: renderImageBase64,
            resRegions: resRegions
        });

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

export default app;
