import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import path from "path";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- FONT REGISTRATION ---
// If running on Vercel, it looks for a font file in your project folder
try {
    // Optional: Download NotoSansCJK-Regular.ttc to your project root for Vercel support
    // GlobalFonts.registerFromPath('./NotoSansCJK-Regular.ttc', 'UniversalFont');
} catch (e) {
    console.log("Custom font not found, falling back to system fonts.");
}

// 1. LANGUAGE MAPPING
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara" };
    let s = String(l).toLowerCase();
    return dict[s] || "eng";
}

// 2. TRANSLATION LOGIC
async function translateWithGoogle(txt, f, t) {
    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 5000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return txt;
    } catch (e) { return txt; }
}

// 3. OCR LOGIC
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); // Recommended: Replace with your free key from ocr.space
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2');
        formData.append('isOverlayRequired', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 25000 
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

// 4. THE RENDERING ENGINE (Surgical Background + Squeeze)
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // A. SURGICAL BACKGROUND SAMPLING
        // Sample 2 pixels outside the box to avoid "dirty" colors from the old text
        const sampleX = Math.max(0, x - 2);
        const sampleY = Math.max(0, y - 2);
        const pixelData = ctx.getImageData(sampleX, sampleY, 1, 1).data;
        const r = pixelData[0], g = pixelData[1], b = pixelData[2];
        
        // B. CLEAN PATCH
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2);

        // C. CONTRAST CALCULATION
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';

        // D. FONT SELECTION
        let fontSize = Math.floor(h * 0.82); 
        // Note: 'UniversalFont' is used if registered via Noto Sans, otherwise fallbacks used
        ctx.font = `${fontSize}px "UniversalFont", "Microsoft YaHei", "Malgun Gothic", "Meiryo", "Arial Unicode MS", sans-serif`;
        ctx.textBaseline = 'middle';

        // E. THE SQUEEZE FIX (Horizontal compression)
        ctx.fillText(text, x, y + (h / 2), w); 
    }

    return canvas.toBuffer('image/jpeg');
}

// 5. API ROUTE
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "id" } = req.body;

    try {
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        if (!ocr) throw new Error("OCR Timeout/Failed");

        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to);
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${(last.Left + last.Width) - first.Left},${line.MaxHeight}`
            });
        }

        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        console.error(err.message);
        res.status(500).json({ errorCode: 1, msg: err.message }); 
    }
});

export default app;
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
