import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. LANGUAGE MAPPING
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

// 2. TRANSLATION (Google gtx)
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

// 3. OCR (OCR.space)
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); 
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

// 4. IMPROVED RENDERING (Fixes "Made-up Background" issue)
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // A. SMART BACKGROUND SAMPLING
        // We sample slightly outside the box (offset by 2 pixels) to avoid picking up the old text's anti-aliasing
        const sampleX = Math.max(0, x - 2);
        const sampleY = Math.max(0, y - 2);
        const pixelData = ctx.getImageData(sampleX, sampleY, 1, 1).data;
        const r = pixelData[0], g = pixelData[1], b = pixelData[2];
        
        // B. CLEAN COVER-UP
        // We fill the area with the sampled color
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x - 1, y - 1, w + 2, h + 2); // Slight expansion to ensure full coverage

        // C. TEXT COLOR CONTRAST
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';

        // D. FONT & SQUEEZE (CJK FIX)
        let fontSize = Math.floor(h * 0.82); 
        ctx.font = `${fontSize}px "Microsoft YaHei", "Malgun Gothic", "Meiryo", "Arial Unicode MS", "Arial", sans-serif`;
        ctx.textBaseline = 'middle';

        // E. THE SQUEEZE
        // The 4th parameter 'w' prevents text from leaking out of its designated area
        ctx.fillText(text, x, y + (h / 2), w); 
    }

    return canvas.toBuffer('image/jpeg');
}

// 5. API ENDPOINT
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    console.log(`[${new Date().toLocaleTimeString()}] Processing Request...`);
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        if (!ocr || !ocr.lines) throw new Error("OCR Failed");

        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to);
            
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            const boxW = (last.Left + last.Width) - first.Left;
            const boxH = line.MaxHeight;
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${boxW},${boxH}`
            });
        }

        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        console.log(`[SUCCESS] Translated to ${to}. Sending image...`);
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        console.error("[ERROR]", err.message);
        res.json({ errorCode: 1, msg: err.message }); 
    }
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(`CJK & BACKGROUND-FIXED ENGINE RUNNING`);
    console.log(`URL: http://localhost:${PORT}/api/trans/sdk/picture`);
    console.log(`=========================================`);
});
