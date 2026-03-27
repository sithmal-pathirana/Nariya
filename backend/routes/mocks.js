import express from 'express';
import multer from 'multer';
import { uploadMockToStorage, getMockSignedUrl } from '../config/s3.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

/**
 * Basic Middleware to ensure a session token exists.
 */
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    try {
        const token = authHeader.split(' ')[1];
        const decoded = Buffer.from(token, 'base64').toString('ascii');
        const [userId] = decoded.split(':');

        if (!userId || userId === 'undefined') {
            return res.status(401).json({ error: 'Invalid token structure' });
        }

        req.userId = userId;
        next();
    } catch (e) {
        return res.status(401).json({ error: 'Failed to decode token' });
    }
};

router.use(requireAuth);

/**
 * POST /api/mocks/upload
 * Upload a large mock payload to Oracle Object Storage (S3 API)
 */
router.post('/upload', upload.single('mockFile'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file provided' });
        }

        const fileBuffer = req.file.buffer;
        const mimeType = req.file.mimetype;
        const key = `user_${req.userId}/mocks/${Date.now()}_${req.file.originalname}`;

        await uploadMockToStorage(key, fileBuffer, mimeType);
        const signedUrl = await getMockSignedUrl(key);

        res.json({ ok: true, key, signedUrl });
    } catch (error) {
        console.error('[Nariya Mocks] S3 Upload Error:', error);
        res.status(500).json({ error: 'Failed to upload mock file to object storage.' });
    }
});

/**
 * GET /api/mocks/url
 * Generate a fresh presigned URL for an existing mock object key
 */
router.get('/url', async (req, res) => {
    try {
        const { key } = req.query;
        if (!key) return res.status(400).json({ error: 'Object key required' });

        const signedUrl = await getMockSignedUrl(key);
        res.json({ ok: true, signedUrl });
    } catch (error) {
        console.error('[Nariya Mocks] URL Gen Error:', error);
        res.status(500).json({ error: 'Failed to generate signed URL.' });
    }
});

export default router;
