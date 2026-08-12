import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// LANGUAGE HELPERS
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

// TRANSLATION LOGIC
async function translateWithGoogle(txt, f, t) {
    try {
        let src = (f === "auto" || f === "au") ? "auto" : toGoogleLang(f);
        let tgt = toGoogleLang(t);
        const params = new URLSearchParams({ client: 'gtx', sl: src, tl: tgt, dt: 't', q: txt });
        const r = await axios.get(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
            timeout: 4000, // Short timeout to prevent Vercel crash
            headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (r.data && r.data[0]) return r.data[0].map(s => s[0]).join("").trim();
        return txt;
    } catch (e) { return txt; }
}

// OCR LOGIC
async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        // NOTE: 'helloworld' is very slow. Get a free key at ocr.space to avoid timeouts.
        formData.append('apikey', 'helloworld'); 
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
        formData.append('OCREngine', '2');
        formData.append('isOverlayRequired', 'true');

        const response = await axios.post('https://api.ocr.space/parse/image', formData, {
            headers: formData.getHeaders(),
            timeout: 8000 // Vercel hobby limit is 10s total
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

// RENDERING LOGIC (The "Universal" Fix)
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // 1. Background Sampling (Surgical)
        const pixelData = ctx.getImageData(Math.max(0, x), Math.max(0, y), 1, 1).data;
        ctx.fillStyle = `rgb(${pixelData[0]},${pixelData[1]},${pixelData[2]})`;
        ctx.fillRect(x, y, w, h);

        // 2. Text Color (Luminance)
        const brightness = (pixelData[0] * 0.299 + pixelData[1] * 0.587 + pixelData[2] * 0.114);
        ctx.fillStyle = brightness > 125 ? 'black' : 'white';

        // 3. Font & Squeeze (Supports Chinese/Arabic if fonts exist on OS)
        let fontSize = Math.floor(h * 0.8);
        ctx.font = `${fontSize}px sans-serif`;
        ctx.textBaseline = 'top';

        // 4. Draw with Horizontal Fit (The Squeeze Fix)
        ctx.fillText(text, x, y, w); 
    }

    return canvas.toBuffer('image/jpeg');
}

// MAIN API ROUTE
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        // 1. OCR
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        if (!ocr) throw new Error("OCR Failed or Timed Out");

        // 2. Translate Lines
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

        // 3. Render
        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        console.error(err.message);
        // If it fails (timeout), return the original image so the app doesn't break
        res.json({ 
            errorCode: 0, 
            render_image: req.file.buffer.toString('base64'), 
            msg: "Process timed out, returning original" 
        }); 
    }
});

export default app;
