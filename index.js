import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import { createCanvas, loadImage, GlobalFonts } from "@napi-rs/canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * FONT NOTE: 
 * Vercel servers have very few fonts. To render Chinese, Japanese, or Arabic,
 * you should place a .ttf file (like NotoSans-Regular.ttf) in your project folder
 * and uncomment the line below:
 * 
 * GlobalFonts.registerFromPath('./NotoSans-Regular.ttf', 'GlobalFont');
 */

// Helper: Map standard codes to Google Translate codes
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

// Helper: Map standard codes to OCR.space codes
function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara", "de": "ger" };
    let s = String(l).toLowerCase();
    return dict[s] || "eng";
}

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
        return null;
    } catch (e) { return null; }
}

async function extractTextWithOCR(imageBuffer, fromLang) {
    try {
        const formData = new FormData();
        formData.append('apikey', 'helloworld'); // Replace 'helloworld' with your actual OCR.space API key
        formData.append('file', imageBuffer, { filename: 'image.jpg' });
        formData.append('language', toOCRLang(fromLang));
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

async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    // 1. Draw original image
    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // 2. SURGICAL BACKGROUND (Pixel Sampling)
        // Sample color from the top-left edge of the box to cover old text
        const pixelData = ctx.getImageData(Math.max(0, x - 1), Math.max(0, y - 1), 1, 1).data;
        const r = pixelData[0], g = pixelData[1], b = pixelData[2];
        
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, w, h);

        // 3. COLOR SELECTION (Luminance check)
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        const textColor = brightness > 125 ? 'black' : 'white';

        // 4. DYNAMIC FONT CALCULATION
        // We set font size to roughly 75% of the box height
        let fontSize = Math.floor(h * 0.75); 
        ctx.font = `${fontSize}px sans-serif`; // Use 'GlobalFont' if you registered one above
        ctx.fillStyle = textColor;
        ctx.textBaseline = 'middle';

        // 5. THE "SQUEEZE" FIX
        // Canvas fillText has a 4th parameter: maxWidth. 
        // If the text is wider than 'w', Canvas will automatically compress the characters.
        const metrics = ctx.measureText(text);
        if (metrics.width > w) {
            ctx.fillText(text, x, y + (h / 2), w); 
        } else {
            ctx.fillText(text, x, y + (h / 2));
        }
    }

    return canvas.toBuffer('image/jpeg');
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image provided" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        // Step 1: Perform OCR
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        
        if (!ocr || !ocr.text) {
            return res.json({ 
                errorCode: 0, 
                render_image: req.file.buffer.toString('base64'), 
                resRegions: [] 
            });
        }

        // Step 2: Translate each detected line
        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to) || line.LineText;
            
            // Calculate bounding box based on word positions
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            const boxW = (last.Left + last.Width) - first.Left;
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${boxW},${line.MaxHeight}`
            });
        }

        // Step 3: Render the translated text back onto the image
        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        console.error("Internal Error:", err);
        res.status(500).json({ errorCode: 1, msg: err.message }); 
    }
});

// Port handling for local and production (Vercel)
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

export default app;
