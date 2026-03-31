// ═══════════════════════════════════════════════════════════════
// ShelfScout Backend — Amazon PA-API Proxy
// ═══════════════════════════════════════════════════════════════
// Runs on Render.com (free tier) or any Node.js host.
// Keeps your Amazon PA-API credentials SECRET on the server.
// ShelfScout app sends: GET /lookup?barcode=012345678905
// This server signs the request and returns product data.
// ═══════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const axios   = require('axios');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Credentials (set in Render.com environment variables) ──────
const PA_ACCESS_KEY  = process.env.PA_ACCESS_KEY  || '';
const PA_SECRET_KEY  = process.env.PA_SECRET_KEY  || '';
const PA_PARTNER_TAG = process.env.PA_PARTNER_TAG || '';
const PA_REGION      = process.env.PA_REGION      || 'us-east-1';
const PA_HOST        = process.env.PA_HOST        || 'webservices.amazon.com';
const KEEPA_KEY      = process.env.KEEPA_KEY      || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*'; // Set to your ShelfScout URL in production

// ── CORS — only allow your ShelfScout app ─────────────────────
app.use(cors({
  origin: ALLOWED_ORIGIN,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

// ── Health check ───────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    service: 'ShelfScout Backend',
    version: '1.0.0',
    status:  'running',
    paapi:   !!PA_ACCESS_KEY,
    keepa:   !!KEEPA_KEY,
    time:    new Date().toISOString(),
  });
});

// ═══════════════════════════════════════════════════════════════
// MAIN ENDPOINT: GET /lookup?barcode=012345678905
// ShelfScout calls this for every real barcode scan.
// Returns ShelfScout intel format.
// ═══════════════════════════════════════════════════════════════
app.get('/lookup', async (req, res) => {
  const barcode = (req.query.barcode || '').trim();
  if (!barcode) return res.status(400).json({ error: 'barcode required' });

  console.log(`[lookup] barcode=${barcode}`);

  try {
    // ── Step 1: Search Amazon by UPC/EAN ──────────────────────
    const searchResult = await papiSearchByBarcode(barcode);
    if (!searchResult) {
      return res.json({ found: false, barcode, message: 'No Amazon listing found for this barcode' });
    }

    const { asin, title, brand, category, imageUrl, price } = searchResult;

    // ── Step 2: Get full item details (reviews, rank, etc.) ───
    const details = await papiGetItemDetails(asin);

    // ── Step 3: Get Keepa data if key is set ─────────────────
    const keepaData = KEEPA_KEY ? await keepaLookup(asin) : null;

    // ── Step 4: Build ShelfScout intel object ─────────────────
    const intel = buildIntel({ asin, barcode, title, brand, category, imageUrl, price, details, keepaData });

    console.log(`[lookup] found: ${title} (${asin}) score=${intel.s.ov}`);
    res.json(intel);

  } catch (err) {
    console.error('[lookup] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /asin/:asin — look up a specific ASIN directly
// ═══════════════════════════════════════════════════════════════
app.get('/asin/:asin', async (req, res) => {
  const asin = req.params.asin.toUpperCase().trim();
  if (!asin) return res.status(400).json({ error: 'asin required' });

  try {
    const searchResult = await papiGetItemDetails(asin);
    if (!searchResult) return res.json({ found: false, asin });

    const intel = buildIntel({
      asin,
      barcode: '',
      title:    searchResult.title    || '',
      brand:    searchResult.brand    || '',
      category: searchResult.category || '',
      imageUrl: searchResult.imageUrl || '',
      price:    searchResult.price    || 0,
      details:  searchResult,
      keepaData: KEEPA_KEY ? await keepaLookup(asin) : null,
    });

    res.json(intel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════
// GET /status — check which APIs are configured
// ═══════════════════════════════════════════════════════════════
app.get('/status', (req, res) => {
  res.json({
    paapi: {
      configured: !!(PA_ACCESS_KEY && PA_SECRET_KEY && PA_PARTNER_TAG),
      region:     PA_REGION,
      host:       PA_HOST,
    },
    keepa: {
      configured: !!KEEPA_KEY,
    },
  });
});

// ═══════════════════════════════════════════════════════════════
// AMAZON PA-API v5  — AWS Signature V4
// ═══════════════════════════════════════════════════════════════

// Search Amazon for a product by UPC/EAN barcode
async function papiSearchByBarcode(barcode) {
  if (!PA_ACCESS_KEY || !PA_SECRET_KEY || !PA_PARTNER_TAG) {
    console.warn('[paapi] credentials not configured');
    return null;
  }

  const payload = {
    Keywords:       barcode,
    SearchIndex:    'All',
    PartnerTag:     PA_PARTNER_TAG,
    PartnerType:    'Associates',
    Resources: [
      'Images.Primary.Large',
      'ItemInfo.Title',
      'ItemInfo.ByLineInfo',
      'ItemInfo.Classifications',
      'Offers.Listings.Price',
      'Offers.Summaries.HighestPrice',
      'Offers.Summaries.LowestPrice',
    ],
  };

  try {
    const response = await papiRequest('SearchItems', payload);
    const items    = response?.SearchResult?.Items;
    if (!items || items.length === 0) return null;

    const item  = items[0];
    return extractItemData(item);
  } catch (e) {
    console.error('[paapi] SearchItems error:', e.message);
    return null;
  }
}

// Get full details for a known ASIN
async function papiGetItemDetails(asin) {
  if (!PA_ACCESS_KEY || !PA_SECRET_KEY || !PA_PARTNER_TAG) return null;

  const payload = {
    ItemIds:     [asin],
    PartnerTag:  PA_PARTNER_TAG,
    PartnerType: 'Associates',
    Resources: [
      'Images.Primary.Large',
      'ItemInfo.Title',
      'ItemInfo.ByLineInfo',
      'ItemInfo.Classifications',
      'ItemInfo.ContentRating',
      'Offers.Listings.Price',
      'Offers.Listings.Promotions',
      'Offers.Summaries.HighestPrice',
      'Offers.Summaries.LowestPrice',
      'CustomerReviews.Count',
      'CustomerReviews.StarRating',
      'BrowseNodeInfo.BrowseNodes',
    ],
  };

  try {
    const response = await papiRequest('GetItems', payload);
    const items    = response?.ItemsResult?.Items;
    if (!items || items.length === 0) return null;
    return extractItemData(items[0]);
  } catch (e) {
    console.error('[paapi] GetItems error:', e.message);
    return null;
  }
}

// Extract and normalize item data from PA-API response
function extractItemData(item) {
  if (!item) return null;

  const title    = item.ItemInfo?.Title?.DisplayValue || '';
  const brand    = item.ItemInfo?.ByLineInfo?.Brand?.DisplayValue
                || item.ItemInfo?.ByLineInfo?.Manufacturer?.DisplayValue
                || '';
  const category = item.ItemInfo?.Classifications?.ProductGroup?.DisplayValue
                || item.BrowseNodeInfo?.BrowseNodes?.[0]?.DisplayName
                || 'General';
  const imageUrl = item.Images?.Primary?.Large?.URL || '';
  const price    = item.Offers?.Listings?.[0]?.Price?.Amount
                || item.Offers?.Summaries?.[0]?.LowestPrice?.Amount
                || 0;
  const reviews  = item.CustomerReviews?.Count        || 0;
  const rating   = item.CustomerReviews?.StarRating?.Value || 0;
  const asin     = item.ASIN || '';
  const detailUrl = item.DetailPageURL || `https://www.amazon.com/dp/${asin}`;

  return { asin, title, brand, category, imageUrl, price, reviews, rating, detailUrl };
}

// ── AWS Signature V4 request signer ───────────────────────────
async function papiRequest(operation, payload) {
  const service   = 'ProductAdvertisingAPI';
  const path      = `/paapi5/${operation.toLowerCase()}`;
  const endpoint  = `https://${PA_HOST}${path}`;
  const body      = JSON.stringify(payload);
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z';
  const dateStamp = amzDate.slice(0, 8);

  // Headers
  const headers = {
    'content-encoding':  'amz-1.0',
    'content-type':      'application/json; charset=utf-8',
    'host':              PA_HOST,
    'x-amz-date':        amzDate,
    'x-amz-target':      `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${operation}`,
  };

  // Canonical request
  const canonicalHeaders = Object.keys(headers).sort()
    .map(k => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = Object.keys(headers).sort().join(';');
  const payloadHash   = sha256(body);
  const canonicalReq  = [
    'POST', path, '',
    canonicalHeaders, signedHeaders, payloadHash,
  ].join('\n');

  // String to sign
  const credScope    = `${dateStamp}/${PA_REGION}/${service}/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${credScope}\n${sha256(canonicalReq)}`;

  // Signing key
  const signingKey = hmac(
    hmac(hmac(hmac('AWS4' + PA_SECRET_KEY, dateStamp), PA_REGION), service),
    'aws4_request', false
  );
  const signature = hmac(signingKey, stringToSign);

  // Authorization header
  headers['Authorization'] = [
    `AWS4-HMAC-SHA256 Credential=${PA_ACCESS_KEY}/${credScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  const response = await axios.post(endpoint, body, { headers });
  return response.data;
}

// Crypto helpers
function sha256(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data, hex = true) {
  const h = crypto.createHmac('sha256', key).update(data, 'utf8');
  return hex ? h.digest('hex') : h.digest();
}

// ═══════════════════════════════════════════════════════════════
// KEEPA API — Sales rank history, price history
// ═══════════════════════════════════════════════════════════════
async function keepaLookup(asin) {
  if (!KEEPA_KEY) return null;
  try {
    const url = `https://api.keepa.com/product?key=${KEEPA_KEY}&domain=1&asin=${asin}&stats=90&offers=20`;
    const res = await axios.get(url, { timeout: 8000 });
    const product = res.data?.products?.[0];
    if (!product) return null;

    // Extract useful metrics
    const stats    = product.stats || {};
    const salesRank90 = stats.avg?.[3] || 0;     // avg sales rank last 90d
    const current  = product.csv?.[3];             // current sales rank array
    const rankNow  = current ? current[current.length - 1] : 0;

    // Estimate monthly sales from sales rank (rough formula for US)
    const estimatedMonthlySales = salesRankToMonthlySales(rankNow);

    return {
      asin,
      salesRank:    rankNow,
      avgRank90d:   salesRank90,
      monthlySales: estimatedMonthlySales,
      source:       'Keepa',
    };
  } catch (e) {
    console.warn('[keepa] lookup failed:', e.message);
    return null;
  }
}

// Rough sales rank → monthly units estimate (US, all categories)
function salesRankToMonthlySales(rank) {
  if (!rank || rank <= 0) return 0;
  if (rank <= 100)    return 8000;
  if (rank <= 500)    return 4000;
  if (rank <= 1000)   return 2500;
  if (rank <= 3000)   return 1500;
  if (rank <= 5000)   return 900;
  if (rank <= 10000)  return 550;
  if (rank <= 25000)  return 300;
  if (rank <= 50000)  return 180;
  if (rank <= 100000) return 100;
  if (rank <= 250000) return 50;
  if (rank <= 500000) return 25;
  return 10;
}

// ═══════════════════════════════════════════════════════════════
// BUILD ShelfScout INTEL OBJECT
// Transforms API data → ShelfScout scoring format
// ═══════════════════════════════════════════════════════════════
function buildIntel({ asin, barcode, title, brand, category, imageUrl, price, details, keepaData }) {
  const reviews = details?.reviews || 0;
  const rating  = parseFloat(details?.rating) || 0;

  // Use Keepa sales data if available, otherwise estimate from rank
  const monthlySales = keepaData?.monthlySales || estimateSalesFromCategory(category, reviews);

  // Carousel saturation estimate (rough: popular products = more carousel videos)
  const topCar = estimateCarousel(reviews, monthlySales);

  // Commission campaign — PA-API doesn't expose this directly
  // Default to no campaign; users can check their Influencer dashboard
  const campaign = {
    active: false,
    pct:    0,
    days:   0,
    name:   '',
  };

  const m = {
    sold:      monthlySales,
    topCar,
    lowCar:    topCar + 5,
    topBrand:  Math.floor(topCar / 2),
    topInfl:   Math.max(0, topCar - 2),
    rating,
    reviews,
    price:     parseFloat(price) || 0,
    salesRank: keepaData?.salesRank || 0,
    source:    keepaData ? 'PA-API + Keepa' : 'PA-API',
  };

  const p = {
    asin,
    title:     title     || 'Unknown product',
    brand:     brand     || 'Unknown brand',
    category:  category  || 'General',
    img:       imageUrl  || '',
    upc:       barcode,
    detailUrl: details?.detailUrl || `https://www.amazon.com/dp/${asin}`,
  };

  // Score using same logic as the app
  const s = scoreIntel(m, campaign);

  return {
    fromAPI:  'paapi',
    source:   keepaData ? 'PA-API + Keepa' : 'Amazon PA-API',
    asin,
    barcode,
    p, m,
    c: campaign,
    s,
  };
}

// Estimate monthly sales if no Keepa data
function estimateSalesFromCategory(category, reviews) {
  const cat = (category || '').toLowerCase();
  const base = cat.includes('kitchen') ? 300
    : cat.includes('beauty')           ? 250
    : cat.includes('health')           ? 200
    : cat.includes('sports')           ? 180
    : cat.includes('toy')              ? 220
    : cat.includes('electronic')       ? 350
    : cat.includes('food')             ? 400
    : 150;
  // Adjust by review count (more reviews = more sales)
  const reviewFactor = reviews > 10000 ? 2.0
    : reviews > 5000                   ? 1.5
    : reviews > 1000                   ? 1.2
    : reviews > 100                    ? 1.0
    : 0.6;
  return Math.round(base * reviewFactor);
}

// Estimate carousel saturation from reviews
function estimateCarousel(reviews, sales) {
  // Rough heuristic: popular products have more carousel videos
  if (reviews > 50000 || sales > 1000) return 8;
  if (reviews > 10000 || sales > 500)  return 5;
  if (reviews > 1000  || sales > 200)  return 3;
  if (reviews > 100   || sales > 50)   return 1;
  return 0;
}

// Score calculation (mirrors ShelfScout app logic)
function scoreIntel(m, c) {
  const w = { demand:0.30, carousel:0.25, campaign:0.20, review:0.15, urgency:0.10 };
  const t = w.demand + w.carousel + w.campaign + w.review + w.urgency;

  const d  = m.sold>=500?100:m.sold>=250?80:m.sold>=100?60:m.sold>=50?40:20;
  const cr = m.topCar===0?100:m.topCar<=2?85:m.topCar<=4?65:m.topCar<=7?40:15;
  const cp = !c.active?10:c.pct>=10?100:c.pct>=6?80:c.pct>=1?55:10;
  const rv = m.rating>=4.5&&m.reviews>=1000?100:m.rating>=4.2&&m.reviews>=250?75:m.rating>=4.0&&m.reviews>=100?55:m.reviews>0?35:20;
  const ug = !c.active||c.days<=0?0:c.days<=3?100:c.days<=7?80:c.days<=14?60:c.days<=30?40:20;

  const ov  = Math.max(0, Math.min(100, Math.round((d*w.demand+cr*w.carousel+cp*w.campaign+rv*w.review+ug*w.urgency)/t)));
  const col = ov>=85?'dg':ov>=70?'g':ov>=50?'y':ov>=30?'o':'r';
  const txt = ov>=85?'Buy now · Film ASAP':ov>=70?'Strong opportunity':ov>=50?'Maybe worth testing':ov>=30?'Weak opportunity':'Skip this product';

  const badges = [];
  if (m.sold>=250)                       badges.push('HOT DEMAND');
  if (m.topCar<=2)                       badges.push('LOW COMPETITION');
  if (c.active)                          badges.push('CAMPAIGN ACTIVE');
  if (c.pct>=10)                         badges.push('HIGH COMMISSION');
  if (c.active&&c.days>0&&c.days<=7)     badges.push('ENDING SOON');
  if (m.topCar>=8)                       badges.push('SATURATED');
  if (m.reviews<100||m.rating<4.0)       badges.push('LOW REVIEWS');
  if (!c.active)                         badges.push('NO CAMPAIGN');
  if (m.salesRank>0&&m.salesRank<=1000)  badges.push('TOP 1000 RANK');
  if (m.salesRank>0&&m.salesRank<=100)   badges.push('🔥 TOP 100 RANK');

  return { ov, d, cr, cp, rv, ug, col, txt, badges };
}

// ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════╗
║     ShelfScout Backend — Running          ║
║     Port: ${PORT}                              ║
║     PA-API: ${PA_ACCESS_KEY ? '✅ Configured' : '❌ Not set  '}              ║
║     Keepa:  ${KEEPA_KEY     ? '✅ Configured' : '❌ Not set  '}              ║
╚═══════════════════════════════════════════╝
  `);
});
