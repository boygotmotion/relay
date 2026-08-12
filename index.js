import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import { createCanvas, loadImage, registerFont } from "canvas";
import fs from "fs";
import path from "path";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

// =============================================
// 1. FONT MANAGEMENT (download from GitHub on startup)
// =============================================
const FONT_SOURCES = {
    'zh': { family: 'NotoSansSC', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/SimplifiedChinese/NotoSansSC-Regular.otf' },
    'ja': { family: 'NotoSansJP', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/Japanese/NotoSansJP-Regular.otf' },
    'ko': { family: 'NotoSansKR', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/Korean/NotoSansKR-Regular.otf' },
    'ar': { family: 'NotoNaskhArabic', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf' },
    'th': { family: 'NotoSansThai', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansthai/NotoSansThai%5Bwght%5D.ttf' },
};

const fontCache = new Map();

async function downloadAndRegisterFont(lang) {
    const source = FONT_SOURCES[lang];
    if (!source) return null;
    if (fontCache.has(source.family)) return source.family;

    try {
        const response = await axios.get(source.url, { responseType: 'arraybuffer' });
        const fontData = Buffer.from(response.data);
        const tmpPath = path.join('/tmp', `${source.family}.otf`);
        fs.writeFileSync(tmpPath, fontData);
        registerFont(tmpPath, { family: source.family });
        fontCache.set(source.family, tmpPath);
        console.log(`✅ Font registered: ${source.family}`);
        return source.family;
    } catch (err) {
        console.error(`❌ Failed to download/register ${source.family}: ${err.message}`);
        return null;
    }
}

// Pre‑download all fonts at startup (cold start will take a bit longer)
(async () => {
    const langs = Object.keys(FONT_SOURCES);
    await Promise.all(langs.map(downloadAndRegisterFont));
    console.log('🎯 All fonts ready');
})();

function getFontFamily(lang) {
    const map = {
        'zh': 'NotoSansSC',
        'ja': 'NotoSansJP',
        'ko': 'NotoSansKR',
        'ar': 'NotoNaskhArabic',
        'th': 'NotoSansThai',
        'fr': 'Arial',
        'es': 'Arial',
        'de': 'Arial',
        'it': 'Arial',
        'id': 'Arial',
        'en': 'Arial'
    };
    return map[lang] || 'Arial';
}

// =============================================
// 2. LANGUAGE UTILITIES
// =============================================
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "de": "de", "th": "th", "it": "it", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

// =============================================
// 3. GOOGLE TRANSLATE (free, no API key)
// =============================================
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

// =============================================
// 4. OCR.SPACE (free, no registration)
// =============================================
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

// =============================================
// 5. IMAGE RENDERING (canvas with proper font)
// =============================================
async function renderTextOnImage(imageBuffer, regions, targetLang) {
    const errors = [];
    try {
        const img = await loadImage(imageBuffer);
        const width = img.width;
        const height = img.height;

        const canvas = createCanvas(width, height);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        // Get image data for sampling background
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        const getPixel = (px, py) => {
            if (px < 0 || py < 0 || px >= width || py >= height) return null;
            const idx = (py * width + px) * 4;
            return [data[idx], data[idx+1], data[idx+2]];
        };

        const fontFamily = getFontFamily(targetLang);

        for (const region of regions) {
            const [x, y, w, h] = region.boundingBox.split(',').map(Number);
            if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= width || y >= height) {
                errors.push(`Invalid region: ${region.boundingBox}`);
                console.warn(`⚠️ ${errors[errors.length-1]}`);
                continue;
            }

            // Sample background color from 1‑px border
            const sampleColors = [];
            // top & bottom edges
            for (let px = Math.max(0, x-1); px < Math.min(x+w+1, width); px++) {
                for (const py of [Math.max(0, y-1), Math.min(y+h, height-1)]) {
                    const c = getPixel(px, py);
                    if (c) sampleColors.push(c);
                }
            }
            // left & right edges
            for (let py = Math.max(0, y-1); py < Math.min(y+h+1, height); py++) {
                for (const px of [Math.max(0, x-1), Math.min(x+w, width-1)]) {
                    const c = getPixel(px, py);
                    if (c) sampleColors.push(c);
                }
            }

            let avgR = 0, avgG = 0, avgB = 0;
            for (const c of sampleColors) {
                avgR += c[0]; avgG += c[1]; avgB += c[2];
            }
            if (sampleColors.length > 0) {
                avgR = Math.round(avgR / sampleColors.length);
                avgG = Math.round(avgG / sampleColors.length);
                avgB = Math.round(avgB / sampleColors.length);
            } else {
                avgR = 255; avgG = 255; avgB = 255;
            }

            // Fill region with background color (opaque)
            ctx.fillStyle = `rgb(${avgR},${avgG},${avgB})`;
            ctx.fillRect(x, y, w, h);

            // Translated text
            const text = region.tranContent || '';
            if (!text) continue;

            // Determine font size
            let fontSize = Math.min(h * 0.8, 64);
            const maxWidth = w - 10;
            const maxHeight = h - 10;

            // Measure text and shrink if needed
            const measureCtx = canvas.getContext('2d');
            measureCtx.font = `bold ${fontSize}px '${fontFamily}'`;
            let textWidth = measureCtx.measureText(text).width;
            while (textWidth > maxWidth && fontSize > 10) {
                fontSize -= 2;
                measureCtx.font = `bold ${fontSize}px '${fontFamily}'`;
                textWidth = measureCtx.measureText(text).width;
            }

            // Simple word wrap if multiple lines needed
            const words = text.split(' ');
            let lines = [];
            let currentLine = '';
            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                const testWidth = measureCtx.measureText(testLine).width;
                if (testWidth < maxWidth) {
                    currentLine = testLine;
                } else {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);

            const lineHeight = fontSize * 1.4;
            const totalTextHeight = lines.length * lineHeight;
            if (totalTextHeight > maxHeight) {
                // Shrink font further to fit height
                fontSize = Math.floor(fontSize * (maxHeight / totalTextHeight));
                if (fontSize < 8) fontSize = 8;
                // Re‑wrap with new size
                measureCtx.font = `bold ${fontSize}px '${fontFamily}'`;
                lines = [];
                currentLine = '';
                for (const word of words) {
                    const testLine = currentLine ? currentLine + ' ' + word : word;
                    const testWidth = measureCtx.measureText(testLine).width;
                    if (testWidth < maxWidth) {
                        currentLine = testLine;
                    } else {
                        if (currentLine) lines.push(currentLine);
                        currentLine = word;
                    }
                }
                if (currentLine) lines.push(currentLine);
            }

            // Choose text color (black on light bg, white on dark)
            const brightness = (avgR * 0.299 + avgG * 0.587 + avgB * 0.114);
            ctx.fillStyle = brightness > 128 ? '#000000' : '#FFFFFF';
            ctx.font = `bold ${fontSize}px '${fontFamily}'`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            const startY = y + (h - lines.length * lineHeight) / 2 + lineHeight / 2;
            for (let i = 0; i < lines.length; i++) {
                ctx.fillText(lines[i], x + w / 2, startY + i * lineHeight);
            }
        }

        const buffer = canvas.toBuffer('image/jpeg', { quality: 0.9 });
        console.log(`✅ Rendered image size: ${buffer.length} bytes`);
        return { renderedBuffer: buffer, errors };
    } catch (err) {
        errors.push(`Render error: ${err.message}`);
        console.error(errors[0]);
        return { renderedBuffer: null, errors };
    }
}

// =============================================
// 6. MAIN ENDPOINT
// =============================================
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
                resRegions: [],
                debug: "OCR returned no text"
            });
        }
        console.log(`📝 Extracted: ${ocrResult.text.substring(0, 100)}...`);

        // Build resRegions with translated text
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

        if (resRegions.length === 0 && ocrResult.text) {
            const dstText = (await translateWithGoogle(ocrResult.text, fromRequested, toRequested)) || ocrResult.text;
            resRegions.push({
                context: ocrResult.text,
                tranContent: dstText,
                boundingBox: `0,0,800,100`
            });
        }

        console.log(`📤 Found ${resRegions.length} regions to render`);

        // Ensure the target language's font is downloaded (lazy load if not already)
        await downloadAndRegisterFont(toRequested);

        const { renderedBuffer, errors } = await renderTextOnImage(req.file.buffer, resRegions, toRequested);

        let renderImageBase64;
        let debugMsg = null;
        if (renderedBuffer) {
            renderImageBase64 = renderedBuffer.toString('base64');
            console.log('✅ Image rendered successfully');
        } else {
            renderImageBase64 = originalBase64;
            debugMsg = "Rendering failed, returning original image. Errors: " + errors.join('; ');
            console.warn(`⚠️ ${debugMsg}`);
        }

        const response = {
            errorCode: 0,
            render_image: renderImageBase64,
            resRegions: resRegions
        };
        if (debugMsg) response.debug = debugMsg;
        if (errors && errors.length > 0) response.renderErrors = errors;

        res.json(response);

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.json({ errorCode: 1, msg: err.message, stack: err.stack });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

export default app;
