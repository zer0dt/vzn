# LRC-21 Mint Indexer

A Node.js application that scans the Bitcoin blockchain for LRC-21 protocol mint transactions and indexes them in a Supabase database.

## What It Does

This indexer monitors Bitcoin transactions in real-time using JungleBus and identifies specific "Lock-Like-Mint" transactions that follow the LRC-21 protocol. When it finds a valid mint, it saves the transaction details to a database.

## Deploy Inscription Format

The indexer starts by fetching the deploy inscription (token configuration) to understand the minting requirements. The deploy inscription should contain JSON like this:

```json
{
  "p": "LRC-21",
  "tick": "$VZN",
  "op": "deploy",
  "lim": 1000,
  "max": 2100000000,
  "sats": 10000000,
  "blocks": 990
}
```

**Required fields:**
- `p`: Protocol identifier (must be "LRC-21")
- `op`: Operation type (must be "deploy") 
- `tick`: Token ticker symbol (e.g., "$VZN")
- `sats`: Minimum satoshis required to be locked (e.g., 10,000,000 sats)
- `blocks`: Minimum block duration for the lock (e.g., 990 blocks)

**Additional fields:**
- `lim`: Maximum amount per mint (1000 tokens)
- `max`: Maximum total supply (2,100,000,000 tokens)

The indexer validates that each mint transaction meets these minimum requirements.

## Quick Start

### Prerequisites

- Node.js (v16 or higher)
- Supabase account and database
- JungleBus access

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd vzn
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Set up environment variables**
   Create a `.env` file with:
   ```env
   SUPABASE_URL=your_supabase_url
   SUPABASE_KEY=your_supabase_service_key
   STARTING_HEIGHT=912000
   TARGET_TOKEN_ID=your_token_inscription_id
   ```

4. **Set up database**
   Create a `mints` table in Supabase (see Database Setup section below)

5. **Run the indexer**
   ```bash
   node vzn.js
   ```

## How It Works

### 1. **Transaction Validation**
The indexer looks for transactions with at least 3 outputs where the first 3 follow this specific pattern:

- **Output 0**: A time-locked Bitcoin amount (must meet minimum lock requirements)
- **Output 1**: A "like" action with context "tx" and a valid app name
- **Output 2**: A 1-satoshi output containing LRC-21 mint inscription data

The transaction can have additional outputs beyond these 3, but only the first 3 are validated for the LRC-21 mint pattern.

### 2. **Protocol Requirements**
- Must use the "LRC-21" protocol
- Must have a valid token ID
- Mint amount must be ≤ 1000
- Lock requirements must match deployment configuration

### 3. **Data Collection**
For each valid mint, it captures:
- Transaction ID and block height
- Lock details (amount, duration, address)
- Like information (transaction, app)
- Mint details (amount, protocol, token info)

## JungleBus Subscription & Filtering

### **How the Subscription Works**
The indexer subscribes to a JungleBus stream that provides transactions with bsocial `type=like` data:

```javascript
await client.Subscribe(
  "6f9c4fdf73c39c39964403f117bad29496bd2f6a7792bd44cf60c99516ef5c8f",
  startingHeight,
  onPublish,
  onStatus,
  onError,
  undefined
);
```

### **Filtering Process**
- JungleBus pre-filters transactions to only include those with bsocial like data
- The indexer then validates each transaction against LRC-21 mint requirements

### **Validation Steps**
1. **Output 0**: Checks lock requirements (amount, duration)
2. **Output 1**: Confirms like data structure (`type: "like"`, `context: "tx"`, valid app)
3. **Output 2**: Validates LRC-21 mint inscription data

### Deep dive: how `vzn.js` checks each output via GorillaPool

The indexer calls GorillaPool’s Ordinals API to inspect the first 3 outputs of every candidate transaction. It fetches JSON for `vout=0,1,2` from:
- `https://ordinals.gorillapool.io/api/inscriptions/${txid}_${vout}?script=false`

It also fetches the deploy inscription (the token’s config) once at startup:
- `https://ordinals.gorillapool.io/api/inscriptions/${TARGET_TOKEN_ID}?script=false`

#### 1) Fetch deploy config (token settings)
```javascript
const fetchInscriptionInfo = async (inscriptionId) => {
  try {
    const url = `https://ordinals.gorillapool.io/api/inscriptions/${inscriptionId}?script=false`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
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
```

- The returned JSON sets constraints like minimum `sats` and `blocks`, and token `tick`. These values are used to validate each mint.

#### 2) Fetch all three outputs for a TX
```javascript
const buildUrl = (vout) => `https://ordinals.gorillapool.io/api/inscriptions/${txid}_${vout}?script=false`;

const [res0, res1, res2] = await Promise.all([
  fetch(buildUrl(0), { headers: { accept: "application/json" } }),
  fetch(buildUrl(1), { headers: { accept: "application/json" } }),
  fetch(buildUrl(2), { headers: { accept: "application/json" } }),
]);

if (!res0.ok || !res1.ok || !res2.ok) return null;

const [output0, output1, output2] = await Promise.all([
  res0.json(), res1.json(), res2.json()
]);
```

- Each response includes fields like `satoshis`, `height`, `data.lock`, `data.map`, and (for output 2) `origin.data.insc.json`.

#### 3) Output 0 — Lock validation
```javascript
if (!(output0?.data?.lock)) return null;

const satoshisLocked = output0.satoshis;
const minedHeight = output0.height;
const lockedUntil = output0.data.lock.until;

// Validate lock requirements
if (satoshisLocked < deploy.sats) return null;
if ((lockedUntil - minedHeight) < deploy.blocks) return null;
```

- Requires a lock object in `data.lock`.
- Enforces minimum sats and minimum duration (`until - height`) from the deploy config.

#### 4) Output 1 — Like validation (bsocial)
```javascript
const likeMap = output1?.data?.map;
if (!(
  likeMap &&
  likeMap.type === "like" &&
  likeMap.context === "tx" &&
  typeof likeMap.app === "string" &&
  likeMap.app.trim().length > 0
)) return null;
```

- Must be a bsocial like with `type="like"` and `context="tx"`.
- `app` must be a non-empty string. `likeMap.tx` is the liked transaction id.

#### 5) Output 2 — Mint inscription validation
```javascript
if (!output2 || output2.satoshis !== 1) return null;

const originJson = output2?.origin?.data?.insc?.json;
if (!originJson) return null;

if (originJson.op !== "mint") return null;
if (originJson.p !== "LRC-21") return null;
if (originJson.id !== targetId) return null;
if (typeof originJson.amt !== "number" || originJson.amt > 1000) return null;
```

- Must be exactly 1 sat output.
- The inscription’s JSON must match the LRC-21 mint schema and the target token id.
- Caps `amt` at 1000 per mint.

#### 6) Saved fields (what we persist)
```javascript
const mintData = {
  txid: txid,
  mined_height: minedHeight,
  satoshis_locked: satoshisLocked,
  locked_until_block: lockedUntil,
  blocks_locked: minedHeight !== null ? lockedUntil - minedHeight + 1 : null,
  lock_address: output0.data.lock.address,
  liked_transaction: likeMap.tx,
  like_app: likeMap.app,
  token_name: deploy?.tick || "Unknown",
  token_id: targetId,
  amount_minted: originJson.amt,
  protocol: originJson.p,
};
```

- Only mined mints are persisted (non-null `mined_height`).
- Inserted into the `mints` table via Supabase.

### **What Gets Processed**
- Only transactions with bsocial like data reach the indexer
- Valid mints are saved to the database

## Database Setup

Create a `mints` table in Supabase with this structure:

```sql
CREATE TABLE mints (
  id SERIAL PRIMARY KEY,
  txid TEXT UNIQUE NOT NULL,
  mined_height INTEGER,
  satoshis_locked BIGINT,
  locked_until_block INTEGER,
  blocks_locked INTEGER,
  lock_address TEXT,
  liked_transaction TEXT,
  like_app TEXT,
  token_name TEXT,
  token_id TEXT,
  amount_minted INTEGER,
  protocol TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);
```

## Configuration Options

| Environment Variable | Description | Required |
|---------------------|-------------|----------|
| `SUPABASE_URL` | Your Supabase project URL | Yes |
| `SUPABASE_KEY` | Your Supabase service key | Yes |
| `STARTING_HEIGHT` | Block height to start scanning from | Yes |
| `TARGET_TOKEN_ID` | Inscription ID of the token to monitor | Yes |

## Output Example

When a valid mint is found:

```
🎯 === FOUND LOCK LIKE MINT TRANSACTION ===
Transaction ID: abc123...
🔒 LOCK INFO:
  Satoshis Locked: 1,000,000
  Mined Height: 810,000
  Locked Until Block: 820,000
  Blocks Locked: 10,001
  Lock Address: bc1...
👍 LIKE INFO:
  Liked Transaction: def456...
  Like App: MyApp
🪙 MINT INFO:
  Protocol: LRC-21
  Ticker: $VZN
  Amount Minted: 1000
```
## Troubleshooting

- **Connection issues**: Check JungleBus connectivity and network
- **Database errors**: Verify Supabase credentials and table structure
- **No mints found**: Ensure starting height and token ID are correct
- **Memory issues**: Monitor for large transaction volumes
- **API rate limits**: GorillaPool API calls are made for each transaction
- **Validation failures**: Check deploy inscription format and requirements

## Architecture

```
JungleBus → Transaction Stream → Validation → Database
    ↓              ↓              ↓          ↓
  Connect    Process TXs    Check Rules   Save Mints
```

### Data Flow
1. **JungleBus**: Streams bsocial `type=like` transactions
2. **GorillaPool API**: Fetches output details for validation
3. **Validation Engine**: Checks LRC-21 protocol compliance
4. **Supabase**: Stores validated mint data
5. **Progress Tracking**: Monitors block processing and reorgs

## Performance Considerations

- **Concurrent API calls**: Uses `Promise.all()` for parallel output fetching
- **Filtered input**: JungleBus pre-filters to reduce unnecessary processing
- **Database constraints**: Unique txid prevents duplicate processing
- **Memory management**: Processes one transaction at a time
- **Error resilience**: Continues processing on individual transaction failures

## Development

### Project Structure
```
vzn-llm21-mints-indexer/
├── vzn.js              # Main indexer script
├── package.json        # Dependencies and scripts
├── .env               # Environment configuration
└── README.md          # This documentation
```

### Key Dependencies
- `@gorillapool/js-junglebus`: Bitcoin transaction streaming
- `@supabase/supabase-js`: Database operations
- `dotenv`: Environment variable management

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

