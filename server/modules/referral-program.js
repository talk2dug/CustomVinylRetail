/**
 * Referral & Loyalty Program Engine
 *
 * Referral: Give $5, Get $5 — viral customer acquisition
 * Loyalty: Points-based system that rewards repeat purchases
 *
 * Structure:
 * - Every $1 spent = 10 points
 * - 500 points = $5 off
 * - Referral bonus: 500 points (= $5) for both referrer and referee
 * - Bonus events: Photo review = 200 points, Social share = 100 points
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.resolve(__dirname, '..', '..', 'data');
const PROGRAM_FILE = path.join(DATA_DIR, 'loyalty-program.json');

// Program configuration
const CONFIG = {
  pointsPerDollar: 10,        // 10 points per $1 spent
  pointsRedemptionRate: 100,  // 100 points = $1
  minRedemption: 500,         // Minimum 500 points to redeem ($5)
  referralBonus: 500,         // 500 points for successful referral ($5 value)
  refereeDiscount: 500,       // $5 off first order for referred customer (in cents)
  minOrderForReferral: 2000,  // Minimum $20 order to qualify for referral credit (in cents)
  photoReviewBonus: 200,      // 200 points for photo review
  textReviewBonus: 100,       // 100 points for text review
  socialShareBonus: 100,      // 100 points for social media share
  birthdayBonus: 300,         // 300 points on birthday
  tiers: [
    { name: 'Bronze', minPoints: 0, multiplier: 1.0 },
    { name: 'Silver', minPoints: 2500, multiplier: 1.25 },  // 25% bonus points
    { name: 'Gold', minPoints: 10000, multiplier: 1.5 },    // 50% bonus points
    { name: 'Platinum', minPoints: 25000, multiplier: 2.0 }  // 2x points
  ]
};

/**
 * Load program data
 */
function loadData() {
  try {
    if (fs.existsSync(PROGRAM_FILE)) {
      return JSON.parse(fs.readFileSync(PROGRAM_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('[Loyalty] Error loading data:', e.message);
  }
  return { members: {}, referrals: {}, transactions: [] };
}

/**
 * Save program data
 */
function saveData(data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PROGRAM_FILE, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('[Loyalty] Error saving data:', e.message);
  }
}

/**
 * Generate a unique referral code
 */
function generateReferralCode(name) {
  const base = (name || 'FRIEND')
    .replace(/[^a-zA-Z0-9]/g, '')
    .toUpperCase()
    .slice(0, 6);
  const suffix = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${base}${suffix}`;
}

/**
 * Enroll a customer in the loyalty program
 */
function enrollMember(email, name) {
  if (!email) throw new Error('Email is required');

  const data = loadData();
  const key = email.toLowerCase();

  if (data.members[key]) {
    return data.members[key]; // Already enrolled
  }

  const referralCode = generateReferralCode(name);

  data.members[key] = {
    email: key,
    name: name || '',
    referralCode,
    points: 0,
    lifetimePoints: 0,
    lifetimeSpent: 0,  // cents
    ordersCount: 0,
    tier: 'Bronze',
    referredBy: null,
    referralCount: 0,
    joinedAt: new Date().toISOString()
  };

  saveData(data);
  console.log(`[Loyalty] New member enrolled: ${key} (code: ${referralCode})`);
  return data.members[key];
}

/**
 * Award points to a member
 */
function awardPoints(email, points, reason, metadata = {}) {
  const data = loadData();
  const key = email.toLowerCase();
  const member = data.members[key];

  if (!member) {
    // Auto-enroll
    enrollMember(email, metadata.name);
    return awardPoints(email, points, reason, metadata);
  }

  // Apply tier multiplier for purchase points
  let finalPoints = points;
  if (reason === 'purchase') {
    const tier = CONFIG.tiers.find(t => t.name === member.tier);
    finalPoints = Math.round(points * (tier?.multiplier || 1));
  }

  member.points += finalPoints;
  member.lifetimePoints += finalPoints;

  // Update tier
  updateTier(member);

  // Log transaction
  data.transactions.push({
    email: key,
    type: 'earn',
    points: finalPoints,
    reason,
    metadata,
    timestamp: new Date().toISOString()
  });

  // Keep transactions manageable
  if (data.transactions.length > 5000) {
    data.transactions = data.transactions.slice(-5000);
  }

  saveData(data);
  return { points: finalPoints, totalPoints: member.points, tier: member.tier };
}

/**
 * Award points for a purchase
 */
function awardPurchasePoints(email, orderTotalCents, orderId) {
  const data = loadData();
  const key = email.toLowerCase();
  const member = data.members[key];

  if (member) {
    member.lifetimeSpent += orderTotalCents;
    member.ordersCount++;
    saveData(data);
  }

  const dollars = Math.floor(orderTotalCents / 100);
  const points = dollars * CONFIG.pointsPerDollar;

  return awardPoints(email, points, 'purchase', { orderId, amount: orderTotalCents });
}

/**
 * Redeem points for a discount
 */
function redeemPoints(email, pointsToRedeem) {
  const data = loadData();
  const key = email.toLowerCase();
  const member = data.members[key];

  if (!member) throw new Error('Member not found');
  if (pointsToRedeem < CONFIG.minRedemption) {
    throw new Error(`Minimum redemption is ${CONFIG.minRedemption} points ($${(CONFIG.minRedemption / CONFIG.pointsRedemptionRate).toFixed(2)})`);
  }
  if (member.points < pointsToRedeem) {
    throw new Error(`Insufficient points. You have ${member.points}, need ${pointsToRedeem}`);
  }

  const discountCents = Math.round((pointsToRedeem / CONFIG.pointsRedemptionRate) * 100);
  const discountCode = `LOYALTY${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

  member.points -= pointsToRedeem;

  data.transactions.push({
    email: key,
    type: 'redeem',
    points: -pointsToRedeem,
    reason: 'redemption',
    metadata: { discountCode, discountCents },
    timestamp: new Date().toISOString()
  });

  saveData(data);

  return {
    discountCode,
    discountCents,
    discountDisplay: `$${(discountCents / 100).toFixed(2)}`,
    pointsRedeemed: pointsToRedeem,
    remainingPoints: member.points
  };
}

/**
 * Process a referral
 */
function processReferral(referralCode, newCustomerEmail, newCustomerName) {
  const data = loadData();

  // Find referrer by code
  const referrer = Object.values(data.members).find(m => m.referralCode === referralCode);
  if (!referrer) throw new Error('Invalid referral code');

  const newKey = newCustomerEmail.toLowerCase();

  // Don't allow self-referral
  if (referrer.email === newKey) throw new Error('Cannot refer yourself');

  // Check if already referred
  const existing = data.members[newKey];
  if (existing?.referredBy) throw new Error('Customer already has a referral');

  // Enroll new customer if not already enrolled
  if (!data.members[newKey]) {
    enrollMember(newCustomerEmail, newCustomerName);
  }

  data.members[newKey].referredBy = referrer.email;

  // Track referral
  if (!data.referrals[referrer.email]) {
    data.referrals[referrer.email] = [];
  }
  data.referrals[referrer.email].push({
    email: newKey,
    code: referralCode,
    status: 'pending', // pending until first purchase
    createdAt: new Date().toISOString()
  });

  saveData(data);

  return {
    referrerEmail: referrer.email,
    referrerName: referrer.name,
    newCustomerDiscount: `$${(CONFIG.refereeDiscount / 100).toFixed(2)}`,
    referrerReward: `${CONFIG.referralBonus} points ($${(CONFIG.referralBonus / CONFIG.pointsRedemptionRate).toFixed(2)} value)`
  };
}

/**
 * Complete a referral (when referred customer makes first purchase)
 */
function completeReferral(customerEmail, orderTotalCents) {
  if (orderTotalCents < CONFIG.minOrderForReferral) return null;

  const data = loadData();
  const key = customerEmail.toLowerCase();
  const member = data.members[key];

  if (!member?.referredBy) return null;

  // Find and update the referral record
  const referrals = data.referrals[member.referredBy];
  if (!referrals) return null;

  const referral = referrals.find(r => r.email === key && r.status === 'pending');
  if (!referral) return null;

  referral.status = 'completed';
  referral.completedAt = new Date().toISOString();

  // Award bonus to referrer
  const referrer = data.members[member.referredBy];
  if (referrer) {
    referrer.referralCount++;
    saveData(data);
    awardPoints(member.referredBy, CONFIG.referralBonus, 'referral', { referredEmail: key });
  }

  return { referrerEmail: member.referredBy, bonusPoints: CONFIG.referralBonus };
}

/**
 * Update member tier based on lifetime points
 */
function updateTier(member) {
  for (let i = CONFIG.tiers.length - 1; i >= 0; i--) {
    if (member.lifetimePoints >= CONFIG.tiers[i].minPoints) {
      member.tier = CONFIG.tiers[i].name;
      return;
    }
  }
}

/**
 * Get member profile
 */
function getMemberProfile(email) {
  const data = loadData();
  const key = email.toLowerCase();
  const member = data.members[key];
  if (!member) return null;

  const tier = CONFIG.tiers.find(t => t.name === member.tier);
  const nextTier = CONFIG.tiers[CONFIG.tiers.indexOf(tier) + 1];

  return {
    ...member,
    pointsValue: `$${(member.points / CONFIG.pointsRedemptionRate).toFixed(2)}`,
    canRedeem: member.points >= CONFIG.minRedemption,
    tierMultiplier: tier?.multiplier || 1,
    nextTier: nextTier ? {
      name: nextTier.name,
      pointsNeeded: nextTier.minPoints - member.lifetimePoints,
      multiplier: nextTier.multiplier
    } : null,
    referralUrl: `${process.env.STORE_BASE_URL || 'https://blueridgecustomco.com'}?ref=${member.referralCode}`
  };
}

/**
 * Get program overview (for dashboard)
 */
function getProgramStats() {
  const data = loadData();
  const members = Object.values(data.members);

  const tierCounts = {};
  CONFIG.tiers.forEach(t => tierCounts[t.name] = 0);
  members.forEach(m => tierCounts[m.tier] = (tierCounts[m.tier] || 0) + 1);

  const totalReferrals = Object.values(data.referrals).flat();
  const completedReferrals = totalReferrals.filter(r => r.status === 'completed');

  return {
    totalMembers: members.length,
    totalPointsOutstanding: members.reduce((sum, m) => sum + m.points, 0),
    totalPointsIssued: members.reduce((sum, m) => sum + m.lifetimePoints, 0),
    tierDistribution: tierCounts,
    referrals: {
      total: totalReferrals.length,
      completed: completedReferrals.length,
      conversionRate: totalReferrals.length > 0
        ? `${((completedReferrals.length / totalReferrals.length) * 100).toFixed(1)}%`
        : '0%'
    },
    config: CONFIG
  };
}

/**
 * Handle loyalty/referral API routes
 */
function handleLoyaltyRoute(req, res, parsedUrl, sendJson) {
  const pathname = parsedUrl.pathname;

  // Enroll in loyalty program
  if (pathname === '/api/loyalty/enroll' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, name } = JSON.parse(body);
        const member = enrollMember(email, name);
        sendJson(res, member, 201);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Get member profile
  if (pathname === '/api/loyalty/profile' && req.method === 'GET') {
    const email = parsedUrl.searchParams?.get('email');
    if (!email) {
      sendJson(res, { error: 'Email required' }, 400);
      return true;
    }
    const profile = getMemberProfile(email);
    sendJson(res, profile || { error: 'Not enrolled' }, profile ? 200 : 404);
    return true;
  }

  // Redeem points
  if (pathname === '/api/loyalty/redeem' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { email, points } = JSON.parse(body);
        const result = redeemPoints(email, points);
        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Apply referral code
  if (pathname === '/api/referral/apply' && req.method === 'POST') {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const { referralCode, email, name } = JSON.parse(body);
        const result = processReferral(referralCode, email, name);
        sendJson(res, result);
      } catch (err) {
        sendJson(res, { error: err.message }, 400);
      }
    });
    return true;
  }

  // Validate referral code
  if (pathname === '/api/referral/validate' && req.method === 'GET') {
    const code = parsedUrl.searchParams?.get('code');
    const data = loadData();
    const referrer = Object.values(data.members).find(m => m.referralCode === code);
    sendJson(res, {
      valid: !!referrer,
      referrerName: referrer?.name || null,
      discount: `$${(CONFIG.refereeDiscount / 100).toFixed(2)}`
    });
    return true;
  }

  // Admin: Program stats
  if (pathname === '/api/admin/loyalty/stats' && req.method === 'GET') {
    sendJson(res, getProgramStats());
    return true;
  }

  return false;
}

module.exports = {
  CONFIG,
  enrollMember,
  awardPoints,
  awardPurchasePoints,
  redeemPoints,
  processReferral,
  completeReferral,
  getMemberProfile,
  getProgramStats,
  handleLoyaltyRoute
};
