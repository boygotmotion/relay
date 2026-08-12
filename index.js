import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import Jimp from "jimp";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Fix 1: Helper to detect if a string is just symbols/bullets/numbers
function needsTranslation(text) {
    // Returns true if there is at least one letter (any language)
    return /[p{L}]/u.test(text);
}

function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "de": "de", "th": "th", "it": "it", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

async function translateWithGoogle(txt, f, t) {
    // If it's just a bullet or symbol, return it as-is
    if (!needsTranslation(txt)) return txt;

    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 4000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return txt;
    } catch (e) { return txt; }
}

async function extractTextWithOCR(imageBuffer) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld');
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', 'eng');
        formData.append('OCREngine', '2');
        formData.append('isOverlayRequired', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 15000
        });

        if (response.data && response.data.OCRExitCode === 1) {
            return {
                text: response.data.ParsedResults[0].ParsedText.trim(),
                lines: response.data.ParsedResults[0].TextOverlay.Lines
            };
        }
        return null;
    } catch (e) { return null; }
}

let fontCache = {};
async function getFont(size, color) {
    const key = `${size}-${color}`;
    if (fontCache[key]) return fontCache[key];
    const url = `https://raw.githubusercontent.com/jimp-dev/jimp/refs/heads/main/plugins/plugin-print/fonts/open-sans/open-sans-${size}-${color}/open-sans-${size}-${color}.fnt`;
    const font = await Jimp.loadFont(url);
    fontCache[key] = font;
    return font;
}

async function renderTextOnImage(imageBuffer, regions) {
    let image = await Jimp.read(imageBuffer);
    const imgW = image.bitmap.width;
    const imgH = image.bitmap.height;

    for (const region of regions) {
        let [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // Fix 2: Better Background Wiping
        // Expand the "wipe" area by 4px in every direction to catch hanging letters like "g" or "y"
        const wipeX = Math.max(0, x - 4);
        const wipeY = Math.max(0, y - 4);
        const wipeW = Math.min(w + 8, imgW - wipeX);
        const wipeH = Math.min(h + 8, imgH - wipeY);

        // 1. CALCULATE AVAILABLE SPACE
        const availableWidth = imgW - x - 15; 
        
        // Fix 3: Consistent Font Choice
        // Force the size to be based on the box height strictly to avoid word-mismatching
        let size = 16;
        if (h > 55) size = 64;
        else if (h > 26) size = 32;

        const charWidth = size * 0.52;
        let estimatedWidth = text.length * charWidth;

        if (size > 16 && estimatedWidth > availableWidth) {
            size = 16;
            estimatedWidth = text.length * (16 * 0.52);
        }

        // Surgical Background
        const bgColorInt = image.getPixelColor(Math.max(0, x - 2), Math.max(0, y - 2));
        const rgba = Jimp.intToRGBA(bgColorInt);
        const brightness = (rgba.r * 0.299 + rgba.g * 0.587 + rgba.b * 0.114);
        const textColor = brightness > 125 ? 'black' : 'white';

        // Perform the expanded wipe
        image.scan(wipeX, wipeY, wipeW, wipeH, function(px, py, idx) {
            this.bitmap.data[idx + 0] = rgba.r;
            this.bitmap.data[idx + 1] = rgba.g;
            this.bitmap.data[idx + 2] = rgba.b;
            this.bitmap.data[idx + 3] = 255;
        });

        // The "Squeeze" Logic
        const font = await getFont(size, textColor);
        const textHeight = size * 1.2;
        
        if (estimatedWidth > availableWidth) {
            let tempTextLayer = new Jimp(estimatedWidth, textHeight, 0x00000000);
            tempTextLayer.print(font, 0, 0, text);
            tempTextLayer.resize(availableWidth, textHeight); 
            image.composite(tempTextLayer, x + 2, y + (h - textHeight) / 2);
        } else {
            image.print(font, x + 2, y + (h - textHeight) / 2, text);
        }
    }

    const renderedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
    return { renderedBuffer };
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        const ocr = await extractTextWithOCR(req.file.buffer);
        if (!ocr || !ocr.text) {
            return res.json({ errorCode: 0, render_image: req.file.buffer.toString('base64'), resRegions: [] });
        }

        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to);
            
            // Fix 3: Normalize bounding box for the WHOLE line
            // This prevents one word from being "tall" and another "short"
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            
            const lineX = first.Left;
            const lineY = Math.min(...line.Words.map(w => w.Top));
            const lineW = (last.Left + last.Width) - first.Left;
            const lineH = Math.max(...line.Words.map(w => w.Height));
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${Math.round(lineX)},${Math.round(lineY)},${Math.round(lineW)},${Math.round(lineH)}`
            });
        }

        const { renderedBuffer } = await renderTextOnImage(req.file.buffer, resRegions);
        res.json({ errorCode: 0, render_image: renderedBuffer.toString('base64'), resRegions });
    } catch (err) { res.json({ errorCode: 1, msg: err.message }); }
});

app.listen(3000, () => console.log("Relay Live - Symbol & Padding Fixes Enabled"));
export default app;
