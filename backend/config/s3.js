import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Configure AWS SDK to work with Oracle Object Storage's S3 Compatible API
 */
export const s3Client = new S3Client({
    region: process.env.ORACLE_S3_REGION || 'us-ashburn-1',
    endpoint: process.env.ORACLE_S3_ENDPOINT,
    credentials: {
        accessKeyId: process.env.ORACLE_S3_ACCESS_KEY,
        secretAccessKey: process.env.ORACLE_S3_SECRET_KEY
    },
    forcePathStyle: true // Highly recommended for S3 compatible APIs
});

const BUCKET_NAME = process.env.ORACLE_S3_BUCKET || 'nariya_mocks';

/**
 * Uploads a mock response body to Oracle Object Storage
 * @param {string} key Unique identifier for the mock
 * @param {string|Buffer} body The mock response payload
 * @param {string} contentType MIME type
 */
export const uploadMockToStorage = async (key, body, contentType = 'application/json') => {
    try {
        const command = new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            Body: body,
            ContentType: contentType
        });
        await s3Client.send(command);
        return true;
    } catch (error) {
        console.error('[Nariya S3] Upload Error:', error);
        throw error;
    }
};

/**
 * Generates a pre-signed URL to securely download/stream the mock response directly to the extension
 * @param {string} key Unique identifier for the mock
 * @returns {string} Signed URL valid for 1 hour
 */
export const getMockSignedUrl = async (key) => {
    try {
        const command = new GetObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key
        });
        const url = await getSignedUrl(s3Client, command, { expiresIn: 3600 });
        return url;
    } catch (error) {
        console.error('[Nariya S3] Generate URL Error:', error);
        throw error;
    }
};
