const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// Ambil dari Environment Variables Vercel
const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/api/upload', upload.single('image'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append('photo', req.file.buffer, { filename: 'image.jpg' });

        // 1. Upload ke Telegram
        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/sendPhoto`, form, {
            headers: form.getHeaders()
        });

        // 2. Dapatkan File Path
        const fileId = teleRes.data.result.photo.pop().file_id;
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;

        // 3. Link Final
        const finalUrl = `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`;

        res.json({ url: finalUrl });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Gagal upload ke storage Telegram' });
    }
});

module.exports = app;