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

// --- 1. FONT REGISTRATION (Essential for Vercel & CJK/Arabic) ---
const CJK_PATH = path.join(process.cwd(), "fonts", "NotoSansCJKsc-Regular.otf");
const ARABIC_PATH = path.join(process.cwd(), "fonts", "NotoSansArabic-Regular.ttf");

try {
    GlobalFonts.registerFromPath(CJK_PATH, "NotoSansCJK");
    GlobalFonts.registerFromPath(ARABIC_PATH, "NotoArabic");
    console.log("✅ Fonts Registered: NotoSansCJK, NotoArabic");
} catch (e) {
    console.error("❌ Font Loading Failed! Ensure files exist in /fonts folder.");
}

// --- 2. LANGUAGE HELPERS ---
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "id": "id", "ru": "ru", "de": "de" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara" };
    let s = String(l).toLowerCase();
    return dict[s] || "eng";
}

// --- 3. TRANSLATION (Google GTX) ---
async function translateWithGoogle(txt, f, t) {
    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 10000,
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return txt;
    } catch (e) { return txt; }
}

// --- 4. OCR (OCR.space) ---
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); // Replace with your key for production
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2');
        formData.append('isOverlayRequired', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 60000 
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

// --- 5. SMART RENDERING ENGINE ---
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // A. Background Masking
        const sampleX = Math.max(0, x - 2);
        const sampleY = Math.max(0, y - 2);
        const pixelData = ctx.getImageData(sampleX, sampleY, 1, 1).data;
        const r = pixelData[0], g = pixelData[1], b = pixelData[2];
        
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2); 

        // B. Dynamic Text Color
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';

        // C. Font Setup (Arabic + CJK fallback)
        let fontSize = Math.floor(h * 0.82); 
        ctx.font = `${fontSize}px "NotoArabic", "NotoSansCJK", sans-serif`;
        ctx.textBaseline = 'middle';

        // D. Arabic RTL Logic
        const isArabic = /[\u0600-\u06FF]/.test(text);
        if (isArabic) {
            ctx.textAlign = 'right';
            ctx.fillText(text, x + w, y + (h / 2), w); 
        } else {
            ctx.textAlign = 'left';
            ctx.fillText(text, x, y + (h / 2), w); 
        }
        
        // Reset alignment for next loop
        ctx.textAlign = 'left';
    }

    return canvas.toBuffer('image/jpeg');
}

// --- 6. API ROUTE ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image provided" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        // 1. OCR
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        if (!ocr || !ocr.lines) throw new Error("OCR Failed to detect text");

        // 2. TRANSLATE
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

        // 3. RENDER
        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        // 4. RESPOND
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        res.json({ errorCode: 1, msg: err.message }); 
    }
});

// For Vercel, we export the app
export default app;

// For local testing
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});
