import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import sharp from "sharp";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

// =============================================
// 1. FONT MANAGEMENT (download from GitHub)
// =============================================
const FONT_SOURCES = {
    'zh': { family: 'NotoSansSC', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/SimplifiedChinese/NotoSansSC-Regular.otf' },
    'ja': { family: 'NotoSansJP', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/Japanese/NotoSansJP-Regular.otf' },
    'ko': { family: 'NotoSansKR', url: 'https://cdn.jsdelivr.net/gh/googlefonts/noto-cjk@main/Sans/Subset/OTF/Korean/NotoSansKR-Regular.otf' },
    'ar': { family: 'NotoNaskhArabic', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notonaskharabic/NotoNaskhArabic%5Bwght%5D.ttf' },
    'th': { family: 'NotoSansThai', url: 'https://raw.githubusercontent.com/google/fonts/main/ofl/notosansthai/NotoSansThai%5Bwght%5D.ttf' },
};

const fontCache = {};

async function getFontBase64(lang) {
    if (fontCache[lang]) return fontCache[lang];
    const source = FONT_SOURCES[lang];
    if (!source) return null;

    try {
        const response = await axios.get(source.url, { responseType: 'arraybuffer' });
        const base64 = Buffer.from(response.data).toString('base64');
        fontCache[lang] = base64;
        console.log(`✅ Font downloaded: ${source.family}`);
        return base64;
    } catch (err) {
        console.error(`❌ Failed to download font for ${lang}: ${err.message}`);
        return null;
    }
}

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
// 3. GOOGLE TRANSLATE
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
// 4. OCR.SPACE
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
// 5. IMAGE RENDERING (sharp + SVG)
// =============================================
async function renderTextOnImage(imageBuffer, regions, targetLang) {
    try {
        // Get original image metadata
        const metadata = await sharp(imageBuffer).metadata();
        const width = metadata.width;
        const height = metadata.height;

        // Build SVG
        let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">`;
        svg += `<style>`;

        // Embed font if needed (non-Latin scripts)
        const fontFamily = getFontFamily(targetLang);
        const needsFont = ['zh','ja','ko','ar','th'].includes(targetLang);
        if (needsFont) {
            const fontBase64 = await getFontBase64(targetLang);
            if (fontBase64) {
                const fontFormat = targetLang === 'ar' || targetLang === 'th' ? 'ttf' : 'otf';
                svg += `@font-face { font-family: '${fontFamily}'; src: url(data:font/${fontFormat};base64,${fontBase64}); }`;
            } else {
                // fallback to system font
                console.warn(`⚠️ Font not available for ${targetLang}, using system fallback`);
            }
        }
        svg += `</style>`;

        // Embed original image as base64
        const imgBase64 = imageBuffer.toString('base64');
        svg += `<image href="data:image/jpeg;base64,${imgBase64}" width="${width}" height="${height}" />`;

        // Add text overlays
        for (const region of regions) {
            const [x, y, w, h] = region.boundingBox.split(',').map(Number);
            if (w <= 0 || h <= 0 || x < 0 || y < 0) continue;
            const text = region.tranContent || '';
            if (!text) continue;

            // Determine font size
            let fontSize = Math.min(h * 0.8, 64);
            // Estimate text width (simplistic: assume each char width ≈ fontSize * 0.6)
            const avgCharWidth = fontSize * 0.6;
            let textWidth = text.length * avgCharWidth;
            while (textWidth > w - 10 && fontSize > 8) {
                fontSize -= 2;
                textWidth = text.length * fontSize * 0.6;
            }

            // Word wrap (simple: split by spaces, but for CJK we may need character-based)
            const words = text.split(' ');
            let lines = [];
            let currentLine = '';
            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                const testWidth = testLine.length * fontSize * 0.6;
                if (testWidth < w - 10) {
                    currentLine = testLine;
                } else {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);

            const lineHeight = fontSize * 1.2;
            const totalTextHeight = lines.length * lineHeight;
            let startY = y + (h - totalTextHeight) / 2 + fontSize * 0.8;
            if (startY < y) startY = y + fontSize;

            // For RTL languages (Arabic), we might want to set direction, but we'll keep it simple.
            const textColor = '#000000'; // we'll determine based on background later? We'll sample background but in SVG we can't easily sample. We'll use black with a white outline for readability.
            // Simpler: use black text with a white stroke for readability.
            const color = '#000000';
            const stroke = '#FFFFFF';

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lineWidth = line.length * fontSize * 0.6;
                const startX = x + (w - lineWidth) / 2;
                const lineY = startY + i * lineHeight;
                // Draw text with stroke and fill
                svg += `<text x="${startX}" y="${lineY}" font-family="${fontFamily}" font-size="${fontSize}" fill="${color}" stroke="${stroke}" stroke-width="1.5" font-weight="bold">${escapeXML(line)}</text>`;
            }
        }

        svg += '</svg>';

        // Render SVG to PNG using sharp
        const renderedBuffer = await sharp(Buffer.from(svg))
            .png()
            .toBuffer();

        console.log(`✅ Rendered image size: ${renderedBuffer.length} bytes`);
        return { renderedBuffer, errors: [] };
    } catch (err) {
        console.error('❌ Render error:', err.message);
        return { renderedBuffer: null, errors: [err.message] };
    }
}

function escapeXML(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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

        // Build resRegions
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
