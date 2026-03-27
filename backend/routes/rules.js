import express from 'express';
import { Rule } from '../models/Rule.js';

const router = express.Router();

/**
 * Basic Middleware to ensure a session token exists.
 * In production, this verifies a JWT.
 */
const requireAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // Quick and dirty decode for the demo (we used base64 userId:timestamp)
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
 * GET /api/rules
 * Fetch all rules for the authenticated user, optionally filtered by workspace
 */
router.get('/', async (req, res) => {
    try {
        const workspaceId = req.query.workspaceId || 'default';
        const rules = await Rule.find({ userId: req.userId, workspaceId });

        // Transform to extension format
        const extensionRules = rules.map(r => ({
            id: r.extensionRuleId,
            type: r.type,
            urlFilter: r.urlFilter,
            config: r.config,
            isActive: r.isActive
        }));

        res.json({ ok: true, rules: extensionRules });
    } catch (error) {
        console.error('[Nariya Rules] Fetch Error:', error);
        res.status(500).json({ error: 'Failed to fetch rules.' });
    }
});

/**
 * PUT /api/rules/sync
 * Bulk sync (overwrite) rules for the user's workspace
 */
router.put('/sync', async (req, res) => {
    try {
        const { workspaceId = 'default', rules } = req.body;

        if (!Array.isArray(rules)) {
            return res.status(400).json({ error: 'Rules must be an array' });
        }

        // Delete all old rules for this workspace
        await Rule.deleteMany({ userId: req.userId, workspaceId });

        // Insert new rules
        const rulesToInsert = rules.map(r => ({
            userId: req.userId,
            workspaceId,
            extensionRuleId: r.id,
            type: r.type,
            urlFilter: r.urlFilter,
            config: r.config,
            isActive: r.isActive,
            updatedAt: Date.now()
        }));

        if (rulesToInsert.length > 0) {
            await Rule.insertMany(rulesToInsert);
        }

        res.json({ ok: true, count: rulesToInsert.length });
    } catch (error) {
        console.error('[Nariya Rules] Sync Error:', error);
        res.status(500).json({ error: 'Failed to sync rules.' });
    }
});

export default router;
