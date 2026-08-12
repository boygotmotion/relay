import express from "express";
import axios from "axios";
import multer from "multer";
import FormData from "form-data";
import svg2png from "svg2png";

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
        const { OCRClient } = await import('ya-ocr');

        const formData = new FormData();
        formData.append('image', req.file.buffer.toString('base64'));

        const uploadResponse = await axios.post('https://api.imgbb.com/1/upload', formData, {
            headers: formData.getHeaders(),
            params: { key: '3d82321f5628ca768792c1c1d0297ca3' }
        });

        const imageUrl = uploadResponse.data.data.url;
        console.log(`📤 Image uploaded to: ${imageUrl}`);

        const client = new OCRClient({ withTranslate: true });
        const result = await client.scanByUrl(imageUrl);

        console.log(`📝 Extracted: ${result.text ? result.text.substring(0, 100) : 'No text'}...`);
        console.log(`📝 Translated: ${result.translatedText ? result.translatedText.substring(0, 100) : 'No translation'}...`);

        // ✅ Convert SVG to PNG using svg2png (pure JS)
        const pngBuffer = await svg2png(result.svg, { width: result.width || 800, height: result.height || 600 });

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
