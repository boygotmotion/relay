import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import sharp from "sharp";

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.post("/", (req, res) => {
    res.send("🚀 PixPin Native Relay is LIVE. Send POST to /api/trans/sdk/picture");
});

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        // 1. Upload to imgbb (ya-ocr requires a URL)
        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));
        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: formData.getHeaders(),
            params: { key: '3d82321f5628ca768792c1c1d0297ca3' }
        });
        const imageUrl = uploadResponse.data.data.url;
        console.log(`📤 Image uploaded to: ${imageUrl}`);

        // 2. Run ya-ocr with translation
        const { OCRClient } = await import('ya-ocr');
        const client = new OCRClient({ withTranslate: true });
        const result = await client.scanByUrl(imageUrl);

        console.log(`📝 Extracted: ${result.text ? result.text.substring(0, 100) : 'No text'}...`);
        console.log(`📝 Translated: ${result.translatedText ? result.translatedText.substring(0, 100) : 'No translation'}...`);

        // 3. Convert SVG to PNG using sharp
        let pngBuffer;
        try {
            pngBuffer = await sharp(Buffer.from(result.svg))
                .png()
                .toBuffer();
            console.log('✅ SVG converted to PNG with sharp');
        } catch (sharpError) {
            console.warn('⚠️ Sharp failed, falling back to Image-to-Text mode');
            // Fallback: return original image with resRegions (PixPin renders locally)
            const originalBase64 = req.file.buffer.toString('base64');
            const resRegions = [{
                context: result.text || '',
                tranContent: result.translatedText || '',
                boundingBox: `0,0,${result.width || 800},${result.height || 600}`
            }];
            return res.json({
                errorCode: 0,
                render_image: originalBase64,
                resRegions: resRegions
            });
        }

        // 4. Return rendered image
        const base64Image = pngBuffer.toString('base64');

        const resRegions = [{
            context: result.text ? result.text.substring(0, 200) : '',
            tranContent: result.translatedText ? result.translatedText.substring(0, 200) : '',
            boundingBox: `0,0,${result.width || 800},${result.height || 600}`
        }];

        res.json({
            errorCode: 0,
            render_image: base64Image,
            resRegions: resRegions
        });

    } catch (err) {
        console.error("❌ Error:", err.message);
        console.error("Stack:", err.stack);
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

export default app;
