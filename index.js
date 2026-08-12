import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import Jimp from "jimp";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Language helper
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "de": "de", "th": "th", "it": "it", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

// Translation logic
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

// OCR logic
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

// Font cache
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

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // 1. DYNAMIC FONT REDUCTION
        // Calculate how much space is left before the right edge of the image
        const availableWidth = imgW - x - 10; 
        
        let size = 32; // Default starting size
        if (h < 25) size = 16;
        if (h > 60) size = 64;

        // Reduce size if it exceeds the image border
        let estimatedWidth = text.length * (size * 0.55);
        while (size > 16 && estimatedWidth > availableWidth) {
            size = (size === 64) ? 32 : 16;
            estimatedWidth = text.length * (size * 0.55);
        }

        // 2. TRANSPARENT-LOOKING BACKGROUND
        // Sample color from just outside the top-left of the original text
        const sampleX = Math.max(0, x - 2);
        const sampleY = Math.max(0, y - 2);
        const bgColor = image.getPixelColor(sampleX, sampleY);
        
        // Convert to RGB for brightness check
        const rgba = Jimp.intToRGBA(bgColor);
        const brightness = (rgba.r * 0.299 + rgba.g * 0.587 + rgba.b * 0.114);
        const textColor = brightness > 125 ? 'black' : 'white';

        // 3. SURGICAL FILL (Only fill the width of the actual text)
        const textWidth = Math.min(estimatedWidth + 10, availableWidth);
        image.scan(x, y, textWidth, h, function(px, py, idx) {
            this.bitmap.data[idx + 0] = rgba.r;
            this.bitmap.data[idx + 1] = rgba.g;
            this.bitmap.data[idx + 2] = rgba.b;
            this.bitmap.data[idx + 3] = 255; // Solid to cover old text
        });

        // 4. FINAL RENDER
        const font = await getFont(size, textColor);
        const verticalCenter = y + (h - (size * 1.1)) / 2;
        
        // Final sanity check for truncation (only if even 16px hits the screen edge)
        let finalStr = text;
        if (text.length * (size * 0.52) > availableWidth) {
            const maxChars = Math.floor(availableWidth / (size * 0.52));
            finalStr = text.substring(0, maxChars - 3) + "...";
        }

        image.print(font, x + 2, verticalCenter, finalStr);
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
            const dstText = await translateWithGoogle(line.LineText, from, to) || line.LineText;
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${(last.Left + last.Width) - first.Left},${line.MaxHeight}`
            });
        }

        const { renderedBuffer } = await renderTextOnImage(req.file.buffer, resRegions);
        res.json({ errorCode: 0, render_image: renderedBuffer.toString('base64'), resRegions });
    } catch (err) { res.json({ errorCode: 1, msg: err.message }); }
});

app.listen(3000, () => console.log("Relay running"));
export default app;
