const express = require("express");
const axios = require("axios");
const multer = require("multer");
const Tesseract = require("tesseract.js");
const { Jimp } = require("jimp");

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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

app.post("/api/trans/sdk/picture", upload.single("image"), async (req, res) => {
    const fromRequested = req.query.from || req.body.from || "auto";
    const toRequested = req.query.to || req.body.to || "zh";
    if (!req.file) return res.json({ errorCode: 1, msg: "No image" });

    try {
        const tLang = getTessLang(fromRequested);
        const image = await Jimp.read(req.file.buffer);
        const ocrResult = await Tesseract.recognize(req.file.buffer, tLang, { cachePath: '/tmp' });

        const resRegions = [];
        let fragments = ocrResult.data.lines || ocrResult.data.words || [];

        for (let i = 0; i < fragments.length; i++) {
            const item = fragments[i];
            const srcText = item.text.trim();
            if (srcText.length < 1) continue;
            const dstText = (await translateWithGoogle(srcText, fromRequested, toRequested)) || srcText;

            const b = item.bbox;
            const x = Math.round(b.x0); const y = Math.round(b.y0);
            const w = Math.round(b.x1 - b.x0); const h = Math.round(b.y1 - b.y0);

            image.scan(x, y, w, h, function(px, py, idx) {
                this.bitmap.data[idx + 0] = 255; this.bitmap.data[idx + 1] = 255;
                this.bitmap.data[idx + 2] = 255; this.bitmap.data[idx + 3] = 255;
            });

            resRegions.push({ context: srcText, tranContent: dstText, boundingBox: `${x},${y},${w},${h}` });
        }

        const imageBuffer = await image.getBuffer("image/jpeg");
        res.json({ errorCode: 0, render_image: imageBuffer.toString("base64"), resRegions: resRegions });
    } catch (err) {
        res.json({ errorCode: 1, msg: err.message });
    }
});

app.get("/", (req, res) => res.send("🚀 PixPin Native Relay is LIVE"));
module.exports = app;
