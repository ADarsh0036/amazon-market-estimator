const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const SYSTEM_PROMPT = `You are an Amazon market research expert. Given the following top products from an Amazon Best Sellers page, estimate the monthly unit sales and monthly revenue for each.

Use BSR (Best Seller Rank), price, ratings, and review count as signals:
- BSR 1 in a major category = 3000–5000 units/month
- BSR 10 = 1500–2500 units/month
- BSR 50 = 700–1200 units/month
- BSR 100 = 500–800 units/month
- BSR 500 = 150–300 units/month
- BSR 1000 = 100–200 units/month
- Scale non-linearly for positions in between

Adjust based on:
- Price: lower price = more units; higher price = fewer units
- Rating: 4.5+ stars boosts sales; below 4.0 reduces
- Review count: more reviews = established product = higher sales

Return ONLY a valid JSON array (no markdown, no code fences, no explanations) with exactly these fields per object:
[
  {
    "rank": 1,
    "name": "Product name",
    "price": 29.99,
    "estimated_monthly_sales": 4500,
    "estimated_monthly_revenue": 134955,
    "confidence": "high"
  }
]

confidence must be "high", "medium", or "low".`;

async function analyzeProducts(products) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const productList = products
    .map(
      (p) =>
        `Rank #${p.rank}: "${p.name}" | Price: $${p.price || 'N/A'} | Rating: ${p.rating || 'N/A'}/5 | Reviews: ${p.reviewCount || 'N/A'}`
    )
    .join('\n');

  const userMessage = `Here are the top ${products.length} products from an Amazon Best Sellers page:\n\n${productList}\n\nEstimate monthly sales and revenue for each product. Return ONLY the JSON array.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const rawText = message.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

  // Strip any accidental markdown fences
  const cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let analyzed;
  try {
    analyzed = JSON.parse(cleaned);
  } catch {
    // Try extracting the JSON array if there's surrounding text
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) {
      analyzed = JSON.parse(match[0]);
    } else {
      throw new Error(`Claude returned invalid JSON. Raw response: ${rawText.slice(0, 500)}`);
    }
  }

  if (!Array.isArray(analyzed)) {
    throw new Error('Claude did not return a JSON array.');
  }

  // Merge scraped data with AI estimates, ensuring price is always present
  return analyzed.map((item, i) => {
    const scraped = products.find((p) => p.rank === item.rank) || products[i] || {};
    return {
      rank: item.rank ?? scraped.rank ?? i + 1,
      name: item.name || scraped.name || 'Unknown Product',
      price: item.price || scraped.price || 0,
      estimated_monthly_sales: item.estimated_monthly_sales || 0,
      estimated_monthly_revenue: item.estimated_monthly_revenue || 0,
      confidence: item.confidence || 'medium',
      rating: scraped.rating || 0,
      reviewCount: scraped.reviewCount || 0,
    };
  });
}

module.exports = { analyzeProducts };
