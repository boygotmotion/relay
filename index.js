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
        console.log('🖌️ Starting renderTextOnImage...');
        image = await Jimp.read(imageBuffer);
        console.log(`📐 Image dimensions: ${image.bitmap.width}x${image.bitmap.height}`);
    } catch (err) {
        errors.push(`Jimp.read failed: ${err.message}`);
        console.error(errors[0]);
        return { renderedBuffer: null, errors };
    }

    // Load built-in font
    let font;
    try {
        font = Jimp.FONT_SANS_16_BLACK;
        if (!font) {
            throw new Error('Jimp.FONT_SANS_16_BLACK is undefined');
        }
        console.log('✅ Font loaded');
    } catch (err) {
        errors.push(`Font load failed: ${err.message}`);
        console.error(errors[0]);
        return { renderedBuffer: null, errors };
    }

    for (let i = 0; i < regions.length; i++) {
        const region = regions[i];
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        console.log(`📦 Region ${i}: x=${x}, y=${y}, w=${w}, h=${h}`);

        // Validate region
        if (w <= 0 || h <= 0 || x < 0 || y < 0 || x >= image.bitmap.width || y >= image.bitmap.height) {
            const errMsg = `Invalid region ${i}: ${region.boundingBox}`;
            errors.push(errMsg);
            console.warn(`⚠️ ${errMsg}`);
            continue;
        }

        const endX = Math.min(x + w, image.bitmap.width);
        const endY = Math.min(y + h, image.bitmap.height);
        const actualW = endX - x;
        const actualH = endY - y;

        try {
            // Paint white background
            image.scan(x, y, actualW, actualH, function(px, py, idx) {
                this.bitmap.data[idx + 0] = 255;
                this.bitmap.data[idx + 1] = 255;
                this.bitmap.data[idx + 2] = 255;
                this.bitmap.data[idx + 3] = 220;
            });

            const text = region.tranContent || '';
            const maxWidth = actualW - 10;
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
            const lineHeight = 20;
            for (const line of lines) {
                if (lineY + lineHeight > endY) break;
                image.print(font, x + 5, lineY, line);
                lineY += lineHeight;
            }
        } catch (err) {
            const errMsg = `Render error on region ${i}: ${err.message}`;
            errors.push(errMsg);
            console.error(errMsg);
        }
    }

    let renderedBuffer = null;
    try {
        renderedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        console.log(`✅ Rendered image size: ${renderedBuffer.length} bytes`);
    } catch (err) {
        const errMsg = `getBufferAsync failed: ${err.message}`;
        errors.push(errMsg);
        console.error(errMsg);
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

        // Fallback if no coords
        if (resRegions.length === 0 && ocrResult.text) {
            const dstText = (await translateWithGoogle(ocrResult.text, fromRequested, toRequested)) || ocrResult.text;
            resRegions.push({
                context: ocrResult.text,
                tranContent: dstText,
                boundingBox: `0,0,800,100`
            });
        }

        console.log(`📤 Found ${resRegions.length} regions to render`);

        // Render
        console.log('🖌️ Rendering text on image...');
        const { renderedBuffer, errors } = await renderTextOnImage(req.file.buffer, resRegions);
        
        let renderImageBase64;
        let debugMsg = null;
        if (renderedBuffer) {
            renderImageBase64 = renderedBuffer.toString('base64');
            console.log('✅ Image rendered successfully');
        } else {
            // Fallback: original image
            renderImageBase64 = originalBase64;
            debugMsg = "Rendering failed, returning original image. Errors: " + errors.join('; ');
            console.warn(`⚠️ ${debugMsg}`);
        }

        const response = {
            errorCode: 0,
            render_image: renderImageBase64,
            resRegions: resRegions
        };
        if (debugMsg) {
            response.debug = debugMsg;
        }
        if (errors && errors.length > 0) {
            response.renderErrors = errors;
        }

        res.json(response);

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.json({ errorCode: 1, msg: err.message, stack: err.stack });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

export default app;
