// controllers/settingsController.js
// CRUD for Settings model — used for CMS, announcements, slider, setup key, categories, coupons, etc.
// Auto-creates default settings so the frontend never gets 404.

const Settings = require('../models/Settings');

// Default values for all known settings keys
const DEFAULT_SETTINGS = {
  announcement_text: '🚚  Free Shipping on Orders Above Rs. 10,000  |  💰  COD Available Nationwide  |  🔄  Easy Exchange Policy  |  ✅  Rs. 250 Advance Required to Confirm Order  |  ⭐  Summer Élite \'26 Collection is Live!',
  hero_slides: [
    { title:'Summer<br/><span>Élite</span><br/>\'26', tag:'New Arrival', sub:'Elevate your style with our latest premium collection.', link:'view-all.html', cta:'Shop Now', img:'' },
    { title:'Fresh<br/><span>Tops</span><br/>Collection', tag:'Premium Tops', sub:'From box-fit to oversized, our tops redefine casual streetwear.', link:'tops.html', cta:'Explore Tops', img:'' },
    { title:'Match the<br/><span>Vibe</span>', tag:'Co-Ord Sets', sub:'Complete co-ord sets and tracksuits for that perfectly curated look.', link:'tracksuits.html', cta:'Shop Sets', img:'' },
    { title:'Scent That<br/><span>Speaks</span>', tag:'Fragrances', sub:'Exclusive fragrances that leave a lasting impression.', link:'fragrances.html', cta:'Discover Now', img:'' },
    { title:'Step In<br/><span>Style</span>', tag:'Footwear', sub:'Premium footwear collection — from Adidas Samba to exclusive sneakers.', link:'footwear.html', cta:'View Shoes', img:'' }
  ],
  bank_settings: { advanceAmount:250, whatsapp:'9710566551046', deposit:[{ label:'Emirates NBD (AED): 0123456789', value:'emirates_nbd' },{ label:'ADCB (AED): 9876543210', value:'adcb' },{ label:'FAB Bank Transfer: A/C 1234567890', value:'fab' },{ label:'Mashreq Bank Transfer: A/C 0987654321', value:'mashreq' }] },
  shipping_settings: { standardFee:25, expressFee:50, freeThreshold:300 },
  cod_settings: { enabled:true, advanceType:'fixed', fixedAmount:50, percentage:30 },
  business_email: 'binsalehllc946@gmail.com',
  smtp_settings: {
    host: 'smtp.gmail.com',
    port: 587,
    secure: false,
    user: '',
    pass: ''
  },
  pixel_settings: { fb:{ enabled:false, pixelId:'' }, tiktok:{ enabled:false, pixelId:'' }, ga:{ enabled:false, trackingId:'' } },
  payment_settings: {
    methods: [
      {
        id: 'cod',
        name: 'Cash on Delivery',
        icon: 'fas fa-money-bill-wave',
        enabled: true,
        type: 'cod',
        sortOrder: 0
      },
      {
        id: 'zeina',
        name: 'Zeina (Card / Apple Pay)',
        icon: 'fas fa-credit-card',
        enabled: true,
        type: 'gateway',
        sortOrder: 1,
        config: {
          accessToken: '',
          mode: 'test'
        }
      },
      {
        id: 'paypal',
        name: 'PayPal / Credit / Debit Card',
        icon: 'fab fa-paypal',
        enabled: true,
        type: 'gateway',
        sortOrder: 2,
        config: {
          clientId: '',
          clientSecret: '',
          mode: 'sandbox'
        }
      }
    ]
  },
  categories: [
    { name:'Tops', slug:'tops', desc:'Box-fit, Oversized & More', img:'', active:true },
    { name:'Bottoms', slug:'bottoms', desc:'Korean Pants, Cargos & More', img:'', active:true },
    { name:'Tracksuits', slug:'tracksuits', desc:'Co-Ord Sets & Matching Suits', img:'', active:true },
    { name:'Footwear', slug:'footwear', desc:'Sneakers, Trainers & More', img:'', active:true },
    { name:'Fragrances', slug:'fragrances', desc:'Exclusive Signature Scents', img:'', active:true },
    { name:'Accessories', slug:'accessories', desc:'Watches, Sunglasses, Bracelets', img:'', active:true },
    { name:'Home & Kitchen', slug:'home-kitchen', desc:'Cookware, Decor & More', img:'', active:true }
  ],
  coupons: [
    { code:'SUMMER26', type:'percentage', discount:20, minOrder:2000, maxUses:100, used:0, expiry:'2026-06-30', active:true },
    { code:'BS250', type:'flat', discount:250, minOrder:1500, maxUses:500, used:0, expiry:'2026-07-15', active:true },
    { code:'ELITE10', type:'percentage', discount:10, minOrder:5000, maxUses:50, used:0, expiry:'2026-06-20', active:true }
  ],
  collections: [
    { slug:'tops', name:'Tops', desc:'Box-fit, Oversized & More', link:'tops.html', img:'' },
    { slug:'bottoms', name:'Bottoms', desc:'Korean Pants, Cargos & More', link:'bottoms.html', img:'' },
    { slug:'tracksuits', name:'Tracksuits', desc:'Co-Ord Sets & Matching Suits', link:'tracksuits.html', img:'' },
    { slug:'footwear', name:'Footwear', desc:'Sneakers, Trainers & More', link:'footwear.html', img:'' },
    { slug:'fragrances', name:'Fragrances', desc:'Exclusive Signature Scents', link:'fragrances.html', img:'' },
    { slug:'accessories', name:'Accessories', desc:'Watches, Sunglasses, Bracelets', link:'accessories.html', img:'' },
    { slug:'home-kitchen', name:'Home & Kitchen', desc:'Cookware, Decor & More', link:'home-kitchen.html', img:'' }
  ]
};

// Helper: get setting with auto-create fallback
async function getOrCreateSetting(key) {
  let setting = await Settings.findOne({ key });
  if (!setting) {
    const defaultValue = DEFAULT_SETTINGS[key];
    if (defaultValue !== undefined) {
      setting = await Settings.create({ key, value: defaultValue });
    }
  }
  return setting;
}

exports.getSetting = async (req, res) => {
  try {
    const setting = await getOrCreateSetting(req.params.key);
    if (!setting) return res.status(404).json({ message: 'Setting not found' });
    res.json(setting);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getAllSettings = async (req, res) => {
  try {
    const settings = await Settings.find().sort({ key: 1 });
    res.json(settings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateSetting = async (req, res) => {
  try {
    const { value } = req.body;
    const setting = await Settings.findOneAndUpdate(
      { key: req.params.key },
      { value },
      { upsert: true, new: true, runValidators: true }
    );
    res.json(setting);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
};

exports.deleteSetting = async (req, res) => {
  try {
    const setting = await Settings.findOneAndDelete({ key: req.params.key });
    if (!setting) return res.status(404).json({ message: 'Setting not found' });
    res.json({ message: 'Setting deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
