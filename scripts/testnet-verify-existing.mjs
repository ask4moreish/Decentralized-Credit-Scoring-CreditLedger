import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const require = createRequire(import.meta.url);
const {
  Account,
  Address,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  scValToNative,
  rpc,
  xdr,
} = require(path.join(ROOT, 'backend/node_modules/@stellar/stellar-sdk'));

const RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

const LEGACY_CONTRACTS = {
  creditScore: 'CBYH6SQZBYC7MWH4QF6FRGCKH2SW5EQD24RLK3EKOTMM5EYSQB7J65BZ',
  loanManager: 'CDO44SYFPU7SCP4BFTJTWFL2Z7BDB4MVOSSUSW6JUXSPB37ZIAZ7FHKA',
  communityVouch: 'CCZNGFWUX5YFTRP7Y2N7I4TFTNS6YV4243NZ62LLQXGSXLIQTB2XP552',
};

const WASM_PATHS = {
  creditScore: path.join(ROOT, 'contracts/target/wasm32v1-none/release/credit_score.wasm'),
  loanManager: path.join(ROOT, 'contracts/target/wasm32v1-none/release/loan_manager.wasm'),
  communityVouch: path.join(ROOT, 'contracts/target/wasm32v1-none/release/community_vouch.wasm'),
};

function sha256File(filePath) {
  const bytes = fs.readFileSync(filePath);
  return {
    size: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    bytes,
  };
}

function u128Val(val) {
  return nativeToScVal(BigInt(val), { type: 'u128' });
}

function toStruct(entries) {
  const sorted = [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return xdr.ScVal.scvMap(
    sorted.map(([k, val]) => new xdr.ScMapEntry({ key: nativeToScVal(k, { type: 'symbol' }), val }))
  );
}

function buildAttestationMessage(contractAddress, issuerPublicKey, input) {
  const prefix = Buffer.from('CREDITLEDGER-ATTEST-V1', 'utf8');
  const contractXdr = new Address(contractAddress).toScVal().toXDR();
  const attIdBuf = Buffer.from(input.attestationIdHex, 'hex');
  const subjectXdr = new Address(input.subjectPublicKey).toScVal().toXDR();
  const issuerXdr = new Address(issuerPublicKey).toScVal().toXDR();

  const kindBuf = Buffer.alloc(4);
  kindBuf.writeUInt32BE(input.kind, 0);
  const commitBuf = Buffer.from(input.recordCommitmentHex, 'hex');
  const metricBuf = Buffer.alloc(4);
  metricBuf.writeUInt32BE(input.metricScore, 0);

  const amountBuf = Buffer.alloc(16);
  let rem = BigInt(input.amountUnits);
  for (let i = 15; i >= 0; i--) {
    amountBuf[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }

  const durBuf = Buffer.alloc(4);
  durBuf.writeUInt32BE(input.durationMonths, 0);
  const issuedBuf = Buffer.alloc(8);
  issuedBuf.writeBigUInt64BE(BigInt(input.issuedAt), 0);
  const expBuf = Buffer.alloc(8);
  expBuf.writeBigUInt64BE(BigInt(input.expiresAt), 0);

  return Buffer.concat([
    prefix,
    contractXdr,
    attIdBuf,
    subjectXdr,
    issuerXdr,
    kindBuf,
    commitBuf,
    metricBuf,
    amountBuf,
    durBuf,
    issuedBuf,
    expBuf,
  ]);
}

async function rpcJson(method, params) {
  const res = await fetch(RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const json = await res.json();
  if (json.error) {
    throw new Error(`Soroban RPC ${method} error: ${JSON.stringify(json.error)}`);
  }
  return json.result;
}

async function getOnChainWasmHash(contractId) {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: new Address(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    })
  ).toXDR('base64');

  const res = await rpcJson('getLedgerEntries', { keys: [key] });
  if (!res.entries || res.entries.length === 0) {
    throw new Error(`Contract instance entry not found on Testnet for ${contractId}`);
  }
  const data = xdr.LedgerEntryData.fromXDR(res.entries[0].xdr, 'base64');
  const exec = data.contractData().val().instance().executable();
  if (exec.switch().name !== 'contractExecutableWasm') {
    return exec.switch().name;
  }
  return Buffer.from(exec.wasmHash()).toString('hex');
}

async function fundTestnet(publicKey) {
  const res = await fetch(`${FRIENDBOT_URL}?addr=${encodeURIComponent(publicKey)}`);
  if (!res.ok) {
    throw new Error(`Friendbot funding failed for ${publicKey}: ${res.status}`);
  }
  return res.json();
}

async function pollTx(txHash) {
  for (let i = 0; i < 30; i++) {
    const res = await rpcJson('getTransaction', { hash: txHash });
    if (res.status === 'SUCCESS') {
      let ret = null;
      let createdContractId = null;
      if (Array.isArray(res.diagnosticEventsXdr)) {
        for (let j = res.diagnosticEventsXdr.length - 1; j >= 0; j--) {
          try {
            const ev = xdr.DiagnosticEvent.fromXDR(res.diagnosticEventsXdr[j], 'base64').event();
            const v0 = ev.body()?.v0?.();
            const topics = v0?.topics?.() || [];
            if (topics.length > 0 && scValToNative(topics[0]) === 'fn_return') {
              if (ret === null) ret = scValToNative(v0.data());
              if (!createdContractId && topics[1] && scValToNative(topics[1]) === '__constructor' && ev.contractId()) {
                createdContractId = StrKey.encodeContract(ev.contractId());
              }
            }
          } catch {
            // Skip malformed diagnostic event
          }
        }
      }
      return { hash: txHash, ledger: res.ledger, returnValue: ret, createdContractId };
    }
    if (res.status === 'FAILED') {
      throw new Error(`Transaction ${txHash} failed at ledger ${res.ledger}: ${res.resultXdr}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`Transaction ${txHash} timed out`);
}

async function sendOperation(rpcServer, signerKp, operation, extraSigners = []) {
  const account = await rpcServer.getAccount(signerKp.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(operation)
    .setTimeout(120)
    .build();

  const prepared = await rpcServer.prepareTransaction(tx);
  prepared.sign(signerKp, ...extraSigners);
  const sendRes = await rpcServer.sendTransaction(prepared);
  if (sendRes.status === 'ERROR') {
    throw new Error(`SendTransaction error: ${JSON.stringify(sendRes.errorResult || sendRes)}`);
  }
  return pollTx(sendRes.hash);
}

const SIMULATION_DUMMY_PUBLIC_KEY = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1)).publicKey();

async function simulateCall(rpcServer, contractId, fnName, args = [], sourcePub = SIMULATION_DUMMY_PUBLIC_KEY) {
  let account;
  if (sourcePub === SIMULATION_DUMMY_PUBLIC_KEY) {
    account = new Account(sourcePub, '0');
  } else {
    account = await rpcServer.getAccount(sourcePub);
  }
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: fnName, args })
    )
    .setTimeout(30)
    .build();
  const sim = await rpcServer.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed (${fnName}): ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function expectSimulationRejects(rpcServer, contractId, fnName, args = [], sourcePub = SIMULATION_DUMMY_PUBLIC_KEY) {
  try {
    await simulateCall(rpcServer, contractId, fnName, args, sourcePub);
    return { rejected: false, error: null };
  } catch (err) {
    return { rejected: true, error: err.message };
  }
}

async function main() {
  if (process.env.STELLAR_NETWORK === 'mainnet') {
    throw new Error('Refusing Mainnet execution.');
  }

  const runLive = process.argv.includes('--execute');
  const manifestPath = path.join(ROOT, 'contracts/deployed-testnet-hardened.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const deployed = {
    creditScore: manifest.contracts.creditScore.contractId,
    loanManager: manifest.contracts.loanManager.contractId,
    communityVouch: manifest.contracts.communityVouch.contractId,
  };
  const xlmSacId = Asset.native().contractId(Networks.TESTNET);

  const localHashes = {
    creditScore: sha256File(WASM_PATHS.creditScore),
    loanManager: sha256File(WASM_PATHS.loanManager),
    communityVouch: sha256File(WASM_PATHS.communityVouch),
  };

  console.log('=== PHASE 11A: ON-CHAIN WASM HASH & LEGACY CONTRACT PARITY ===');
  const wasmParity = {};
  for (const key of ['creditScore', 'loanManager', 'communityVouch']) {
    const chainHash = await getOnChainWasmHash(deployed[key]);
    const matches = chainHash === localHashes[key].sha256;
    if (!matches) {
      throw new Error(`WASM hash mismatch for ${key}: on-chain=${chainHash} vs local=${localHashes[key].sha256}`);
    }
    const legacyHash = await getOnChainWasmHash(LEGACY_CONTRACTS[key]);
    wasmParity[key] = {
      deployedId: deployed[key],
      localSha256: localHashes[key].sha256,
      onChainWasmHash: chainHash,
      exactMatch: matches,
      legacyId: LEGACY_CONTRACTS[key],
      legacyOnChainWasmHash: legacyHash,
      legacyUntouchedAndDistinct: legacyHash !== chainHash,
    };
    console.log(`  ${key}: deployed=${deployed[key]} sha256=${chainHash} MATCH=${matches} | legacy=${LEGACY_CONTRACTS[key]} sha256=${legacyHash}`);
  }

  // Horizon SAC / deployed account spot check
  const hRes = await fetch(`${HORIZON_URL}/ledgers?order=desc&limit=1`);
  const hJson = await hRes.json();
  const horizonLedger = hJson._embedded?.records?.[0]?.sequence;
  console.log(`  Horizon latest ledger: #${horizonLedger} | Native XLM SAC: ${xlmSacId}`);

  if (!runLive) {
    console.log('\n[READ-ONLY] WASM parity verified. Pass --execute with ALLOW_EPHEMERAL_KEYS=1 CONFIRM_TESTNET_DEPLOY=1 to run live positive & negative transactions.');
    return;
  }
  if (process.env.ALLOW_EPHEMERAL_KEYS !== '1' || process.env.CONFIRM_TESTNET_DEPLOY !== '1') {
    throw new Error('Pass ALLOW_EPHEMERAL_KEYS=1 CONFIRM_TESTNET_DEPLOY=1 with --execute.');
  }

  const rpcServer = new rpc.Server(RPC_URL);
  const existingTxs = [];
  const existingChecks = [];
  const recExistingTx = (label, tx) => {
    existingTxs.push({ label, hash: tx.hash, ledger: tx.ledger });
    console.log(`  [LIVE-EXISTING] ${label}: tx=${tx.hash} (ledger #${tx.ledger})`);
  };

  console.log('\n=== PHASE 11B: LIVE TX & NEGATIVE TESTS ON EXISTING DEPLOYED HARDENED CONTRACTS ===');
  const actorAKp = Keypair.random();
  const actorBKp = Keypair.random();
  await fundTestnet(actorAKp.publicKey());
  await fundTestnet(actorBKp.publicKey());
  console.log(`  Funded actorA=${actorAKp.publicKey()}, actorB=${actorBKp.publicKey()}`);

  // 1. Existing CreditScore: unauthorized pause live-submitted without admin auth MUST fail on-chain
  let unauthPauseRejected = false;
  let unauthPauseError = '';
  try {
    await sendOperation(
      rpcServer,
      actorAKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'pause',
        args: [],
      })
    );
  } catch (err) {
    unauthPauseRejected = true;
    unauthPauseError = err instanceof Error ? err.message : String(err);
  }
  if (!unauthPauseRejected) {
    throw new Error('SECURITY FAILURE: Unauthorized actorAKp paused existing CreditScore contract!');
  }
  existingChecks.push({
    check: 'existing_credit_score_unauth_pause_live_submit',
    rejected: unauthPauseRejected,
    error: unauthPauseError,
  });

  const nowTs = Math.floor(Date.now() / 1000) - 20;
  recExistingTx(
    'existing_credit_score.submit_self_reported_record',
    await sendOperation(
      rpcServer,
      actorAKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'submit_self_reported_record',
        args: [
          new Address(actorAKp.publicKey()).toScVal(),
          toStruct([
            ['claimed_amount', u128Val(999_000_000n)],
            ['claimed_metric', nativeToScVal(100, { type: 'u32' })],
            ['duration_months', nativeToScVal(12, { type: 'u32' })],
            ['kind', nativeToScVal(1, { type: 'u32' })],
            ['record_commitment', nativeToScVal(crypto.randomBytes(32), { type: 'bytes' })],
            ['timestamp', nativeToScVal(nowTs, { type: 'u64' })],
          ]),
        ],
      })
    )
  );
  const actorAScore = await simulateCall(rpcServer, deployed.creditScore, 'get_credit_score', [
    new Address(actorAKp.publicKey()).toScVal(),
  ]);
  if (actorAScore.score !== 0) {
    throw new Error(`Expected self-reported score 0, got ${actorAScore.score}`);
  }
  existingChecks.push({ check: 'existing_credit_score_self_report_zero_weight', score: actorAScore.score });

  // 2. Existing LoanManager: unverified create_loan blocked, real XLM SAC deposit -> over-withdraw blocked -> full withdraw refunded
  const unverifiedBorrow = await expectSimulationRejects(
    rpcServer,
    deployed.loanManager,
    'create_loan',
    [
      new Address(actorAKp.publicKey()).toScVal(),
      u128Val(100_000_000n),
      nativeToScVal(6, { type: 'u32' }),
      u128Val(200_000_000n),
    ],
    actorAKp.publicKey()
  );
  existingChecks.push({ check: 'existing_loan_manager_score0_borrow_rejected', ...unverifiedBorrow });

  recExistingTx(
    'existing_loan_manager.deposit_liquidity_120XLM',
    await sendOperation(
      rpcServer,
      actorAKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'deposit_liquidity',
        args: [new Address(actorAKp.publicKey()).toScVal(), u128Val(1_200_000_000n)],
      })
    )
  );
  const depBal = await simulateCall(rpcServer, deployed.loanManager, 'get_lender_balance', [
    new Address(actorAKp.publicKey()).toScVal(),
  ]);
  const withdrawTarget = BigInt(depBal);
  const overWithdraw = await expectSimulationRejects(
    rpcServer,
    deployed.loanManager,
    'withdraw_liquidity',
    [new Address(actorAKp.publicKey()).toScVal(), u128Val(5_000_000_000n)],
    actorAKp.publicKey()
  );
  const nonDepositorWithdraw = await expectSimulationRejects(
    rpcServer,
    deployed.loanManager,
    'withdraw_liquidity',
    [new Address(actorBKp.publicKey()).toScVal(), u128Val(10_000_000n)],
    actorBKp.publicKey()
  );
  existingChecks.push({ check: 'existing_loan_manager_over_balance_withdraw_rejected', ...overWithdraw });
  existingChecks.push({ check: 'existing_loan_manager_non_depositor_withdraw_rejected', ...nonDepositorWithdraw });

  recExistingTx(
    `existing_loan_manager.withdraw_liquidity_${withdrawTarget}stroops`,
    await sendOperation(
      rpcServer,
      actorAKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'withdraw_liquidity',
        args: [new Address(actorAKp.publicKey()).toScVal(), u128Val(withdrawTarget)],
      })
    )
  );
  const postWdrBal = await simulateCall(rpcServer, deployed.loanManager, 'get_lender_balance', [
    new Address(actorAKp.publicKey()).toScVal(),
  ]);
  existingChecks.push({
    check: 'existing_loan_manager_sac_deposit_withdraw_parity',
    depositedBal: String(depBal),
    postWithdrawBal: String(postWdrBal),
  });

  // 3. Existing CommunityVouch: self-vouch rejected, 25 XLM real SAC vouch -> duplicate pair rejected -> revoke refund -> double withdraw rejected
  const selfVouch = await expectSimulationRejects(
    rpcServer,
    deployed.communityVouch,
    'create_vouch',
    [
      new Address(actorAKp.publicKey()).toScVal(),
      new Address(actorAKp.publicKey()).toScVal(),
      u128Val(250_000_000n),
      nativeToScVal('Self check', { type: 'string' }),
      nativeToScVal(6, { type: 'u32' }),
    ],
    actorAKp.publicKey()
  );
  existingChecks.push({ check: 'existing_community_vouch_self_vouch_rejected', ...selfVouch });

  const vTx = await sendOperation(
    rpcServer,
    actorAKp,
    Operation.invokeContractFunction({
      contract: deployed.communityVouch,
      function: 'create_vouch',
      args: [
        new Address(actorAKp.publicKey()).toScVal(),
        new Address(actorBKp.publicKey()).toScVal(),
        u128Val(250_000_000n),
        nativeToScVal('Peer vouch live check', { type: 'string' }),
        nativeToScVal(6, { type: 'u32' }),
      ],
    })
  );
  recExistingTx('existing_community_vouch.create_vouch_25XLM', vTx);
  const existingVouchId = Number(vTx.returnValue);

  const dupVouch = await expectSimulationRejects(
    rpcServer,
    deployed.communityVouch,
    'create_vouch',
    [
      new Address(actorAKp.publicKey()).toScVal(),
      new Address(actorBKp.publicKey()).toScVal(),
      u128Val(250_000_000n),
      nativeToScVal('Duplicate pair', { type: 'string' }),
      nativeToScVal(6, { type: 'u32' }),
    ],
    actorAKp.publicKey()
  );
  existingChecks.push({ check: 'existing_community_vouch_duplicate_pair_rejected', ...dupVouch });

  recExistingTx(
    'existing_community_vouch.revoke_vouch_refund',
    await sendOperation(
      rpcServer,
      actorAKp,
      Operation.invokeContractFunction({
        contract: deployed.communityVouch,
        function: 'revoke_vouch',
        args: [new Address(actorAKp.publicKey()).toScVal(), nativeToScVal(existingVouchId, { type: 'u64' })],
      })
    )
  );
  const doubleWdr = await expectSimulationRejects(
    rpcServer,
    deployed.communityVouch,
    'withdraw_remaining_escrow',
    [new Address(actorAKp.publicKey()).toScVal(), nativeToScVal(existingVouchId, { type: 'u64' })],
    actorAKp.publicKey()
  );
  existingChecks.push({ check: 'existing_community_vouch_double_withdraw_rejected', ...doubleWdr });

  console.log('\n=== PHASE 11C: ADMIN-GATED NEGATIVE & COLLATERALIZED 50-59 BORROW LIFECYCLE (IDENTICAL WASM INSTANCE) ===');
  const adminKp = Keypair.random();
  const issuerKp = Keypair.random();
  const lenderKp = Keypair.random();
  const colBorrowerKp = Keypair.random();
  for (const kp of [adminKp, issuerKp, lenderKp, colBorrowerKp]) {
    await fundTestnet(kp.publicKey());
  }

  const adminTxs = [];
  const adminChecks = [];
  const recAdminTx = (label, tx) => {
    adminTxs.push({ label, hash: tx.hash, ledger: tx.ledger });
    console.log(`  [LIVE-ADMIN-SCENARIO] ${label}: tx=${tx.hash} (ledger #${tx.ledger})`);
  };

  // Instantiate using already-uploaded WASM hashes (identical bytes to deployed v2!)
  const tmpIds = {};
  for (const key of ['creditScore', 'loanManager', 'communityVouch']) {
    const createTx = await sendOperation(
      rpcServer,
      adminKp,
      Operation.createCustomContract({
        address: Address.fromString(adminKp.publicKey()),
        wasmHash: Buffer.from(localHashes[key].sha256, 'hex'),
        salt: crypto.randomBytes(32),
      })
    );
    recAdminTx(`instantiate_${key}`, createTx);
    tmpIds[key] = createTx.createdContractId || String(createTx.returnValue);
  }

  recAdminTx(
    'credit_score.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'initialize',
        args: [new Address(adminKp.publicKey()).toScVal()],
      })
    )
  );
  recAdminTx(
    'community_vouch.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.communityVouch,
        function: 'initialize',
        args: [
          new Address(adminKp.publicKey()).toScVal(),
          new Address(tmpIds.creditScore).toScVal(),
          new Address(xlmSacId).toScVal(),
        ],
      })
    )
  );
  recAdminTx(
    'loan_manager.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'initialize',
        args: [
          new Address(adminKp.publicKey()).toScVal(),
          new Address(tmpIds.creditScore).toScVal(),
          new Address(xlmSacId).toScVal(),
          new Address(xlmSacId).toScVal(),
        ],
      })
    )
  );
  recAdminTx(
    'wire_credit_to_loan',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'set_loan_manager_contract',
        args: [new Address(tmpIds.loanManager).toScVal()],
      })
    )
  );
  recAdminTx(
    'wire_credit_to_vouch',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'set_community_vouch_contract',
        args: [new Address(tmpIds.communityVouch).toScVal()],
      })
    )
  );
  recAdminTx(
    'wire_vouch_to_loan',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.communityVouch,
        function: 'set_loan_manager_contract',
        args: [new Address(tmpIds.loanManager).toScVal(), new Address(tmpIds.loanManager).toScVal()],
      })
    )
  );
  recAdminTx(
    'wire_loan_to_vouch',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'set_community_vouch_contract',
        args: [new Address(tmpIds.communityVouch).toScVal()],
      })
    )
  );
  recAdminTx(
    'register_issuer',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'register_issuer',
        args: [
          new Address(issuerKp.publicKey()).toScVal(),
          nativeToScVal(issuerKp.rawPublicKey(), { type: 'bytes' }),
          nativeToScVal(1, { type: 'u32' }),
          nativeToScVal('Verification Attestor', { type: 'string' }),
          nativeToScVal('https://attestor.testnet.example', { type: 'string' }),
        ],
      })
    )
  );

  const ts = Math.floor(Date.now() / 1000) - 30;
  const buildAttScVal = (input) =>
    toStruct([
      ['attestation_id', nativeToScVal(Buffer.from(input.attestationIdHex, 'hex'), { type: 'bytes' })],
      ['subject', new Address(input.subjectPublicKey).toScVal()],
      ['kind', nativeToScVal(input.kind, { type: 'u32' })],
      ['record_commitment', nativeToScVal(Buffer.from(input.recordCommitmentHex, 'hex'), { type: 'bytes' })],
      ['metric_score', nativeToScVal(input.metricScore, { type: 'u32' })],
      ['amount_units', u128Val(input.amountUnits)],
      ['duration_months', nativeToScVal(input.durationMonths, { type: 'u32' })],
      ['issued_at', nativeToScVal(input.issuedAt, { type: 'u64' })],
      ['expires_at', nativeToScVal(input.expiresAt, { type: 'u64' })],
    ]);

  const payInput = {
    attestationIdHex: crypto.randomBytes(32).toString('hex'),
    subjectPublicKey: colBorrowerKp.publicKey(),
    kind: 1,
    recordCommitmentHex: crypto.randomBytes(32).toString('hex'),
    metricScore: 72,
    amountUnits: '500000000',
    durationMonths: 0,
    issuedAt: ts,
    expiresAt: ts + 86400 * 30,
  };
  const payMsg = buildAttestationMessage(tmpIds.creditScore, issuerKp.publicKey(), payInput);
  const paySig = issuerKp.sign(payMsg);

  // Bad signature rejection check (flip 1st byte of signature)
  const badSig = Buffer.from(paySig);
  badSig[0] ^= 0xff;
  const badSigRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.creditScore,
    'submit_signed_attestation',
    [
      new Address(colBorrowerKp.publicKey()).toScVal(),
      new Address(issuerKp.publicKey()).toScVal(),
      buildAttScVal(payInput),
      nativeToScVal(badSig, { type: 'bytes' }),
    ],
    colBorrowerKp.publicKey()
  );
  adminChecks.push({ check: 'invalid_ed25519_attestation_signature_rejected', ...badSigRejected });

  // Expired attestation rejection check
  const expiredInput = {
    ...payInput,
    attestationIdHex: crypto.randomBytes(32).toString('hex'),
    issuedAt: ts - 86400,
    expiresAt: ts - 60,
  };
  const expiredSig = issuerKp.sign(
    buildAttestationMessage(tmpIds.creditScore, issuerKp.publicKey(), expiredInput)
  );
  const expiredAttRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.creditScore,
    'submit_signed_attestation',
    [
      new Address(colBorrowerKp.publicKey()).toScVal(),
      new Address(issuerKp.publicKey()).toScVal(),
      buildAttScVal(expiredInput),
      nativeToScVal(expiredSig, { type: 'bytes' }),
    ],
    colBorrowerKp.publicKey()
  );
  adminChecks.push({ check: 'expired_attestation_rejected', ...expiredAttRejected });

  // Valid payment & savings attestations putting borrower strictly into 56/100 base collateral tier!
  recAdminTx(
    'submit_signed_payment_72',
    await sendOperation(
      rpcServer,
      colBorrowerKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'submit_signed_attestation',
        args: [
          new Address(colBorrowerKp.publicKey()).toScVal(),
          new Address(issuerKp.publicKey()).toScVal(),
          buildAttScVal(payInput),
          nativeToScVal(paySig, { type: 'bytes' }),
        ],
      })
    )
  );

  // Replay exact same attestation_id must reject
  const replayAttRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.creditScore,
    'submit_signed_attestation',
    [
      new Address(colBorrowerKp.publicKey()).toScVal(),
      new Address(issuerKp.publicKey()).toScVal(),
      buildAttScVal(payInput),
      nativeToScVal(paySig, { type: 'bytes' }),
    ],
    colBorrowerKp.publicKey()
  );
  adminChecks.push({ check: 'duplicate_attestation_replay_rejected', ...replayAttRejected });

  const savInput = {
    attestationIdHex: crypto.randomBytes(32).toString('hex'),
    subjectPublicKey: colBorrowerKp.publicKey(),
    kind: 2,
    recordCommitmentHex: crypto.randomBytes(32).toString('hex'),
    metricScore: 68,
    amountUnits: '500000000',
    durationMonths: 3,
    issuedAt: ts,
    expiresAt: ts + 86400 * 30,
  };
  const savSig = issuerKp.sign(buildAttestationMessage(tmpIds.creditScore, issuerKp.publicKey(), savInput));
  recAdminTx(
    'submit_signed_savings_68_3m',
    await sendOperation(
      rpcServer,
      colBorrowerKp,
      Operation.invokeContractFunction({
        contract: tmpIds.creditScore,
        function: 'submit_signed_attestation',
        args: [
          new Address(colBorrowerKp.publicKey()).toScVal(),
          new Address(issuerKp.publicKey()).toScVal(),
          buildAttScVal(savInput),
          nativeToScVal(savSig, { type: 'bytes' }),
        ],
      })
    )
  );

  const preLoanScore = await simulateCall(rpcServer, tmpIds.creditScore, 'get_score_breakdown', [
    new Address(colBorrowerKp.publicKey()).toScVal(),
  ]);
  const reqCol = await simulateCall(rpcServer, tmpIds.loanManager, 'get_required_collateral', [
    new Address(colBorrowerKp.publicKey()).toScVal(),
    u128Val(400_000_000n), // 40 XLM -> expects 50 XLM (500_000_000 stroops) collateral
  ]);
  if (Number(preLoanScore.score) !== 56 || BigInt(reqCol) !== 500_000_000n) {
    throw new Error(`Expected score 56 & reqCol 500000000, got score=${preLoanScore.score} reqCol=${reqCol}`);
  }
  adminChecks.push({
    check: 'base_tier_56_mandatory_collateral_computed',
    score: preLoanScore.score,
    requiredCollateralStroops: String(reqCol),
  });

  // Under-collateralized loan creation (40 XLM with 40 XLM collateral instead of 50 XLM) MUST REJECT!
  const underColRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.loanManager,
    'create_loan',
    [
      new Address(colBorrowerKp.publicKey()).toScVal(),
      u128Val(400_000_000n),
      nativeToScVal(6, { type: 'u32' }),
      u128Val(400_000_000n),
    ],
    colBorrowerKp.publicKey()
  );
  adminChecks.push({ check: 'under_collateralized_loan_rejected', ...underColRejected });

  // Deposit 60 XLM pool liquidity -> create mandatory 50 XLM collateralized 40 XLM loan -> approve & disburse
  recAdminTx(
    'deposit_pool_60XLM',
    await sendOperation(
      rpcServer,
      lenderKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'deposit_liquidity',
        args: [new Address(lenderKp.publicKey()).toScVal(), u128Val(600_000_000n)],
      })
    )
  );
  const colLoanTx = await sendOperation(
    rpcServer,
    colBorrowerKp,
    Operation.invokeContractFunction({
      contract: tmpIds.loanManager,
      function: 'create_loan',
      args: [
        new Address(colBorrowerKp.publicKey()).toScVal(),
        u128Val(400_000_000n),
        nativeToScVal(6, { type: 'u32' }),
        u128Val(500_000_000n),
      ],
    })
  );
  recAdminTx('create_mandatory_collateral_loan_40XLM_50XLM_col', colLoanTx);
  const colLoanId = Number(colLoanTx.returnValue);

  recAdminTx(
    'approve_collateral_loan',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'approve_loan',
        args: [new Address(adminKp.publicKey()).toScVal(), nativeToScVal(colLoanId, { type: 'u64' })],
      })
    )
  );

  // Pool cash is now 20 XLM while 40 XLM is active -> withdrawing 30 XLM exceeds available_cash!
  const drainCommittedRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.loanManager,
    'withdraw_liquidity',
    [new Address(lenderKp.publicKey()).toScVal(), u128Val(300_000_000n)],
    lenderKp.publicKey()
  );
  adminChecks.push({ check: 'withdraw_committed_liquidity_rejected', ...drainCommittedRejected });

  // Premature mark_default rejected while loan is not yet due
  const earlyDefaultRejected = await expectSimulationRejects(
    rpcServer,
    tmpIds.loanManager,
    'mark_default',
    [new Address(adminKp.publicKey()).toScVal(), nativeToScVal(colLoanId, { type: 'u64' })],
    adminKp.publicKey()
  );
  adminChecks.push({ check: 'premature_mark_default_rejected', ...earlyDefaultRejected });

  // Partial repayment (20 XLM = 200_000_000), then inspect schedule & final repay
  const sched1 = await simulateCall(rpcServer, tmpIds.loanManager, 'get_repayment_schedule', [
    nativeToScVal(colLoanId, { type: 'u64' }),
  ]);
  const partialAmt = 200_000_000n;
  const finalAmt = BigInt(sched1.total_remaining_due) - partialAmt;

  recAdminTx(
    'partial_repay_20XLM',
    await sendOperation(
      rpcServer,
      colBorrowerKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'repay_loan',
        args: [new Address(colBorrowerKp.publicKey()).toScVal(), nativeToScVal(colLoanId, { type: 'u64' }), u128Val(partialAmt)],
      })
    )
  );
  recAdminTx(
    'final_repay_and_unlock_collateral',
    await sendOperation(
      rpcServer,
      colBorrowerKp,
      Operation.invokeContractFunction({
        contract: tmpIds.loanManager,
        function: 'repay_loan',
        args: [new Address(colBorrowerKp.publicKey()).toScVal(), nativeToScVal(colLoanId, { type: 'u64' }), u128Val(finalAmt)],
      })
    )
  );

  const postLoan = await simulateCall(rpcServer, tmpIds.loanManager, 'get_loan', [
    nativeToScVal(colLoanId, { type: 'u64' }),
  ]);
  const postScore = await simulateCall(rpcServer, tmpIds.creditScore, 'get_score_breakdown', [
    new Address(colBorrowerKp.publicKey()).toScVal(),
  ]);
  const poolFinal = await simulateCall(rpcServer, tmpIds.loanManager, 'get_pool_state');
  console.log('\n=== SUMMARY OUTPUT (JSON) ===');
  console.log(
    JSON.stringify(
      {
        timestamp: new Date().toISOString(),
        horizonLedger,
        wasmParity,
        existingContractTests: { checks: existingChecks, transactions: existingTxs },
        adminScenarioTests: {
          ephemeralContractsWithIdenticalWasm: tmpIds,
          checks: adminChecks,
          collateralLoanId: colLoanId,
          finalLoanStatus: String(postLoan.status),
          collateralLockedAfterRepay: Boolean(postLoan.collateral_locked),
          preLoanScore: preLoanScore.score,
          postRepayScore: postScore.score,
          postRepayLoansCount: postScore.repaid_loans,
          poolAvailableCashAfter: String(poolFinal.available_cash),
          transactions: adminTxs,
        },
      },
      (_, v) => (typeof v === 'bigint' ? v.toString() : v),
      2
    )
  );
}

main().catch((err) => {
  console.error('\n[FAILED]', err);
  process.exit(1);
});
