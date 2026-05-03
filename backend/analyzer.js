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

function calcOpportunityScore(p) {
  const rankScore = Math.max(0, 100 - (p.rank - 1) * 9);
  const reviews = p.reviewCount || 0;
  let compScore;
  if (reviews === 0)        compScore = 80;
  else if (reviews < 500)   compScore = 70;
  else if (reviews < 2000)  compScore = 50;
  else if (reviews < 10000) compScore = 30;
  else                      compScore = 10;
  const price = p.price || 0;
  let priceScore;
  if (price >= 20 && price <= 100)      priceScore = 100;
  else if (price > 100 && price <= 200) priceScore = 60;
  else if (price > 0 && price < 20)     priceScore = 40;
  else                                  priceScore = 20;
  return Math.round(Math.min(100, Math.max(0, rankScore * 0.35 + compScore * 0.40 + priceScore * 0.25)));
}

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
    let competition_level, entry_difficulty_score;

    if (reviews < 1000) {
      competition_level = 'LOW';
      entry_difficulty_score = Math.max(1, Math.round(1 + (reviews / 1000) * 3));
    } else if (reviews < 10000) {
      competition_level = 'MEDIUM';
      entry_difficulty_score = Math.round(4 + ((reviews - 1000) / 9000) * 2);
    } else if (reviews < 50000) {
      competition_level = 'HIGH';
      entry_difficulty_score = Math.round(6 + ((reviews - 10000) / 40000) * 2);
    } else {
      competition_level = 'VERY HIGH';
      entry_difficulty_score = Math.min(10, Math.round(8 + (reviews / 100000)));
    }

    return {
      ...p,
      competition_level,
      entry_difficulty_score,
      entry_difficulty: entry_difficulty_score,
      dominant_brand: extractBrand(p.name),
    };
  });
}

function addDeepDiveData(products) {
  return products.map(p => {
    const score = p.opportunity_score || 0;
    const reviews = p.reviewCount || 0;

    let review_velocity;
    if (reviews > 100000)     review_velocity = 'Fast Growing';
    else if (reviews >= 10000) review_velocity = 'Growing';
    else                       review_velocity = 'Established';

    let recommendation, recommendation_reason;
    if (score > 60 && (p.competition_level === 'LOW' || p.competition_level === 'MEDIUM')) {
      recommendation = 'ENTER';
      recommendation_reason = `Strong opportunity score of ${score} with manageable ${p.competition_level.toLowerCase()} competition — good conditions to enter.`;
    } else if (score < 40 || (p.competition_level === 'VERY HIGH' && score < 60)) {
      recommendation = 'AVOID';
      recommendation_reason = `Low opportunity score of ${score} combined with very high competition makes this hard for a new entrant to crack.`;
    } else {
      recommendation = 'WATCH';
      recommendation_reason = `Moderate conditions with score of ${score} — worth monitoring before committing resources.`;
    }

    return { ...p, recommendation, recommendation_reason, review_velocity };
  });
}

function computeRawGaps(products, currencySymbol = '$') {
  const sym = currencySymbol;
  const buckets = [
    { label: `Under ${sym}15`,       min: 0,   max: 15,       products: [] },
    { label: `${sym}15–${sym}30`,    min: 15,  max: 30,       products: [] },
    { label: `${sym}30–${sym}60`,    min: 30,  max: 60,       products: [] },
    { label: `${sym}60–${sym}100`,   min: 60,  max: 100,      products: [] },
    { label: `Over ${sym}100`,       min: 100, max: Infinity, products: [] },
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
      const totalReviews = b.products.reduce((s, p) => s + (p.reviewCount || 0), 0);
      const avgReviewsPerProduct = count > 0 ? totalReviews / count : 0;

      let entry_difficulty;
      if (avgReviewsPerProduct < 5000)       entry_difficulty = 'Easy';
      else if (avgReviewsPerProduct <= 50000) entry_difficulty = 'Moderate';
      else                                    entry_difficulty = 'Hard';

      return { label: b.label, count, avgRevenue, totalReviews, avgReviewsPerProduct, entry_difficulty };
    });

  if (stats.length === 0) return [];

  const maxRevenue = Math.max(...stats.map(s => s.avgRevenue)) || 1;
  const maxReviews = Math.max(...stats.map(s => s.avgReviewsPerProduct)) || 1;

  stats.forEach(s => {
    s.gapScore = (s.avgRevenue / maxRevenue) - (s.avgReviewsPerProduct / maxReviews);
  });

  return stats.sort((a, b) => b.gapScore - a.gapScore).slice(0, 2);
}

async function getGapInsights(gaps, currencySymbol = '$') {
  if (gaps.length === 0) return gaps;

  const gapDesc = gaps.map((g, i) =>
    `Gap ${i + 1}: ${g.label} — ${g.count} product(s), avg monthly revenue ${currencySymbol}${Math.round(g.avgRevenue).toLocaleString()}, total reviews ${g.totalReviews.toLocaleString()}, entry difficulty: ${g.entry_difficulty}`
  ).join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are an Amazon market analyst. These are market gap opportunities:\n\n${gapDesc}\n\nFor each gap write ONE simple sentence in plain English (under 25 words). Be direct, like telling a friend. Example: "Products in this price range make good money but don't have too many reviews yet — easier to compete here."\n\nReturn ONLY a JSON array: [{"insight": "..."}, {"insight": "..."}]`,
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
    price_range: g.label,
    avg_revenue: Math.round(g.avgRevenue),
    total_reviews: g.totalReviews,
    num_products: g.count,
    entry_difficulty: g.entry_difficulty,
    insight: (parsed[i] && parsed[i].insight) || `The ${g.label} range shows solid demand with manageable competition — a good place to start.`,
    // backward-compat aliases
    label: g.label,
    avgRevenue: g.avgRevenue,
    totalReviews: g.totalReviews,
    count: g.count,
  }));
}

async function getMarketSummary(products, currencySymbol = '$') {
  const sym = currencySymbol;
  const productList = products.map(p =>
    `"${p.name.slice(0, 60)}" — ${sym}${p.price}, ${(p.reviewCount || 0).toLocaleString()} reviews, ~${sym}${Math.round(p.estimated_monthly_revenue / 1000)}K/mo`
  ).join('\n');

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: `You are an Amazon market analyst. Given these top 10 products with their estimated revenues, prices, and review counts, write exactly 3 sentences:
1. Overall market size and who dominates it
2. Best price range to enter and why
3. One specific recommendation for a new seller entering this market.
Be specific, use the actual numbers, be direct.
Always use ${sym} for all monetary values. Never use $ unless the currency is USD.

Products:
${productList}

Return ONLY the 3 sentences as plain text, each on its own line. No numbering, no bullets.`,
    }],
  });

  return message.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
}

async function analyzeProducts(products, currency = { symbol: '$', code: 'USD' }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set.');
  }

  const productList = products
    .map(p => `Rank #${p.rank}: "${p.name}" | Price: $${p.price || 'N/A'} | Rating: ${p.rating || 'N/A'}/5 | Reviews: ${p.reviewCount || 'N/A'}`)
    .join('\n');

  const userMessage = `Here are the top ${products.length} products from an Amazon Best Sellers page:\n\n${productList}\n\nEstimate monthly sales and revenue for each product. Return ONLY the JSON array.`;

  const message = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }],
  });

  const rawText = message.content.filter(b => b.type === 'text').map(b => b.text).join('');
  const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let analyzed;
  try {
    analyzed = JSON.parse(cleaned);
  } catch {
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (match) analyzed = JSON.parse(match[0]);
    else throw new Error(`Claude returned invalid JSON. Raw response: ${rawText.slice(0, 500)}`);
  }

  if (!Array.isArray(analyzed)) throw new Error('Claude did not return a JSON array.');

  const merged = analyzed.map((item, i) => {
    const scraped = products.find(p => p.rank === item.rank) || products[i] || {};
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
  withCompetition.forEach(p => { p.opportunity_score = calcOpportunityScore(p); });
  const withDeepDive = addDeepDiveData(withCompetition);

  const currencySymbol = currency.symbol || '$';
  const rawGaps = computeRawGaps(withDeepDive, currencySymbol);
  const [marketGaps, market_summary] = await Promise.all([
    getGapInsights(rawGaps, currencySymbol),
    getMarketSummary(withDeepDive, currencySymbol),
  ]);

  return { products: withDeepDive, marketGaps, market_summary };
}

module.exports = { analyzeProducts };
