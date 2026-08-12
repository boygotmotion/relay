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

async function renderTextOnImage(imageBuffer, regions) {
    const errors = [];
    let image;
    try {
        image = await Jimp.read(imageBuffer);
        console.log(`📐 Image dimensions: ${image.bitmap.width}x${image.bitmap.height}`);
    } catch (err) {
        errors.push(`Jimp.read failed: ${err.message}`);
        console.error(errors[0]);
        return { renderedBuffer: null, errors };
    }

    // Load fonts (black and white variants for different sizes)
    let fonts = {};
    try {
        fonts[16] = { black: await Jimp.loadFont(Jimp.FONT_SANS_16_BLACK), white: await Jimp.loadFont(Jimp.FONT_SANS_16_WHITE) };
        fonts[32] = { black: await Jimp.loadFont(Jimp.FONT_SANS_32_BLACK), white: await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE) };
        fonts[64] = { black: await Jimp.loadFont(Jimp.FONT_SANS_64_BLACK), white: await Jimp.loadFont(Jimp.FONT_SANS_64_WHITE) };
        console.log('✅ Fonts loaded');
    } catch (err) {
        errors.push(`Font load failed: ${err.message}`);
        console.error(errors[0]);
        return { renderedBuffer: null, errors };
    }

    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        console.log(`📦 Region ${i}: x=${x}, y=${y}, w=${w}, h=${h}`);

        if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= image.bitmap.width || y >= image.bitmap.height) {
            errors.push(`Invalid region ${i}: ${region.boundingBox}`);
            console.warn(`⚠️ ${errors[errors.length-1]}`);
            continue;
        }

        const endX = Math.min(x + w, image.bitmap.width);
        const endY = Math.min(y + h, image.bitmap.height);
        const actualW = endX - x;
        const actualH = endY - y;

        try {
            // Sample background color from the 1‑pixel border
            const sampleColors = [];
            // Top and bottom edges
            for (let px = Math.max(0, x - 1); px < Math.min(endX + 1, image.bitmap.width); px++) {
                for (const py of [Math.max(0, y - 1), Math.min(endY, image.bitmap.height - 1)]) {
                    const idx = (py * image.bitmap.width + px) * 4;
                    sampleColors.push([
                        image.bitmap.data[idx],
                        image.bitmap.data[idx + 1],
                        image.bitmap.data[idx + 2]
                    ]);
                }
            }
            // Left and right edges
            for (let py = Math.max(0, y - 1); py < Math.min(endY + 1, image.bitmap.height); py++) {
                for (const px of [Math.max(0, x - 1), Math.min(endX, image.bitmap.width - 1)]) {
                    const idx = (py * image.bitmap.width + px) * 4;
                    sampleColors.push([
                        image.bitmap.data[idx],
                        image.bitmap.data[idx + 1],
                        image.bitmap.data[idx + 2]
                    ]);
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

            // Fill the region with the sampled background (semi‑transparent to blend)
            image.scan(x, y, actualW, actualH, function(px, py, idx) {
                this.bitmap.data[idx + 0] = avgR;
                this.bitmap.data[idx + 1] = avgG;
                this.bitmap.data[idx + 2] = avgB;
                this.bitmap.data[idx + 3] = 200; // ~78% opacity
            });

            // Prepare translated text
            const text = region.tranContent || '';
            if (!text) continue;

            // Determine font size based on region height (choose largest that fits)
            let size = 16;
            if (actualH > 32 && actualW > 64) size = 32;
            if (actualH > 64 && actualW > 128) size = 64;
            // But we also want to fit width; we'll do a rough check
            const avgCharWidth = size * 0.55;
            if (text.length * avgCharWidth > actualW - 10) {
                // Reduce size
                if (size === 64) size = 32;
                else if (size === 32) size = 16;
            }

            // Choose text color based on background brightness
            const brightness = (avgR * 0.299 + avgG * 0.587 + avgB * 0.114);
            const colorKey = brightness > 128 ? 'black' : 'white';
            const font = fonts[size] ? fonts[size][colorKey] : fonts[16].black;

            // Word wrap to fit width
            const maxWidth = actualW - 10;
            const lines = [];
            let currentLine = '';
            const words = text.split(' ');
            const charWidth = size * 0.55;
            for (const word of words) {
                const testLine = currentLine ? currentLine + ' ' + word : word;
                if (testLine.length * charWidth < maxWidth) {
                    currentLine = testLine;
                } else {
                    if (currentLine) lines.push(currentLine);
                    currentLine = word;
                }
            }
            if (currentLine) lines.push(currentLine);

            const lineHeight = size * 1.2;
            const totalHeight = lines.length * lineHeight;
            let startY = y + (actualH - totalHeight) / 2;
            if (startY < y) startY = y + 2;

            // Draw each line, centered horizontally
            for (let li = 0; li < lines.length; li++) {
                const line = lines[li];
                const lineWidth = line.length * charWidth;
                const startX = x + (actualW - lineWidth) / 2;
                const lineY = startY + li * lineHeight;
                image.print(font, startX, lineY, line);
            }
        } catch (err) {
            errors.push(`Render error on region ${i}: ${err.message}`);
            console.error(errors[errors.length - 1]);
        }
    }

    let renderedBuffer = null;
    try {
        renderedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        console.log(`✅ Rendered image size: ${renderedBuffer.length} bytes`);
    } catch (err) {
        errors.push(`getBufferAsync failed: ${err.message}`);
        console.error(errors[errors.length - 1]);
    }

    return { renderedBuffer, errors };
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
                resRegions: [],
                debug: "OCR returned no text"
            });
        }

        console.log(`📝 Extracted: ${ocrResult.text.substring(0, 100)}...`);

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

        const { renderedBuffer, errors } = await renderTextOnImage(req.file.buffer, resRegions);
        
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
