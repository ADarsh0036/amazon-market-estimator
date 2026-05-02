require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const { scrapeAmazonBestSellers } = require('./scraper');
const { analyzeProducts } = require('./analyzer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main analysis endpoint
app.post('/api/analyze', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required.' });
  }

  // Basic URL validation
  if (!url.includes('amazon.') && !url.includes('amzn.')) {
    return res.status(400).json({
      error: 'Please provide a valid Amazon URL.',
    });
  }

  try {
    console.log(`[${new Date().toISOString()}] Scraping: ${url}`);
    const products = await scrapeAmazonBestSellers(url);
    console.log(`  → Found ${products.length} products`);

    console.log(`[${new Date().toISOString()}] Sending to Claude for analysis...`);
    const analyzed = await analyzeProducts(products);
    console.log(`  → Analysis complete`);

    const totalRevenue = analyzed.reduce(
      (sum, p) => sum + (p.estimated_monthly_revenue || 0),
      0
    );

    res.json({
      success: true,
      url,
      products: analyzed,
      totalMonthlyRevenue: totalRevenue,
      scrapedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error(`[ERROR] ${err.message}`);

    // Return a user-friendly error
    const userMessage = err.message.includes('SCRAPER_API_KEY')
      ? 'ScraperAPI key is not configured. Please add it to the .env file.'
      : err.message.includes('ANTHROPIC_API_KEY')
      ? 'Anthropic API key is not configured. Please add it to the .env file.'
      : err.message.includes('No products found')
      ? err.message
      : 'Failed to analyze the page. Please check the URL and try again.';

    res.status(500).json({ error: userMessage, details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅ Amazon Market Estimator backend running on http://localhost:${PORT}`);
  console.log(`   POST /api/analyze  — analyze a Best Sellers URL`);
  console.log(`   GET  /health       — health check\n`);
});
