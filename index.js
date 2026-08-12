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
        formData.append('isOverlayRequired', 'true');

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

let fontCache = {};

async function getFont(size, color) {
    const key = `${size}-${color}`;
    if (fontCache[key]) return fontCache[key];
    
    const urls = {
        '16-black': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-16-black/open-sans-16-black.fnt',
        '16-white': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-16-white/open-sans-16-white.fnt',
        '32-black': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-32-black/open-sans-32-black.fnt',
        '32-white': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-32-white/open-sans-32-white.fnt',
        '64-black': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-64-black/open-sans-64-black.fnt',
        '64-white': 'https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-64-white/open-sans-64-white.fnt',
    };
    const url = urls[`${size}-${color}`];
    if (!url) throw new Error(`No font URL for ${size}-${color}`);
    
    try {
        const font = await Jimp.loadFont(url);
        fontCache[key] = font;
        return font;
    } catch (err) {
        throw new Error(`Failed to load font ${size}-${color}: ${err.message}`);
    }
}

async function renderTextOnImage(imageBuffer, regions) {
    const errors = [];
    let image;
    try {
        image = await Jimp.read(imageBuffer);
    } catch (err) {
        return { renderedBuffer: null, errors: [err.message] };
    }

    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        if (w <= 0 || h <= 0) continue;

        const actualW = Math.min(x + w, image.bitmap.width) - x;
        const actualH = Math.min(y + h, image.bitmap.height) - y;

        try {
            // Sampling background for the fill
            let avgR = 0, avgG = 0, avgB = 0;
            const idx = (Math.floor(y + actualH / 2) * image.bitmap.width + Math.floor(x + actualW / 2)) * 4;
            avgR = image.bitmap.data[idx];
            avgG = image.bitmap.data[idx+1];
            avgB = image.bitmap.data[idx+2];

            // Clean background fill
            image.scan(x, y, actualW, actualH, function(px, py, idx) {
                this.bitmap.data[idx + 0] = avgR;
                this.bitmap.data[idx + 1] = avgG;
                this.bitmap.data[idx + 2] = avgB;
                this.bitmap.data[idx + 3] = 255;
            });

            let text = region.tranContent || '';
            if (!text) continue;

            // --- FONT SELECTION & CLUSTERING FIX ---
            let size = 16;
            if (actualH > 70) size = 64;
            else if (actualH > 35) size = 32;

            const charWidth = size * 0.52;
            const lineHeight = size * 1.25;
            const maxLines = Math.floor(actualH / lineHeight) || 1;

            let lines = [];
            
            // If height only allows 1 line, DO NOT WRAP (Prevents Clustering/Overlap)
            if (maxLines === 1) {
                const maxChars = Math.floor((actualW - 10) / charWidth);
                if (text.length > maxChars) {
                    text = text.substring(0, Math.max(0, maxChars - 3)) + "...";
                }
                lines = [text];
            } else {
                // Multi-line word wrap logic
                const words = text.split(' ');
                let currentLine = '';
                for (const word of words) {
                    const testLine = currentLine ? currentLine + ' ' + word : word;
                    if (testLine.length * charWidth < actualW - 10) {
                        currentLine = testLine;
                    } else {
                        lines.push(currentLine);
                        currentLine = word;
                    }
                }
                if (currentLine) lines.push(currentLine);
                
                // Truncate vertically if too many lines
                if (lines.length > maxLines) {
                    lines = lines.slice(0, maxLines);
                    lines[lines.length - 1] += "...";
                }
            }

            const brightness = (avgR * 0.299 + avgG * 0.587 + avgB * 0.114);
            const color = brightness > 128 ? 'black' : 'white';
            const font = await getFont(size, color);

            const totalTextHeight = lines.length * lineHeight;
            const startY = y + (actualH - totalTextHeight) / 2;

            for (let li = 0; li < lines.length; li++) {
                const line = lines[li];
                const lineWidth = line.length * charWidth;
                const startX = x + (actualW - lineWidth) / 2;
                image.print(font, startX, startY + (li * lineHeight), line);
            }

        } catch (err) {
            errors.push(`Error in region ${i}: ${err.message}`);
        }
    }

    const renderedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
    return { renderedBuffer, errors };
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const ocrResult = await extractTextWithOCR(req.file.buffer);
        if (!ocrResult || !ocrResult.text) {
            return res.json({ errorCode: 0, render_image: req.file.buffer.toString('base64'), resRegions: [] });
        }

        const resRegions = [];
        for (const line of ocrResult.lines) {
            const srcText = line.LineText.trim();
            if (!srcText) continue;

            const dstText = (await translateWithGoogle(srcText, fromRequested, toRequested)) || srcText;
            
            if (line.Words && line.Words.length > 0) {
                const firstWord = line.Words[0];
                const lastWord = line.Words[line.Words.length - 1];
                const x = firstWord.Left;
                const y = firstWord.Top;
                const w = (lastWord.Left + lastWord.Width) - firstWord.Left;
                const h = Math.max(...line.Words.map(w => w.Height));

                resRegions.push({
                    context: srcText,
                    tranContent: dstText,
                    boundingBox: `${Math.round(x)},${Math.round(y)},${Math.round(w)},${Math.round(h)}`
                });
            }
        }

        const { renderedBuffer } = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({
            errorCode: 0,
            render_image: renderedBuffer.toString('base64'),
            resRegions: resRegions
        });

    } catch (err) {
        res.json({ errorCode: 1, msg: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Relay running on port ${PORT}`));

export default app;
