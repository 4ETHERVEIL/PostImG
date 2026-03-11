const express = require('express');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');
const app = express();

const upload = multer({ storage: multer.memoryStorage() });

// Token diambil dari Vercel Environment Variables
const TELE_TOKEN = process.env.TELE_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

app.post('/api/upload', upload.single('media'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'Pilih file terlebih dahulu' });

        const mime = req.file.mimetype;
        const originalName = req.file.originalname || 'Unknown_File';
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

        // === FITUR BARU: MENDETEKSI DEVICE & LOKASI ===
        // Mengambil data dari header yang disediakan otomatis oleh Vercel
        const ipInfo = req.headers['x-forwarded-for'] || 'Unknown IP';
        const userAgent = req.headers['user-agent'] || 'Unknown Device';
        const city = req.headers['x-vercel-ip-city'] || 'Unknown City';
        const country = req.headers['x-vercel-ip-country'] || 'Unknown Country';
        // ==============================================

        const form = new FormData();
        form.append('chat_id', CHAT_ID);
        form.append(fieldName, req.file.buffer, { filename: originalName });

        // === CAPTION DENGAN DATA PELACAK (Menggunakan format HTML agar aman) ===
        const caption = `🚀 <b>TELECLOUD SYSTEM - NODE ACTIVE</b>\n\n` +
                        `📁 <b>File:</b> ${originalName}\n` +
                        `⚙️ <b>Format:</b> ${mime}\n\n` +
                        `🕵️ <b>UPLOADER INTEL</b>\n` +
                        `🌐 <b>IP:</b> ${ipInfo}\n` +
                        `📍 <b>Location:</b> ${city}, ${country}\n` +
                        `📱 <b>Device:</b> <code>${userAgent}</code>\n\n` +
                        `✅ <i>Payload successfully stored in secure cloud.</i>`;
                        
        form.append('caption', caption);
        form.append('parse_mode', 'HTML'); 
        // ======================================================================

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
        
        const getFile = await axios.get(`https://api.telegram.org/bot${TELE_TOKEN}/getFile?file_id=${fileId}`);
        const filePath = getFile.data.result.file_path;

        const mediaRes = await axios({
            url: `https://api.telegram.org/file/bot${TELE_TOKEN}/${filePath}`,
            method: 'GET',
            responseType: 'stream'
        });

        res.setHeader('Content-Type', mediaRes.headers['content-type']);
        res.setHeader('Cache-Control', 'public, max-age=31536000'); 
        
        mediaRes.data.pipe(res);
    } catch (error) {
        console.error(error);
        res.status(404).send('File tidak ditemukan / sudah dihapus');
    }
});

module.exports = app;