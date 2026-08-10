// config/cloudinary.js
// Cloudinary configuration for production-ready image uploads
// Uses environment variables: CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET

const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const multer = require('multer');

// Configure Cloudinary
// ⚠️ IMPORTANT: Set CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY, and CLOUDINARY_API_SECRET
// as environment variables on Render. Do NOT commit API secrets to the codebase.
if (!process.env.CLOUDINARY_CLOUD_NAME) {
  console.warn('⚠️ CLOUDINARY_CLOUD_NAME not set. Image uploads will fail.');
}
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configure Multer storage to upload directly to Cloudinary
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'binsaleh-products',
    allowed_formats: ['jpg', 'jpeg', 'png', 'gif', 'webp'], // SVG excluded — can carry scripts (XSS)
    transformation: [{ width: 1200, height: 1200, crop: 'limit', quality: 'auto' }],
    public_id: (req, file) => 'product_' + Date.now() + '_' + Math.round(Math.random() * 100000)
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
});

module.exports = { cloudinary, upload };
