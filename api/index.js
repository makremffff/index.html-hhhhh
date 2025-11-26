// /api/index.js (Final and Corrected Version)

/**
 * SHIB Ads WebApp Backend API
 * Handles all POST requests from the Telegram Mini App frontend.
 * Uses the Supabase REST API for persistence.
 */
const crypto = require('crypto');

// Load environment variables for Supabase connection
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
// ⚠️ BOT_TOKEN must be set in Vercel environment variables
const BOT_TOKEN = process.env.BOT_TOKEN;

// ------------------------------------------------------------------
// Fully secured and defined server-side constants (to prevent tampering)
// ------------------------------------------------------------------
const REWARD_PER_AD = 3;
const REFERRAL_COMMISSION_RATE = 0.05;
const DAILY_MAX_ADS = 100; // Max ads limit
const DAILY_MAX_SPINS = 15; // Max spins limit
const MIN_TIME_BETWEEN_ACTIONS_MS = 3000; // 3 seconds minimum time between watchAd/spin requests
// Sectors: 5 (Index 0), 10 (Index 1), 15 (Index 2), 20 (Index 3), 5 (Index 4)
const SPIN_SECTORS = [5, 10, 15, 20, 5];

/**
 * Helper function to randomly select a prize from the defined sectors and return its index.
 */
function calculateRandomSpinPrize() {
    const randomIndex = Math.floor(Math.random() * SPIN_SECTORS.length);
    const prize = SPIN_SECTORS[randomIndex];
    return { prize, prizeIndex: randomIndex };
}

// --- Helper Functions ---

function sendSuccess(res, data = {}) {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, data }));
}

function sendError(res, message, statusCode = 400) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: message }));
}

async function supabaseFetch(tableName, method, body = null, queryParams = '?select=*') {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error('Supabase environment variables are not configured.');
  }

  const url = `${SUPABASE_URL}/rest/v1/${tableName}${queryParams}`;

  const headers = {
    'apikey': SUPABASE_ANON_KEY,
    'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json',
    'Prefer': 'return=representation'
  };

  const options = {
    method,
    headers,
    body: body ? JSON.stringify(body) : null,
  };

  const response = await fetch(url, options);

  if (response.ok) {
      const responseText = await response.text();
      try {
          const jsonResponse = JSON.parse(responseText);
          return Array.isArray(jsonResponse) ? jsonResponse : { success: true };
      } catch (e) {
          return { success: true };
      }
  }

  let data;
  try {
      data = await response.json();
  } catch (e) {
      const errorMsg = `Supabase error: ${response.status} ${response.statusText}`;
      throw new Error(errorMsg);
  }

  const errorMsg = data.message || `Supabase error: ${response.status} ${response.statusText}`;
  throw new Error(errorMsg);
}

/**
 * ⬅️ Daily Reset Logic: Resets ad/spin counters if 24 hours passed since last activity.
 */
async function resetDailyLimitsIfExpired(userId) {
    const twentyFourHours = 24 * 60 * 60 * 1000;
    const now = Date.now();

    try {
        // 1. Fetch user data with last_activity
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=ads_watched_today,spins_today,last_activity`);
        if (!Array.isArray(users) || users.length === 0) {
            return;
        }

        const user = users[0];
        // Handle null value for first use
        const lastActivity = user.last_activity ? new Date(user.last_activity).getTime() : 0;

        // 2. Check if a reset is needed
        if (now - lastActivity > twentyFourHours) {

            const updatePayload = {};
            if (user.ads_watched_today > 0) {
                updatePayload.ads_watched_today = 0;
            }
            if (user.spins_today > 0) {
                updatePayload.spins_today = 0;
            }

            if (Object.keys(updatePayload).length > 0) {
                console.log(`Resetting limits for user ${userId}.`);
                await supabaseFetch('users', 'PATCH',
                    updatePayload,
                    `?id=eq.${userId}`);
            }
        }
    } catch (error) {
        // Logging the error is sufficient
        console.error(`Failed to check/reset daily limits for user ${userId}:`, error.message);
    }
}

/**
 * ⚠️ NEW: Rate Limiting Check for Ad/Spin Actions
 * Checks if the time elapsed since the last activity is less than the minimum allowed time.
 */
async function checkRateLimit(userId) {
    try {
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${userId}&select=last_activity`);
        if (!Array.isArray(users) || users.length === 0) {
            return { ok: true }; // Allow if user data is somehow missing (will be handled by main logic)
        }

        const user = users[0];
        const lastActivity = user.last_activity ? new Date(user.last_activity).getTime() : 0;
        const now = Date.now();
        const timeElapsed = now - lastActivity;

        if (timeElapsed < MIN_TIME_BETWEEN_ACTIONS_MS) {
            const remainingTime = MIN_TIME_BETWEEN_ACTIONS_MS - timeElapsed;
            // ⬅️ Send an error message that explicitly mentions the rate limit
            return {
                ok: false,
                message: `Rate limit exceeded. Please wait ${Math.ceil(remainingTime / 1000)} seconds before the next action.`,
                remainingTime: remainingTime
            };
        }

        return { ok: true };
    } catch (error) {
        console.error(`Rate limit check failed for user ${userId}:`, error.message);
        // Fail safe: Allow if the rate limit check itself fails
        return { ok: true };
    }
}

// ------------------------------------------------------------------
// ⚠️ NEW: Action ID (Anti-Replay Attack) Handlers
// ------------------------------------------------------------------

/**
 * Checks if the action ID has already been used by the user.
 */
async function checkActionId(userId, actionId) {
    if (!actionId) {
        throw new Error('Action ID is required.');
    }
    try {
        const records = await supabaseFetch('action_ids', 'GET', null, `?user_id=eq.${userId}&action_id=eq.${actionId}&select=action_id`);
        return records && Array.isArray(records) && records.length > 0;
    } catch (error) {
        console.error(`Error checking action ID ${actionId}:`, error.message);
        // Fail safe: Treat an error in the check as the ID being unused, but log the error.
        return false;
    }
}

/**
 * Saves a new, unique action ID for the user.
 */
async function saveActionId(userId, actionId) {
    if (!actionId) {
        throw new Error('Action ID is required for saving.');
    }
    try {
        await supabaseFetch('action_ids', 'POST',
            { user_id: userId, action_id: actionId },
            '?select=action_id');
        return { ok: true };
    } catch (error) {
        console.error(`Error saving action ID ${actionId}:`, error.message);
        // Fail safe: Return false if the save operation fails
        return { ok: false, error: 'Failed to save action ID.' };
    }
}

/**
 * Middleware: Checks if action_id is present and unused.
 */
async function handleActionIdCheck(res, userId, actionId) {
    if (!actionId) {
        sendError(res, 'Missing Action ID. Request rejected.', 400);
        return false;
    }
    
    // Check if the ID has been used
    if (await checkActionId(userId, actionId)) {
        sendError(res, 'Action ID already used. Request rejected.', 409); // 409 Conflict
        return false;
    }
    
    return true;
}


// ------------------------------------------------------------------
// **initData Security Validation Function**
// ------------------------------------------------------------------
function validateInitData(initData) {
    if (!initData || !BOT_TOKEN) {
        console.warn('Security Check Failed: initData or BOT_TOKEN is missing.');
        return false;
    }

    const urlParams = new URLSearchParams(initData);
    const hash = urlParams.get('hash');
    urlParams.delete('hash');

    const dataCheckString = Array.from(urlParams.entries())
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData')
        .update(BOT_TOKEN)
        .digest();

    const calculatedHash = crypto.createHmac('sha256', secretKey)
        .update(dataCheckString)
        .digest('hex');

    if (calculatedHash !== hash) {
        console.warn(`Security Check Failed: Hash mismatch.`);
        return false;
    }

    const authDateParam = urlParams.get('auth_date');
    if (!authDateParam) {
        console.warn('Security Check Failed: auth_date is missing.');
        return false;
    }

    const authDate = parseInt(authDateParam) * 1000;
    const currentTime = Date.now();
    const expirationTime = 1200 * 1000; // 20 minutes limit

    if (currentTime - authDate > expirationTime) {
        console.warn(`Security Check Failed: Data expired.`);
        return false;
    }

    return true;
}

// --- API Handlers ---

/**
 * HANDLER: type: "getUserData"
 * Fetches the current user data (balance, counts, history, referrals, and banned status) for UI initialization.
 */
async function handleGetUserData(req, res, body) {
    const { user_id } = body;
    if (!user_id) {
        return sendError(res, 'Missing user_id for data fetch.');
    }
    const id = parseInt(user_id);

    try {
        // 1. Update last_activity immediately (to ensure accurate reset logic and rate limiting)
        // ⚠️ NOTE: This update is only for the rate limit check and should not be used as a final timestamp.
        await supabaseFetch('users', 'PATCH',
            { last_activity: new Date().toISOString() },
            `?id=eq.${id}&select=id`);

        // 2. Check and reset daily limits (if 24 hours passed)
        await resetDailyLimitsIfExpired(id);

        // 3. Fetch user data (balance, ads_watched_today, spins_today, last_activity, is_banned)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,spins_today,last_activity,is_banned`);

        if (!users || users.length === 0 || users.success) {
            // Return default state if user not found (should be handled by register first)
            return sendSuccess(res, {
                balance: 0, ads_watched_today: 0, spins_today: 0, referrals_count: 0, withdrawal_history: [], is_banned: false
            });
        }

        const userData = users[0];

        // ⚠️ Banned Check - Exit immediately if banned
        if (userData.is_banned) {
             return sendSuccess(res, { is_banned: true, message: "User is banned from accessing the app." });
        }


        // 4. Fetch referrals count
        const referrals = await supabaseFetch('users', 'GET', null, `?ref_by=eq.${id}&select=id`);
        const referralsCount = Array.isArray(referrals) ? referrals.length : 0;

        // 5. Fetch withdrawal history
        const history = await supabaseFetch('withdrawals', 'GET', null, `?user_id=eq.${id}&select=amount,status,created_at&order=created_at.desc`);
        const withdrawalHistory = Array.isArray(history) ? history : [];

        sendSuccess(res, {
            ...userData,
            referrals_count: referralsCount,
            withdrawal_history: withdrawalHistory
        });

    } catch (error) {
        console.error('GetUserData failed:', error.message);
        sendError(res, `Failed to retrieve user data: ${error.message}`, 500);
    }
}


/**
 * 1) type: "register"
 * Creates a new user if they don't exist.
 */
async function handleRegister(req, res, body) {
  const { user_id, ref_by } = body;
  const id = parseInt(user_id);

  try {
    // 1. Check if user exists
    const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=id,is_banned`);

    if (!Array.isArray(users) || users.length === 0) {
      // 2. User does not exist, create new user
      const newUser = {
        id,
        balance: 0,
        ads_watched_today: 0,
        spins_today: 0,
        ref_by: ref_by ? parseInt(ref_by) : null,
        last_activity: new Date().toISOString(), // ⬅️ Add value for new column
        is_banned: false // Default to not banned
      };
      await supabaseFetch('users', 'POST', newUser, '?select=id');
    } else {
        // ⚠️ Check if existing user is banned
        if (users[0].is_banned) {
             return sendError(res, 'User is banned.', 403);
        }
    }

    sendSuccess(res, { message: 'User registered or already exists.' });
  } catch (error) {
    console.error('Registration failed:', error.message);
    sendError(res, `Registration failed: ${error.message}`, 500);
  }
}

/**
 * 2) type: "watchAd"
 * Adds reward to user balance and increments ads_watched_today.
 */
async function handleWatchAd(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    const reward = REWARD_PER_AD;

    // 1. Check Action ID
    if (!await handleActionIdCheck(res, id, action_id)) return;

    try {
        // 2. Check and reset daily limits before proceeding
        await resetDailyLimitsIfExpired(id);

        // 3. Fetch current user data (including is_banned for immediate check)
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,ads_watched_today,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];

        // ⚠️ Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        // 4. Rate Limit Check (NEW)
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            // ⬅️ Explicitly use a 429 status code for rate limiting
            return sendError(res, rateLimitResult.message, 429); 
        }

        // 5. Check maximum ad limit
        if (user.ads_watched_today >= DAILY_MAX_ADS) {
            return sendError(res, `Daily ad limit (${DAILY_MAX_ADS}) reached.`, 403);
        }

        // 6. Calculate new values
        const newBalance = user.balance + reward;
        const newAdsCount = user.ads_watched_today + 1;

        // 7. Update user record: balance, ads_watched_today, and last_activity
        await supabaseFetch('users', 'PATCH',
          {
              balance: newBalance,
              ads_watched_today: newAdsCount,
              last_activity: new Date().toISOString() // ⬅️ Update activity (The server-side "encrypted timestamp" logic)
          },
          `?id=eq.${id}`);
          
        // 8. Save Action ID to prevent replay
        await saveActionId(id, action_id);

        // 9. Success
        sendSuccess(res, { new_balance: newBalance, actual_reward: reward, new_ads_count: newAdsCount });

    } catch (error) {
        console.error('WatchAd failed:', error.message);
        sendError(res, `Failed to process ad watch: ${error.message}`, 500);
    }
}

/**
 * 3) type: "commission"
 * Adds referral commission to the referrer's balance.
 */
async function handleCommission(req, res, body) {
    const { referrer_id, referee_id } = body;

    if (!referrer_id || !referee_id) {
        return sendSuccess(res, { message: 'Invalid commission data received but acknowledged.' });
    }

    const referrerId = parseInt(referrer_id);
    const refereeId = parseInt(referee_id);
    const sourceReward = REWARD_PER_AD;
    const commissionAmount = sourceReward * REFERRAL_COMMISSION_RATE;

    try {
        // 1. Fetch current referrer balance and banned status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${referrerId}&select=balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendSuccess(res, { message: 'Referrer not found, commission aborted.' });
        }
        
        // ⚠️ Skip commission if referrer is banned
        if (users[0].is_banned) {
            return sendSuccess(res, { message: 'Referrer is banned, commission aborted.' });
        }

        const newBalance = users[0].balance + commissionAmount;

        // 2. Update referrer balance
        await supabaseFetch('users', 'PATCH', { balance: newBalance }, `?id=eq.${referrerId}`);

        // 3. Add record to commission_history
        await supabaseFetch('commission_history', 'POST',
            { referrer_id: referrerId, referee_id: refereeId, amount: commissionAmount, source_reward: sourceReward },
            '?select=referrer_id');

        sendSuccess(res, { new_referrer_balance: newBalance });

    } catch (error) {
        console.error('Commission failed:', error.message);
        sendError(res, `Commission failed: ${error.message}`, 500);
    }
}

/**
 * 4) type: "spin" (called before showing the ad)
 * Increments spins_today and prepares for the result.
 */
async function handleSpin(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);
    
    // 1. Check Action ID
    if (!await handleActionIdCheck(res, id, action_id)) return;


    try {
        // 2. Check and reset daily limits before proceeding
        await resetDailyLimitsIfExpired(id);

        // 3. Fetch current user data
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=spins_today,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }
        
        const user = users[0];

        // ⚠️ Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }
        
        // 4. Rate Limit Check (NEW)
        const rateLimitResult = await checkRateLimit(id);
        if (!rateLimitResult.ok) {
            // ⬅️ Explicitly use a 429 status code for rate limiting
            return sendError(res, rateLimitResult.message, 429); 
        }


        // 5. Check maximum spin limit
        if (user.spins_today >= DAILY_MAX_SPINS) {
            // ⬅️ Limit check is performed *before* updating spin count, but *after* rate limit.
            return sendError(res, `Daily spin limit (${DAILY_MAX_SPINS}) reached.`, 403);
        }

        // 6. Calculate new values
        const newSpinsCount = user.spins_today + 1;

        // 7. Update user record: spins_today, and last_activity
        await supabaseFetch('users', 'PATCH',
          { 
              spins_today: newSpinsCount,
              last_activity: new Date().toISOString() // ⬅️ Update activity (The server-side "encrypted timestamp" logic)
          },
          `?id=eq.${id}`);
          
        // 8. Save Action ID to prevent replay
        await saveActionId(id, action_id);

        // 9. Success
        sendSuccess(res, { new_spins_count: newSpinsCount });

    } catch (error) {
        console.error('Spin failed:', error.message);
        sendError(res, `Failed to process spin: ${error.message}`, 500);
    }
}

/**
 * 5) type: "spinResult" (called after the spin animation)
 * Calculates the prize securely on the server, adds it to the user's balance, and logs the result.
 */
async function handleSpinResult(req, res, body) {
    const { user_id, action_id } = body;
    const id = parseInt(user_id);

    // 1. Check Action ID
    if (!await handleActionIdCheck(res, id, action_id)) return;
    
    // ⬅️ Calculate prize and index securely on the server
    const { prize, prizeIndex } = calculateRandomSpinPrize();

    try {
        // 2. Fetch current user balance and banned status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned`);
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        // ⚠️ Banned Check
        if (users[0].is_banned) {
            return sendError(res, 'User is banned.', 403);
        }

        const newBalance = users[0].balance + prize;

        // 3. Update user record: balance (last_activity was updated in handleSpin)
        await supabaseFetch('users', 'PATCH',
          { balance: newBalance },
          `?id=eq.${id}`);

        // 4. Save to spin_results
        await supabaseFetch('spin_results', 'POST',
          { user_id: id, prize },
          '?select=user_id');
          
        // 5. Save Action ID to prevent replay
        await saveActionId(id, action_id);

        // 6. Return the actual, server-calculated prize and index
        sendSuccess(res, { new_balance: newBalance, actual_prize: prize, prize_index: prizeIndex });

    } catch (error) {
        console.error('Spin result failed:', error.message);
        sendError(res, `Failed to process spin result: ${error.message}`, 500);
    }
}


/**
 * 6) type: "withdraw"
 * Processes a withdrawal request and reduces the user's balance.
 */
async function handleWithdraw(req, res, body) {
    const { user_id, binanceId, amount, action_id } = body;
    const id = parseInt(user_id);
    const withdrawalAmount = parseFloat(amount);
    const MIN_WITHDRAW = 400; // Minimum withdrawal amount

    // 1. Check Action ID
    if (!await handleActionIdCheck(res, id, action_id)) return;

    if (withdrawalAmount < MIN_WITHDRAW) {
        return sendError(res, `Minimum withdrawal amount is ${MIN_WITHDRAW} SHIB.`, 400);
    }

    try {
        // 2. Fetch current user balance and banned status
        const users = await supabaseFetch('users', 'GET', null, `?id=eq.${id}&select=balance,is_banned`);
        // ⚠️ Fix: The variable name was mistyped (ArrayOfusers instead of users)
        if (!Array.isArray(users) || users.length === 0) {
            return sendError(res, 'User not found.', 404);
        }

        const user = users[0];

        // ⚠️ Banned Check
        if (user.is_banned) {
            return sendError(res, 'User is banned.', 403);
        }
        
        // 3. Check sufficient balance
        if (user.balance < withdrawalAmount) {
            return sendError(res, 'Insufficient balance.', 400);
        }

        // 4. Calculate new balance
        const newBalance = user.balance - withdrawalAmount;

        // 5. Update user balance
        await supabaseFetch('users', 'PATCH',
          { balance: newBalance },
          `?id=eq.${id}`);

        // 6. Record the withdrawal request
        await supabaseFetch('withdrawals', 'POST',
          { user_id: id, amount: withdrawalAmount, binance_id: binanceId, status: 'pending' },
          '?select=user_id');
          
        // 7. Save Action ID to prevent replay
        await saveActionId(id, action_id);

        // 8. Success
        sendSuccess(res, { new_balance: newBalance });

    } catch (error) {
        console.error('Withdrawal failed:', error.message);
        sendError(res, `Withdrawal failed: ${error.message}`, 500);
    }
}


// --- Main Handler for Vercel/Serverless ---
module.exports = async (req, res) => {
  // CORS configuration
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return sendSuccess(res);
  }

  if (req.method !== 'POST') {
    return sendError(res, `Method ${req.method} not allowed. Only POST is supported.`, 405);
  }

  let body;
  try {
    body = await new Promise((resolve, reject) => {
      let data = '';
      req.on('data', chunk => {
        data += chunk.toString();
      });
      req.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON payload.'));
        }
      });
      req.on('error', reject);
    });

  } catch (error) {
    return sendError(res, error.message, 400);
  }

  if (!body || !body.type) {
    return sendError(res, 'Missing "type" field in the request body.', 400);
  }

  // ⬅️ initData Security Check
  // Enforced on all actions except commission (which is triggered by the server itself)
  if (body.type !== 'commission' && (!body.initData || !validateInitData(body.initData))) {
      return sendError(res, 'Invalid or expired initData. Security check failed.', 401);
  }

  if (!body.user_id && body.type !== 'commission') {
      return sendError(res, 'Missing user_id in the request body.', 400);
  }

  // Route the request based on the 'type' field
  switch (body.type) {
    case 'getUserData':
      await handleGetUserData(req, res, body);
      break;
    case 'register':
      await handleRegister(req, res, body);
      break;
    case 'watchAd':
      await handleWatchAd(req, res, body);
      break;
    case 'commission':
      await handleCommission(req, res, body);
      break;
    case 'spin':
      await handleSpin(req, res, body);
      break;
    case 'spinResult':
      await handleSpinResult(req, res, body);
      break;
    case 'withdraw':
      await handleWithdraw(req, res, body);
      break;
    default:
      sendError(res, `Unknown request type: ${body.type}`, 400);
      break;
  }
};