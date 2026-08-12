import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import { createCanvas, loadImage } from "canvas";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. IMPROVED LANGUAGE MAPPING
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "fra": "fr", "spa": "es" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function toOCRLang(l) {
    const dict = { "zh": "chs", "jp": "jpn", "ko": "kor", "fra": "fre", "spa": "spa", "ara": "ara", "de": "ger" };
    let s = String(l).toLowerCase();
    return dict[s] || "eng"; // Default to eng
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
        formData.append('apikey', 'helloworld'); // Use your real key in production
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

// 2. UPDATED RENDERING LOGIC (Using Canvas)
async function renderTextOnImage(imageBuffer, regions) {
    const img = await loadImage(imageBuffer);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');

    // Draw the original image first
    ctx.drawImage(img, 0, 0);

    for (const region of regions) {
        const [x, y, w, h] = region.boundingBox.split(',').map(Number);
        const text = region.tranContent || '';
        if (!text || w <= 0 || h <= 0) continue;

        // 3. SURGICAL BACKGROUND (Pixel Sampling)
        // We sample a pixel from the top-left edge of the box
        const pixelData = ctx.getImageData(Math.max(0, x - 1), Math.max(0, y - 1), 1, 1).data;
        const r = pixelData[0], g = pixelData[1], b = pixelData[2];
        
        // Fill the background to hide original text
        ctx.fillStyle = `rgb(${r},${g},${b})`;
        ctx.fillRect(x, y, w, h);

        // 4. COLOR SELECTION (Luminance check)
        const brightness = (r * 0.299 + g * 0.587 + b * 0.114);
        const textColor = brightness > 125 ? 'black' : 'white';

        // 5. DYNAMIC FONT CALCULATION
        // We use system fonts that support Unicode (sans-serif)
        let fontSize = h * 0.8; 
        ctx.font = `${fontSize}px sans-serif`;
        
        // Measure text width
        let metrics = ctx.measureText(text);
        let actualWidth = metrics.width;

        // 6. THE SQUEEZE FIX
        ctx.fillStyle = textColor;
        ctx.textBaseline = 'middle';

        if (actualWidth > w) {
            // If text is wider than the box, use the Canvas 'maxWidth' parameter 
            // which automatically compresses the text horizontally
            ctx.fillText(text, x, y + (h / 2), w);
        } else {
            // Draw normally, centered vertically in the box
            ctx.fillText(text, x, y + (h / 2));
        }
    }

    return canvas.toBuffer('image/jpeg');
}

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });
    const { from = "auto", to = "zh" } = req.body;

    try {
        // Step 1: OCR (passing the 'from' language for better accuracy)
        const ocr = await extractTextWithOCR(req.file.buffer, from);
        
        if (!ocr || !ocr.text) {
            return res.json({ 
                errorCode: 0, 
                render_image: req.file.buffer.toString('base64'), 
                resRegions: [] 
            });
        }

        // Step 2: Translation
        const resRegions = [];
        for (const line of ocr.lines) {
            const dstText = await translateWithGoogle(line.LineText, from, to) || line.LineText;
            
            // Reconstruct bounding box from OCR words
            const first = line.Words[0];
            const last = line.Words[line.Words.length - 1];
            const boxW = (last.Left + last.Width) - first.Left;
            
            resRegions.push({
                tranContent: dstText,
                boundingBox: `${first.Left},${first.Top},${boxW},${line.MaxHeight}`
            });
        }

        // Step 3: Render (Canvas handles Unicode/All Languages)
        const renderedBuffer = await renderTextOnImage(req.file.buffer, resRegions);
        
        res.json({ 
            errorCode: 0, 
            render_image: renderedBuffer.toString('base64'), 
            resRegions 
        });

    } catch (err) { 
        console.error(err);
        res.json({ errorCode: 1, msg: err.message }); 
    }
});

app.listen(3000, () => console.log("Universal Renderer Live on Port 3000"));
