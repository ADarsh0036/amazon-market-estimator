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

function extractBrand(name) {
  if (!name) return 'Unknown';
  const words = name.trim().split(/\s+/);
  const skip = new Set(['the', 'a', 'an', 'premium', 'pack', 'set', 'bundle', 'new', 'best', 'top', 'super', 'mega', 'ultra', 'original', 'natural', 'organic']);
  const brandWords = [];
  for (const w of words) {
    if (brandWords.length >= 2) break;
    if (w.length > 1 && !skip.has(w.toLowerCase())) brandWords.push(w);
  }
  return brandWords.join(' ') || words[0] || 'Unknown';
}

function addCompetitionData(products) {
  return products.map(p => {
    const reviews = p.reviewCount || 0;
    let competition_level, entry_difficulty;

    if (reviews < 1000) {
      competition_level = 'LOW';
      entry_difficulty = Math.max(1, Math.round(1 + (reviews / 1000) * 3));
    } else if (reviews < 10000) {
      competition_level = 'MEDIUM';
      entry_difficulty = Math.round(4 + ((reviews - 1000) / 9000) * 2);
    } else if (reviews < 50000) {
      competition_level = 'HIGH';
      entry_difficulty = Math.round(6 + ((reviews - 10000) / 40000) * 2);
    } else {
      competition_level = 'VERY HIGH';
      entry_difficulty = Math.min(10, Math.round(8 + (reviews / 100000)));
    }

    return {
      ...p,
      competition_level,
      entry_difficulty,
      dominant_brand: extractBrand(p.name),
    };
  });
}

function computeRawGaps(products) {
  const buckets = [
    { label: 'Under $15', min: 0, max: 15, products: [] },
    { label: '$15–$30', min: 15, max: 30, products: [] },
    { label: '$30–$60', min: 30, max: 60, products: [] },
    { label: '$60–$100', min: 60, max: 100, products: [] },
    { label: 'Over $100', min: 100, max: Infinity, products: [] },
  ];

  products.forEach(p => {
    const price = p.price || 0;
    const bucket = buckets.find(b => price >= b.min && price < b.max);
    if (bucket) bucket.products.push(p);
  });

  const stats = buckets
    .filter(b => b.products.length > 0)
    .map(b => {
      const count = b.products.length;
      const avgRevenue = b.products.reduce((s, p) => s + p.estimated_monthly_revenue, 0) / count;
      const avgReviews = b.products.reduce((s, p) => s + (p.reviewCount || 0), 0) / count;
      return { label: b.label, count, avgRevenue, avgReviews };
    });

  if (stats.length === 0) return [];

  const maxRevenue = Math.max(...stats.map(s => s.avgRevenue)) || 1;
  const maxReviews = Math.max(...stats.map(s => s.avgReviews)) || 1;

  stats.forEach(s => {
    s.gapScore = (s.avgRevenue / maxRevenue) - (s.avgReviews / maxReviews);
  });

  return stats.sort((a, b) => b.gapScore - a.gapScore).slice(0, 2);
}

async function getGapInsights(gaps) {
  if (gaps.length === 0) return gaps;

  const gapDesc = gaps.map((g, i) =>
    `Gap ${i + 1}: ${g.label} — ${g.count} product(s), avg monthly revenue $${Math.round(g.avgRevenue).toLocaleString()}, avg reviews ${Math.round(g.avgReviews).toLocaleString()}`
  ).join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are an Amazon market analyst. These are market gap opportunities found in the top 10 best sellers:\n\n${gapDesc}\n\nFor each gap, write ONE concise sentence (under 25 words) explaining the opportunity. Mention the price range, revenue, and review count as evidence.\n\nReturn ONLY a JSON array: [{"insight": "..."}, {"insight": "..."}]`,
    }],
  });

  const raw = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const cleaned = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    parsed = match ? JSON.parse(match[0]) : [];
  }

  return gaps.map((g, i) => ({
    ...g,
    insight: (parsed[i] && parsed[i].insight) || `The ${g.label} range shows strong demand with relatively low competition — a solid entry point.`,
  }));
}

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

  const cleaned = rawText
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  let analyzed;
  try {
    analyzed = JSON.parse(cleaned);
  } catch {
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

  const merged = analyzed.map((item, i) => {
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

  const withCompetition = addCompetitionData(merged);
  const rawGaps = computeRawGaps(withCompetition);
  const marketGaps = await getGapInsights(rawGaps);

  return { products: withCompetition, marketGaps };
}

module.exports = { analyzeProducts };
