const axios = require('axios');
const cheerio = require('cheerio');

const SCRAPER_API_URL = 'http://api.scraperapi.com';

async function scrapeAmazonBestSellers(amazonUrl) {
  const scraperApiKey = process.env.SCRAPER_API_KEY;

  if (!scraperApiKey) {
    throw new Error('SCRAPER_API_KEY environment variable is not set.');
  }

  const response = await axios.get(SCRAPER_API_URL, {
    params: {
      api_key: scraperApiKey,
      url: amazonUrl,
      autoparse: false,
    },
    timeout: 60000,
  });

  const html = response.data;
  const $ = cheerio.load(html);
  const products = [];

  // Amazon Best Sellers uses zg-item-immersion or s-result-item containers
  const selectors = [
    '.zg-item-immersion',
    '[data-component-type="s-search-result"]',
    '.zg_item',
    '[class*="zg-grid-general-faceout"]',
  ];

  let productItems = $([]);
  for (const sel of selectors) {
    productItems = $(sel);
    if (productItems.length > 0) break;
  }

  productItems.each((i, el) => {
    if (products.length >= 10) return false;

    const item = $(el);

    // Product name
    const nameSelectors = [
      '.p13n-sc-truncated',
      '.p13n-sc-truncate-desktop-type2',
      'a.a-link-normal span',
      '[class*="_cDEzb_p13n-sc-css-line-clamp"] span',
      '.zg-bdg-text + .p13n-sc-truncate-desktop-type2',
      'img[alt]',
    ];
    let name = '';
    for (const ns of nameSelectors) {
      name = item.find(ns).first().text().trim();
      if (!name && ns === 'img[alt]') {
        name = item.find('img').first().attr('alt') || '';
      }
      if (name && name.length > 3) break;
    }

    // Price
    const priceSelectors = [
      '.p13n-sc-price',
      '.a-price .a-offscreen',
      '.a-price-whole',
      '[class*="p13n-sc-price"]',
    ];
    let priceText = '';
    for (const ps of priceSelectors) {
      priceText = item.find(ps).first().text().trim();
      if (priceText) break;
    }
    const price = parseFloat(priceText.replace(/[^0-9.]/g, '')) || 0;

    // Rating
    const ratingText = item.find('.a-icon-alt').first().text().trim()
      || item.find('[class*="a-star"]').attr('title') || '';
    const ratingMatch = ratingText.match(/(\d+\.?\d*)\s*out of/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

    // Review count
    const reviewSelectors = [
      '.a-size-small span[aria-label]',
      'a[aria-label*="ratings"]',
      '.a-link-normal[href*="customerReviews"]',
    ];
    let reviewText = '';
    for (const rs of reviewSelectors) {
      reviewText = item.find(rs).first().text().trim()
        || item.find(rs).first().attr('aria-label') || '';
      if (reviewText) break;
    }
    const reviewCount = parseInt(reviewText.replace(/[^0-9]/g, '')) || 0;

    // BSR rank — the item's position on the list is its rank
    const rank = i + 1;

    if (name && name.length > 3) {
      products.push({ rank, name, price, rating, reviewCount });
    }
  });

  // Fallback: if structured parsing found nothing, do a loose scan for product titles
  if (products.length === 0) {
    let rank = 1;
    $('a.a-link-normal').each((_, el) => {
      if (products.length >= 10) return false;
      const title = $(el).text().trim();
      if (title.length > 15 && title.length < 300 && !title.toLowerCase().includes('see')) {
        products.push({ rank, name: title, price: 0, rating: 0, reviewCount: 0 });
        rank++;
      }
    });
  }

  if (products.length === 0) {
    throw new Error(
      'No products found on the page. The URL may not be an Amazon Best Sellers page, ' +
      'or Amazon may have changed its layout. Please verify the URL and try again.'
    );
  }

  return products.slice(0, 10);
}

module.exports = { scrapeAmazonBestSellers };
