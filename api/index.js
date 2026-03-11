const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// Token diambil dari Vercel Environment Variables
const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

// ENDPOINT 1: Upload file ke Telegram
app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const mime = req.file.mimetype;
        let endpoint = 'sendDocument';
        let fieldName = 'document';

        // Deteksi jenis file otomatis
        if (mime.startsWith('image/') && mime !== 'image/gif') {
            endpoint = 'sendPhoto';
            fieldName = 'photo';
        } else if (mime.startsWith('video/')) {
            endpoint = 'sendVideo';
            fieldName = 'video';
        } else if (mime === 'image/gif') {
            endpoint = 'sendAnimation';
            fieldName = 'animation';
        }

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append(fieldName, req.file.buffer, { filename: req.file.originalname || 'file' });

        // Upload ke Telegram
        const teleRes = await axios.post(`https://api.telegram.org/bot${TELE_TOKEN}/${endpoint}`, form, {
            headers: form.getHeaders()
        });

        const result = teleRes.data.result;
        let fileId;

        // Dapatkan File ID
        if (endpoint === 'sendPhoto') {
            fileId = result.photo.pop().file_id; 
        } else if (endpoint === 'sendVideo') {
            fileId = result.video.file_id;
        } else if (endpoint === 'sendAnimation') {
            fileId = result.animation.file_id;
        } else {
            fileId = result.document.file_id;
        }

        // Buat URL dengan domain Vercel Anda
        const protocol = req.headers['x-forwarded-proto'] || 'http';
        const host = req.headers.host;
        const customUrl = `${protocol}://${host}/v/${fileId}`;

        res.json({ url: customUrl });
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).json({ error: 'Gagal upload ke storage Telegram' });
    }
});

// ENDPOINT 2: Menampilkan file di browser
app.get('/v/:fileId', async (req, res) => {
    try {
        const { fileId } = req.params;
        
        // Dapatkan Path File
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;

        // Download stream dari Telegram
        const mediaRes = await axios({
            url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`,
            method: 'GET',
            responseType: 'stream'
        });

        // Set Header format agar browser tahu ini gambar atau video
        res.setHeader('Content-Type', mediaRes.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        
        mediaRes.data.pipe(res);
    } catch (error) {
        console.error(error);
        res.status(404).send('File tidak ditemukan / sudah dihapus');
    }
});

module.exports = app;