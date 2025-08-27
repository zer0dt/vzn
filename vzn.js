import { JungleBusClient, ControlMessageStatusCode } from "@gorillapool/js-junglebus";
import { createClient } from "@supabase/supabase-js";
import dotenv from 'dotenv';

// ============================================================================
// ENVIRONMENT CONFIGURATION
// ============================================================================

// Load environment variables from .env file
dotenv.config();

// Validate and extract required environment variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error('Missing required environment variables: SUPABASE_URL and SUPABASE_KEY');
}

// Validate required configuration parameters
if (!process.env.STARTING_HEIGHT) {
  console.error('Error: STARTING_HEIGHT environment variable is required');
  process.exit(1);
}

if (!process.env.TARGET_TOKEN_ID) {
  console.error('Error: TARGET_TOKEN_ID environment variable is required');
  process.exit(1);
}

// Parse configuration values
const startingHeight = parseInt(process.env.STARTING_HEIGHT);
const targetTokenId = process.env.TARGET_TOKEN_ID;

// ============================================================================
// SUPABASE CLIENT INITIALIZATION
// ============================================================================

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================================
// JUNGLEBUS CLIENT INITIALIZATION
// ============================================================================

const client = new JungleBusClient("junglebus.gorillapool.io", {
  useSSL: true,
  onConnected(ctx) {
    console.log("✅ CONNECTED to JungleBus", ctx);
  },
  onConnecting(ctx) {
    console.log("🔄 CONNECTING to JungleBus", ctx);
  },
  onDisconnected(ctx) {
    console.log("❌ DISCONNECTED from JungleBus", ctx);
  },
  onError(ctx) {
    console.error("❌ JungleBus error:", ctx);
  },
});

// ============================================================================
// GLOBAL STATE VARIABLES
// ============================================================================

let deployConfig = null;           // Stores the deployment configuration
let processedBlocks = 0;           // Counter for processed blocks

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Fetches and logs inscription information for a given inscription ID
 * @param {string} inscriptionId - The inscription ID to fetch
 * @returns {Object|null} - The JSON payload or null if not found
 */
const fetchInscriptionInfo = async (inscriptionId) => {
  try {
    const url = `https://ordinals.gorillapool.io/api/inscriptions/${inscriptionId}?script=false`;
    const response = await fetch(url, { 
      headers: { accept: "application/json" } 
    });
    
    if (!response.ok) return null;
    
    const data = await response.json();
    const jsonPayload = data?.data?.insc?.json;
    
    if (jsonPayload) {
      console.log("📝 DEPLOY INSCRIPTION FOUND:");
      console.log(JSON.stringify(jsonPayload, null, 2));
      return jsonPayload;
    }
    
    return null;
  } catch (err) {
    console.error(`❌ Error fetching inscription ${inscriptionId}:`, err);
    return null;
  }
};

/**
 * Validates mint layout and extracts details for a single transaction
 * @param {string} txid - Transaction ID to validate
 * @param {Object} deploy - Deployment configuration
 * @param {string} targetId - Target token ID
 * @returns {Object|null} - Mint data if valid, null otherwise
 */
const checkMint = async (txid, deploy, targetId) => {
  try {
    if (!deploy) return null;
    
    // Build URLs for the first three outputs
    const buildUrl = (vout) => `https://ordinals.gorillapool.io/api/inscriptions/${txid}_${vout}?script=false`;
    
    // Fetch all three outputs concurrently
    const [res0, res1, res2] = await Promise.all([
      fetch(buildUrl(0), { headers: { accept: "application/json" } }),
      fetch(buildUrl(1), { headers: { accept: "application/json" } }),
      fetch(buildUrl(2), { headers: { accept: "application/json" } }),
    ]);
    
    if (!res0.ok || !res1.ok || !res2.ok) return null;
    
    const [output0, output1, output2] = await Promise.all([
      res0.json(), res1.json(), res2.json()
    ]);

    // ========================================================================
    // OUTPUT 0 VALIDATION: Lock checks (must be first output)
    // ========================================================================
    if (!(output0?.data?.lock)) return null;
    
    const satoshisLocked = output0.satoshis;
    const minedHeight = output0.height;
    const lockedUntil = output0.data.lock.until;
    
    // Validate lock requirements
    if (satoshisLocked < deploy.sats) return null; // sats locked >= deploy.sats
    if ((lockedUntil - minedHeight) < deploy.blocks) return null; // until - height >= deploy.blocks

    // ========================================================================
    // OUTPUT 1 VALIDATION: Like with context 'tx' and non-empty app name
    // ========================================================================
    const likeMap = output1?.data?.map;
    if (!(
      likeMap &&
      likeMap.type === "like" &&
      likeMap.context === "tx" &&
      typeof likeMap.app === "string" &&
      likeMap.app.trim().length > 0
    )) return null;



    // ========================================================================
    // OUTPUT 2 VALIDATION: 1 sat and origin.data.insc.json structure
    // ========================================================================
    if (!output2 || output2.satoshis !== 1) return null;
    
    const originJson = output2?.origin?.data?.insc?.json;
    if (!originJson) return null;
    
    // Validate JSON structure
    if (originJson.op !== "mint") return null;
    if (originJson.p !== "llm-21") return null;
    if (originJson.id !== targetId) return null;
    if (typeof originJson.amt !== "number" || originJson.amt > 1000) return null;

    // ========================================================================
    // BUILD MINT DATA OBJECT
    // ========================================================================
    const mintData = {
      txid: txid,
      mined_height: minedHeight,
      satoshis_locked: satoshisLocked,
      locked_until_block: lockedUntil,
      blocks_locked: minedHeight !== null ? lockedUntil - minedHeight + 1 : null,
      lock_address: output0.data.lock.address,
      // Like information
      liked_transaction: likeMap.tx,
      like_app: likeMap.app,
      token_name: deploy?.tick || "Unknown",
      token_id: targetId,
      amount_minted: originJson.amt,
      protocol: originJson.p,
    };

    // ========================================================================
    // LOG VALIDATION RESULTS
    // ========================================================================
    console.log(`🎯 === FOUND LOCK LIKE MINT TRANSACTION ===`);
    if (txid) console.log("Transaction ID:", txid);
    
    console.log("🔒 LOCK INFO:");
    console.log("  Satoshis Locked:", mintData.satoshis_locked?.toLocaleString());
    console.log("  Mined Height:", mintData.mined_height !== null ? mintData.mined_height : "not mined");
    console.log("  Locked Until Block:", mintData.locked_until_block);
    
    if (mintData.mined_height !== null) {
      const blocksLocked = mintData.locked_until_block - mintData.mined_height + 1;
      console.log("  Blocks Locked:", blocksLocked);
    } else {
      console.log("  Blocks Locked: n/a");
    }
    console.log("  Lock Address:", mintData.lock_address);

    console.log(`👍 LIKE INFO:`);
    console.log("  Liked Transaction:", mintData.liked_transaction);
    console.log("  Like App:", mintData.like_app);

    console.log(`🪙 MINT INFO:`);
    console.log("  Protocol:", mintData.protocol);
    console.log("  Ticker:", deploy?.tick || "Unknown");
    
    if (typeof mintData.amount_minted === "number") {
      console.log("  Amount Minted:", mintData.amount_minted.toLocaleString());
    } else {
      console.log("  Amount Minted:", mintData.amount_minted);
    }

    return mintData;
  } catch (err) {
    console.error(`❌ Error in checkMint for ${txid}:`, err);
    return null;
  }
};

/**
 * Saves mint data to Supabase database
 * @param {Object} mintData - The mint data to save
 * @returns {boolean} - True if successful, false otherwise
 */
const saveMintToSupabase = async (mintData) => {
  try {
    const { data, error } = await supabase
      .from("mints")
      .insert([mintData])
      .select();
      
    if (error) {
      if (error.code === '23505') {
        console.log("ℹ️  Mint already exists in database (txid:", mintData.txid, ")");
      } else {
        console.error("❌ Error saving mint to Supabase:", error);
      }
      return false;
    }
    
    console.log("✅ Mint saved to Supabase:", data[0].txid);
    return true;
  } catch (err) {
    console.error("❌ Failed to save mint:", err);
    return false;
  }
};

// ============================================================================
// JUNGLEBUS EVENT HANDLERS
// ============================================================================

/**
 * Handles new transaction publications from JungleBus
 * @param {Object} tx - Transaction data
 */
const onPublish = async function (tx) {
  const mintData = await checkMint(tx.id, deployConfig, targetTokenId);
  
  if (!mintData) return;
  
  // Save only mined entries (height present)
  if (typeof mintData.mined_height !== 'number') return;
  
  await saveMintToSupabase(mintData);
  console.log("---\n");
};

/**
 * Handles status messages from JungleBus
 * @param {Object} message - Status message from JungleBus
 */
const onStatus = function (message) {
  if (message.statusCode === ControlMessageStatusCode.BLOCK_DONE) {
    processedBlocks += 1;
    const h = message?.height ?? message?.blockHeight ?? message?.block?.height ?? null;
    
    // Log progress every 100 blocks to avoid spam
    if (processedBlocks % 100 === 0) {
      if (h !== null) {
        console.log(`📊 Progress: ${processedBlocks} blocks processed (current: Block ${h})`);
      } else {
        console.log(`📊 Progress: ${processedBlocks} blocks processed`);
      }
    }
  } else if (message.statusCode === ControlMessageStatusCode.REORG) {
    console.log("🔄 REORG TRIGGERED", message);
  } else if (message.statusCode === ControlMessageStatusCode.ERROR) {
    console.error("❌ JungleBus status error:", message);
  }
};

/**
 * Handles errors from JungleBus
 * @param {Error} err - Error object
 */
const onError = function (err) {
  console.error("❌ JungleBus error:", err);
};

// ============================================================================
// MAIN EXECUTION
// ============================================================================

/**
 * Main application entry point
 * Initializes the system and starts listening for transactions
 */
const main = async () => {
  try {
    console.log(`📡 Subscribing from height ${startingHeight}...`);
    console.log("🚀 Starting JungleBus scanning...");
    
    // Fetch deployment configuration
    deployConfig = await fetchInscriptionInfo(targetTokenId);
    
    if (!deployConfig) {
      console.error("❌ Failed to fetch deployment configuration");
      process.exit(1);
    }
    
    console.log("📝 Saving qualifying mints to database as they are found\n");

    // Subscribe to JungleBus stream
    await client.Subscribe(
      "6f9c4fdf73c39c39964403f117bad29496bd2f6a7792bd44cf60c99516ef5c8f",
      startingHeight,
      onPublish,
      onStatus,
      onError,
      undefined
    );
    
  } catch (error) {
    console.error("❌ Fatal error in main:", error);
    process.exit(1);
  }
};

// Start the application
main();

