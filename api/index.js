const express = require("express");
const axios = require("axios");
const multer = require("multer");
const Tesseract = require("tesseract.js");
const Jimp = require("jimp");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- UTILS ---
function toGoogleLang(l) {
    const dict = { "jp": "ja", "zh": "zh-CN", "ara": "ar", "kor": "ko", "ko": "ko", "fra": "fr", "spa": "es", "th": "th", "it": "it", "id": "id" };
    let s = String(l).toLowerCase();
    return dict[s] || s;
}

function getTessLang(f) {
    const l = String(f).toLowerCase();
    if (l.startsWith("zh")) return "chi_sim";
    if (l.startsWith("jp") || l.startsWith("ja")) return "jpn";
    if (l.startsWith("ko")) return "kor";
    return "eng";
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

// --- MAIN ENDPOINT ---
app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    // 🔍 LOGGING: INCOMING DATA
    console.log("\n" + "=".repeat(80));
    console.log("📥 NEW PIXPIN REQUEST RECEIVED");
    console.log("--------------------------------------------------");
    console.log("1. HEADERS:", JSON.stringify(req.headers, null, 2));
    console.log("2. QUERY PARAMS:", JSON.stringify(req.query, null, 2));
    
    if (req.file) console.log("3. BODY FIELDS: { image: [Buffer] }");

    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";

    if (!req.file) return res.json({ errorCode: 1, msg: "No image file" });

    try {
        const tLang = getTessLang(fromRequested);
        const image = await Jimp.read(req.file.buffer);

        console.log(`   🔍 Starting OCR (Lang: ${tLang})...`);
        const ocrResult = await Tesseract.recognize(
            req.file.buffer,
            tLang,
            { 
                cachePath: '/tmp',
                logger: m => console.log(`OCR Status: ${m.status}`) 
            }
        );
        console.log("\n   ✅ OCR Complete");

        const resRegions = [];
        let fragments = ocrResult.data.lines || ocrResult.data.words || [];

        for (let i = 0; i < fragments.length; i++) {
            const item = fragments[i];
            const srcText = item.text.trim();
            if (srcText.length < 1) continue;

            console.log(`   🔄 Processing Block ${i+1}...`);
            const dstText = (await translateWithGoogle(srcText, fromRequested, toRequested)) || srcText;

            const b = item.bbox;
            const x = Math.round(b.x0);
            const y = Math.round(b.y0);
            const w = Math.round(b.x1 - b.x0);
            const h = Math.round(b.y1 - b.y0);

            // Paint white box
            image.scan(x, y, w, h, function(px, py, idx) {
                this.bitmap.data[idx + 0] = 255;
                this.bitmap.data[idx + 1] = 255;
                this.bitmap.data[idx + 2] = 255;
                this.bitmap.data[idx + 3] = 255;
            });

            resRegions.push({
                context: srcText,
                tranContent: dstText,
                boundingBox: `${x},${y},${w},${h}`
            });
        }

        const imageBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
        const finalResponse = {
            errorCode: 0,
            render_image: imageBuffer.toString("base64"),
            resRegions: resRegions
        };

        console.log("-".repeat(80));
        console.log("📤 SENDING NATIVE JSON TO PIXPIN");
        console.dir(finalResponse, { depth: 1, colors: true }); 
        console.log("=".repeat(80));

        res.json(finalResponse);

    } catch (err) {
        console.error("   ❌ ERROR:", err.message);
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));

module.exports = app;
