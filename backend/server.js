import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import { connectDB } from './config/db.js';
import authRoutes from './routes/auth.js';
import rulesRoutes from './routes/rules.js';
import mockRoutes from './routes/mocks.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

// Security Middleware
app.use(helmet());
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*'
}));
app.use(express.json());

// Initialize MongoDB
connectDB();

// Basic health check
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', timestamp: Date.now() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/rules', rulesRoutes);
app.use('/api/mocks', mockRoutes);

// Start Server
app.listen(PORT, () => {
    console.log(`[Nariya Backend] Server running on port ${PORT}`);
});
