import express from 'express';
import { OAuth2Client } from 'google-auth-library';
import { User } from '../models/User.js';

const router = express.Router();
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * POST /api/auth/google
 * Validates a Google OAuth2 token sent from the Chrome Extension
 * and creates/updates the User session in the database.
 */
router.post('/google', async (req, res) => {
    const { token } = req.body;

    if (!token) {
        return res.status(400).json({ error: 'OAuth token is required.' });
    }

    try {
        // Verify the token securely with Google servers to prevent spoofing
        const ticket = await client.verifyIdToken({
            idToken: token,
            audience: process.env.GOOGLE_CLIENT_ID
        });

        const payload = ticket.getPayload();

        if (!payload) {
            return res.status(401).json({ error: 'Invalid Google OAuth Token' });
        }

        const { sub: googleId, email, name: displayName, picture: pictureUrl } = payload;

        // Upsert User
        let user = await User.findOne({ googleId });
        if (!user) {
            user = new User({ googleId, email, displayName, pictureUrl });
        } else {
            user.lastLogin = Date.now();
            user.displayName = displayName;
            user.pictureUrl = pictureUrl;
        }
        await user.save();

        // In a production app, we would issue our own JWT session token here
        // For simplicity in this demo, we can just return the user DB ID as the session
        // or re-use the Google token as a bearer token if short-lived.
        // Let's generate a VERY simple mock session token for now.
        const sessionToken = Buffer.from(`${user._id}:${Date.now()}`).toString('base64');

        res.status(200).json({
            ok: true,
            user: {
                id: user._id,
                email: user.email,
                name: user.displayName,
                picture: user.pictureUrl
            },
            sessionToken
        });

    } catch (error) {
        console.error('[Nariya Auth] Google Verification Error:', error.message);
        res.status(401).json({ error: 'Authentication failed. Token may be expired or invalid.' });
    }
});

export default router;
