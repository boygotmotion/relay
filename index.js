import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import Jimp from "jimp";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
    } catch (e) { return null; }
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
    const url = urls[key];
    try {
        const font = await Jimp.loadFont(url);
        fontCache[key] = font;
        return font;
    } catch (err) { throw err; }
}

async function renderTextOnImage(imageBuffer, regions) {
    let image = await Jimp.read(imageBuffer);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        if (w <= 0 || h <= 0) continue;

        const actualW = Math.min(x + w, image.bitmap.width) - x;
        const actualH = Math.min(y + h, image.bitmap.height) - y;

        // Sample background
        const idx = (Math.floor(y + actualH / 2) * image.bitmap.width + Math.floor(x + actualW / 2)) * 4;
        const avgR = image.bitmap.data[idx], avgG = image.bitmap.data[idx+1], avgB = image.bitmap.data[idx+2];

        const text = region.tranContent || '';
        if (!text) continue;

        // --- NEW FITTING LOGIC ---
        // 1. Determine starting size based on height
        let size = 16;
        if (actualH > 60) size = 64;
        else if (actualH > 30) size = 32;

        // 2. Shrink font size if the text is too wide for the box
        let charWidth = size * 0.55;
        while (size > 16 && (text.length * charWidth > actualW)) {
            if (size === 64) size = 32;
            else if (size === 32) size = 16;
            charWidth = size * 0.55;
        }

        // 3. Expand the background box slightly if French is longer (fixes the "gray box" clipping)
        const textWidth = text.length * charWidth;
        const fillWidth = Math.max(actualW, Math.min(textWidth + 10, image.bitmap.width - x));

        image.scan(x, y, fillWidth, actualH, function(px, py, idx) {
            this.bitmap.data[idx + 0] = avgR;
            this.bitmap.data[idx + 1] = avgG;
            this.bitmap.data[idx + 2] = avgB;
            this.bitmap.data[idx + 3] = 255;
        });

        // 4. No more aggressive "maxChars" truncation. 
        // We only use ellipsis if it's physically impossible to fit on one line at the smallest font.
        let finalDisplayToken = text;
        const absoluteMaxChars = Math.floor((image.bitmap.width - x) / charWidth);
        if (text.length > absoluteMaxChars) {
            finalDisplayToken = text.substring(0, absoluteMaxChars - 3) + "...";
        }

        const brightness = (avgR * 0.299 + avgG * 0.587 + avgB * 0.114);
        const color = brightness > 128 ? 'black' : 'white';
        const font = await getFont(size, color);

        // Center vertically in the original box
        const startY = y + (actualH - (size * 1.2)) / 2;
        image.print(font, x + 5, startY, finalDisplayToken);
    }

    const renderedBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
    return { renderedBuffer };
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const from = req.body.from || "auto";
    const to = req.body.to || "zh";

    try {
        const ocr = await extractTextWithOCR(req.file.buffer);
        if (!ocr || !ocr.text) {
            return res.json({ errorCode: 0, render_image: req.file.buffer.toString('base64'), resRegions: [] });
        }

        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = (await translateWithGoogle(line.LineText, from, to)) || line.LineText;
            const first = line.Words[0], last = line.Words[line.Words.length - 1];
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${Math.round(first.Left)},${Math.round(first.Top)},${Math.round((last.Left + last.Width) - first.Left)},${Math.round(line.MaxHeight || 30)}`
            });
        }

        const { renderedBuffer } = await renderTextOnImage(req.file.buffer, resRegions);
        res.json({ errorCode: 0, render_image: renderedBuffer.toString('base64'), resRegions });
    } catch (err) { res.json({ errorCode: 1, msg: err.message }); }
});

app.listen(3000, () => console.log("Relay Live"));
export default app;
