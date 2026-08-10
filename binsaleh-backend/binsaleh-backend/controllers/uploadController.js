// controllers/uploadController.js
// Cloudinary image upload controller
// Supports: upload from PC (multipart) and upload by URL (fetch + upload to Cloudinary)

const { cloudinary } = require('../config/cloudinary');
const axios = require('axios');

// POST /api/upload
// Upload image from PC (multipart/form-data)
exports.uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }
    res.json({
      message: 'Image uploaded successfully',
      url: req.file.path,
      public_id: req.file.filename
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// POST /api/upload/url
// Upload image from URL (fetch image and upload to Cloudinary)
// 
// WHY THIS FIX: Passing the URL directly to cloudinary.uploader.upload(url)
// makes Cloudinary's servers fetch it — but many CDNs block Cloudinary's IP
// ranges or check User-Agent/Referer headers (hotlink protection).
//
// SOLUTION: We download the image server-side FIRST via axios with a real
// browser User-Agent (bypasses hotlink protection at the network level),
// then upload the binary data (as base64 data URI) to Cloudinary.
exports.uploadFromUrl = async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) {
      return res.status(400).json({ message: 'No URL provided' });
    }

    // Step 1: Download the image from the URL using our own server
    // This bypasses hotlink protection because:
    //   - We set a real browser User-Agent
    //   - The request comes from our server's IP, not Cloudinary's
    //   - We don't send a Referer header that would trigger blocking
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 20000, // 20 seconds for large images
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
      },
      maxRedirects: 5,
      // Some servers check the Origin/Referer — we don't send one
      // so they can't block based on it
      validateStatus: function (status) {
        return status >= 200 && status < 400; // Accept redirects too
      }
    });

    // Check if we actually got an image
    const contentType = response.headers['content-type'] || '';
    if (!contentType.startsWith('image/')) {
      return res.status(400).json({
        message: 'The URL does not point to a valid image. Content-Type: ' + contentType
      });
    }

    // Step 2: Convert the downloaded image to a base64 data URI
    const buffer = Buffer.from(response.data);
    const base64 = buffer.toString('base64');
    const dataUri = 'data:' + contentType + ';base64,' + base64;

    // Step 3: Upload the base64 image data to Cloudinary
    // (Cloudinary accepts data URIs just fine)
    const result = await cloudinary.uploader.upload(dataUri, {
      folder: 'binsaleh-products',
      quality: 'auto',
      resource_type: 'image'
    });

    res.json({
      message: 'Image uploaded from URL successfully',
      url: result.secure_url,
      public_id: result.public_id
    });
  } catch (err) {
    console.error('uploadFromUrl error:', err.message);
    // Give more specific error messages
    // Check specific HTTP status codes FIRST (from axios response), then fall back to error codes
    if (err.response) {
      if (err.response.status === 403) {
        return res.status(400).json({ message: 'The image server blocked the request (403 Forbidden). Try downloading the image to your computer and uploading it directly instead.' });
      }
      if (err.response.status === 404) {
        return res.status(400).json({ message: 'Image not found at that URL (404). Please check the URL and try again.' });
      }
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return res.status(400).json({ message: 'Cannot reach the image URL — the server may be down or the URL is invalid.' });
    }
    if (err.http_code === 403) {
      return res.status(400).json({ message: 'Cloudinary blocked the upload — the image may violate their terms or be from a restricted source.' });
    }
    res.status(500).json({ message: 'Failed to upload from URL: ' + err.message });
  }
};

// POST /api/upload/delete
// Delete an image from Cloudinary by public_id or URL
exports.deleteImage = async (req, res) => {
  try {
    const { public_id, url } = req.body;
    let id = public_id;

    // Extract public_id from URL if only url is provided
    if (!id && url) {
      const parts = url.split('/');
      const fileWithExt = parts[parts.length - 1];
      const folder = 'binsaleh-products';
      id = folder + '/' + fileWithExt.split('.')[0];
    }

    if (!id) {
      return res.status(400).json({ message: 'No public_id or URL provided' });
    }

    await cloudinary.uploader.destroy(id);
    res.json({ message: 'Image deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
