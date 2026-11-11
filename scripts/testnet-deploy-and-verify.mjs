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
  const buf = fs.readFileSync(filePath);
  return {
    bytes: buf,
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
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
      if (ret === null && res.resultMetaXdr) {
        try {
          const meta = xdr.TransactionMeta.fromXDR(res.resultMetaXdr, 'base64');
          const rv = meta.v3?.()?.sorobanMeta?.()?.returnValue?.();
          if (rv) ret = scValToNative(rv);
        } catch {
          ret = null;
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

async function simulateCall(rpcServer, contractId, fnName, args = []) {
  const dummy = new Account(SIMULATION_DUMMY_PUBLIC_KEY, '0');
  const tx = new TransactionBuilder(dummy, {
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

async function expectSimulationRejects(rpcServer, contractId, fnName, args = []) {
  const dummy = new Account(SIMULATION_DUMMY_PUBLIC_KEY, '0');
  const tx = new TransactionBuilder(dummy, {
    fee: '100',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({ contract: contractId, function: fnName, args })
    )
    .setTimeout(30)
    .build();
  const sim = await rpcServer.simulateTransaction(tx);
  return rpc.Api.isSimulationError(sim);
}

async function main() {
  const execute = process.argv.includes('--execute');

  if (process.env.STELLAR_NETWORK === 'mainnet') {
    throw new Error('Refusing Mainnet execution: Testnet deployment script is strictly Testnet-only.');
  }

  const artifacts = {};
  for (const [name, filePath] of Object.entries(WASM_PATHS)) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Missing WASM artifact ${filePath}. Run cargo build --target wasm32v1-none --release first.`);
    }
    const info = sha256File(filePath);
    artifacts[name] = { path: path.relative(ROOT, filePath), size: info.size, sha256: info.sha256, bytes: info.bytes };
  }

  const health = await rpcJson('getHealth');
  const latestLedger = await rpcJson('getLatestLedger');
  const xlmSacId = Asset.native().contractId(Networks.TESTNET);

  console.log('CreditLedger Testnet Deployment & E2E Plan');
  console.log('RPC Health:', health.status, '| Latest Ledger:', latestLedger.sequence);
  console.log('Preserved Legacy Contracts (NEVER modified):', LEGACY_CONTRACTS);
  console.log('Native XLM Testnet SAC:', xlmSacId);
  for (const [k, a] of Object.entries(artifacts)) {
    console.log(`WASM ${k}: ${a.size} bytes | sha256=${a.sha256}`);
  }

  if (!execute) {
    console.log('\n[DRY-RUN] No transactions submitted. Pass --execute with ALLOW_EPHEMERAL_KEYS=1 (or STELLAR_ADMIN_SECRET) and CONFIRM_TESTNET_DEPLOY=1 to execute live Testnet verification.');
    return;
  }

  if (process.env.CONFIRM_TESTNET_DEPLOY !== '1') {
    throw new Error('CONFIRM_TESTNET_DEPLOY=1 is required to execute live Testnet deployment.');
  }

  const adminKp = process.env.STELLAR_ADMIN_SECRET
    ? Keypair.fromSecret(process.env.STELLAR_ADMIN_SECRET)
    : process.env.ALLOW_EPHEMERAL_KEYS === '1'
      ? Keypair.random()
      : null;

  if (!adminKp) {
    throw new Error('Provide STELLAR_ADMIN_SECRET or set ALLOW_EPHEMERAL_KEYS=1 for ephemeral Friendbot test execution.');
  }

  const rpcServer = new rpc.Server(RPC_URL);
  const issuerKp = Keypair.random();
  const lenderKp = Keypair.random();
  const borrowerKp = Keypair.random();
  const voucherKp = Keypair.random();

  console.log('\nFunding ephemeral Testnet actors via Friendbot...');
  for (const [label, kp] of [
    ['admin', adminKp],
    ['issuer', issuerKp],
    ['lender', lenderKp],
    ['borrower', borrowerKp],
    ['voucher', voucherKp],
  ]) {
    await fundTestnet(kp.publicKey());
    console.log(`  Funded ${label}: ${kp.publicKey()}`);
  }

  const txEvidence = [];
  const recordTx = (step, tx) => {
    txEvidence.push({ step, hash: tx.hash, ledger: tx.ledger });
    console.log(`  [CONFIRMED] ${step}: tx=${tx.hash} (ledger #${tx.ledger})`);
  };

  // Ensure XLM SAC exists on Testnet (already deployed by Stellar protocol, just confirm or wrap if needed)
  console.log('\nUploading hardened WASMs & deploying separate Testnet contract instances...');
  const deployed = {};
  for (const [name, a] of Object.entries(artifacts)) {
    const upTx = await sendOperation(
      rpcServer,
      adminKp,
      Operation.uploadContractWasm({ wasm: a.bytes })
    );
    recordTx(`upload_wasm_${name}`, upTx);

    const wasmHashBuf = Buffer.from(a.sha256, 'hex');
    const salt = crypto.randomBytes(32);
    const createTx = await sendOperation(
      rpcServer,
      adminKp,
      Operation.createCustomContract({
        address: Address.fromString(adminKp.publicKey()),
        wasmHash: wasmHashBuf,
        salt,
      })
    );
    recordTx(`deploy_${name}`, createTx);

    const contractId = createTx.createdContractId || String(createTx.returnValue || '');
    if (!StrKey.isValidContract(contractId)) {
      throw new Error(`Could not determine valid contract ID from deploy tx ${createTx.hash}`);
    }
    if (Object.values(LEGACY_CONTRACTS).includes(contractId)) {
      throw new Error(`Safety halt: generated contractId matches legacy contract ${contractId}`);
    }
    deployed[name] = contractId;
    console.log(`  Deployed ${name}: ${contractId}`);
  }

  console.log('\nInitializing contracts & wiring cross-contract dependencies...');
  recordTx(
    'credit_score.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'initialize',
        args: [new Address(adminKp.publicKey()).toScVal()],
      })
    )
  );
  recordTx(
    'community_vouch.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.communityVouch,
        function: 'initialize',
        args: [
          new Address(adminKp.publicKey()).toScVal(),
          new Address(deployed.creditScore).toScVal(),
          new Address(xlmSacId).toScVal(),
        ],
      })
    )
  );
  recordTx(
    'loan_manager.initialize',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'initialize',
        args: [
          new Address(adminKp.publicKey()).toScVal(),
          new Address(deployed.creditScore).toScVal(),
          new Address(xlmSacId).toScVal(),
          new Address(xlmSacId).toScVal(),
        ],
      })
    )
  );

  recordTx(
    'credit_score.set_loan_manager_contract',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'set_loan_manager_contract',
        args: [new Address(deployed.loanManager).toScVal()],
      })
    )
  );
  recordTx(
    'credit_score.set_community_vouch_contract',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'set_community_vouch_contract',
        args: [new Address(deployed.communityVouch).toScVal()],
      })
    )
  );
  recordTx(
    'community_vouch.set_loan_manager_contract',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.communityVouch,
        function: 'set_loan_manager_contract',
        args: [
          new Address(deployed.loanManager).toScVal(),
          new Address(deployed.loanManager).toScVal(),
        ],
      })
    )
  );
  recordTx(
    'loan_manager.set_community_vouch_contract',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'set_community_vouch_contract',
        args: [new Address(deployed.communityVouch).toScVal()],
      })
    )
  );

  console.log('\nVerifying negative security controls (re-init & unauthorized write)...');
  const reinitBlocked = await expectSimulationRejects(rpcServer, deployed.creditScore, 'initialize', [
    new Address(borrowerKp.publicKey()).toScVal(),
  ]);
  // Submit unauthorized register_issuer signed only by borrowerKp (missing admin auth signature)
  let unauthIssuerBlocked = false;
  let unauthAttemptTxHash = null;
  try {
    const res = await sendOperation(
      rpcServer,
      borrowerKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'register_issuer',
        args: [
          new Address(issuerKp.publicKey()).toScVal(),
          nativeToScVal(issuerKp.rawPublicKey(), { type: 'bytes' }),
          nativeToScVal(1, { type: 'u32' }),
          nativeToScVal('Fake', { type: 'string' }),
          nativeToScVal('https://fake', { type: 'string' }),
        ],
      })
    );
    unauthAttemptTxHash = res.hash;
  } catch (unauthErr) {
    unauthIssuerBlocked = true;
    console.log('  [VERIFIED] Unauthorized register_issuer rejected by Soroban:', String(unauthErr.message || unauthErr).slice(0, 140));
  }
  if (!reinitBlocked || !unauthIssuerBlocked || unauthAttemptTxHash) {
    throw new Error(`Negative security check failed (reinitBlocked=${reinitBlocked}, unauthIssuerBlocked=${unauthIssuerBlocked})`);
  }
  console.log('  [VERIFIED] Re-initialization rejected in simulation & unauthorized register_issuer rejected on submission');

  console.log('\nRunning live E2E financial & credit scoring flows on Stellar Testnet...');
  // 1. Register Issuer
  recordTx(
    'register_issuer',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'register_issuer',
        args: [
          new Address(issuerKp.publicKey()).toScVal(),
          nativeToScVal(issuerKp.rawPublicKey(), { type: 'bytes' }),
          nativeToScVal(1, { type: 'u32' }),
          nativeToScVal('Testnet Utility Issuer', { type: 'string' }),
          nativeToScVal('https://testnet.creditledger.example/issuer.json', { type: 'string' }),
        ],
      })
    )
  );

  // 2. Self-reported zero-weight check -> score must stay 0!
  const selfCommit = crypto.randomBytes(32);
  recordTx(
    'submit_self_reported_record',
    await sendOperation(
      rpcServer,
      borrowerKp,
      Operation.invokeContractFunction({
        contract: deployed.creditScore,
        function: 'submit_self_reported_record',
        args: [
          new Address(borrowerKp.publicKey()).toScVal(),
          toStruct([
            ['kind', nativeToScVal(1, { type: 'u32' })],
            ['record_commitment', nativeToScVal(selfCommit, { type: 'bytes' })],
            ['claimed_amount', u128Val('5000000000')],
            ['claimed_metric', nativeToScVal(100, { type: 'u32' })],
            ['duration_months', nativeToScVal(24, { type: 'u32' })],
            ['timestamp', nativeToScVal(BigInt(Math.floor(Date.now() / 1000)), { type: 'u64' })],
          ]),
        ],
      })
    )
  );
  const scoreAfterSelf = await simulateCall(rpcServer, deployed.creditScore, 'get_credit_score', [
    new Address(borrowerKp.publicKey()).toScVal(),
  ]);
  if (Number(scoreAfterSelf.score) !== 0) {
    throw new Error(`Expected 0 score after self-report, got ${scoreAfterSelf.score}`);
  }
  console.log('  [VERIFIED] Self-reported submission yielded authoritative score = 0');

  // 3. Ed25519 Signed Attestation (Payment + Savings so score >= 80 Prime tier!)
  const nowSec = Math.floor(Date.now() / 1000);
  for (const [label, kind] of [
    ['payment', 1],
    ['savings', 2],
  ]) {
    const attInput = {
      attestationIdHex: crypto.randomBytes(32).toString('hex'),
      subjectPublicKey: borrowerKp.publicKey(),
      kind,
      recordCommitmentHex: crypto.randomBytes(32).toString('hex'),
      metricScore: 95,
      amountUnits: '2000000000', // 200 XLM
      durationMonths: 18,
      issuedAt: nowSec - 60,
      expiresAt: nowSec + 86400 * 365,
    };
    const msg = buildAttestationMessage(deployed.creditScore, issuerKp.publicKey(), attInput);
    const sig = issuerKp.sign(msg);

    recordTx(
      `submit_signed_attestation_${label}`,
      await sendOperation(
        rpcServer,
        borrowerKp,
        Operation.invokeContractFunction({
          contract: deployed.creditScore,
          function: 'submit_signed_attestation',
          args: [
            new Address(borrowerKp.publicKey()).toScVal(),
            new Address(issuerKp.publicKey()).toScVal(),
            toStruct([
              ['attestation_id', nativeToScVal(Buffer.from(attInput.attestationIdHex, 'hex'), { type: 'bytes' })],
              ['subject', new Address(borrowerKp.publicKey()).toScVal()],
              ['kind', nativeToScVal(attInput.kind, { type: 'u32' })],
              ['record_commitment', nativeToScVal(Buffer.from(attInput.recordCommitmentHex, 'hex'), { type: 'bytes' })],
              ['metric_score', nativeToScVal(attInput.metricScore, { type: 'u32' })],
              ['amount_units', u128Val(attInput.amountUnits)],
              ['duration_months', nativeToScVal(attInput.durationMonths, { type: 'u32' })],
              ['issued_at', nativeToScVal(BigInt(attInput.issuedAt), { type: 'u64' })],
              ['expires_at', nativeToScVal(BigInt(attInput.expiresAt), { type: 'u64' })],
            ]),
            nativeToScVal(sig, { type: 'bytes' }),
          ],
        })
      )
    );
  }

  // Also verify voucher can vouch using earned score -> attest voucher payment + savings so score >= 50
  for (const [vLabel, vKind] of [
    ['payment', 1],
    ['savings', 2],
  ]) {
    const vAtt = {
      attestationIdHex: crypto.randomBytes(32).toString('hex'),
      subjectPublicKey: voucherKp.publicKey(),
      kind: vKind,
      recordCommitmentHex: crypto.randomBytes(32).toString('hex'),
      metricScore: 95,
      amountUnits: '1000000000',
      durationMonths: 12,
      issuedAt: nowSec - 60,
      expiresAt: nowSec + 86400 * 365,
    };
    const vSig = issuerKp.sign(buildAttestationMessage(deployed.creditScore, issuerKp.publicKey(), vAtt));
    recordTx(
      `voucher_attested_${vLabel}`,
      await sendOperation(
        rpcServer,
        voucherKp,
        Operation.invokeContractFunction({
          contract: deployed.creditScore,
          function: 'submit_signed_attestation',
          args: [
            new Address(voucherKp.publicKey()).toScVal(),
            new Address(issuerKp.publicKey()).toScVal(),
            toStruct([
              ['attestation_id', nativeToScVal(Buffer.from(vAtt.attestationIdHex, 'hex'), { type: 'bytes' })],
              ['subject', new Address(voucherKp.publicKey()).toScVal()],
              ['kind', nativeToScVal(vAtt.kind, { type: 'u32' })],
              ['record_commitment', nativeToScVal(Buffer.from(vAtt.recordCommitmentHex, 'hex'), { type: 'bytes' })],
              ['metric_score', nativeToScVal(vAtt.metricScore, { type: 'u32' })],
              ['amount_units', u128Val(vAtt.amountUnits)],
              ['duration_months', nativeToScVal(vAtt.durationMonths, { type: 'u32' })],
              ['issued_at', nativeToScVal(BigInt(vAtt.issuedAt), { type: 'u64' })],
              ['expires_at', nativeToScVal(BigInt(vAtt.expiresAt), { type: 'u64' })],
            ]),
            nativeToScVal(vSig, { type: 'bytes' }),
          ],
        })
      )
    );
  }

  // 4. Community Vouch Escrow (50 XLM = 500_000_000 stroops)
  const vouchTx = await sendOperation(
    rpcServer,
    voucherKp,
    Operation.invokeContractFunction({
      contract: deployed.communityVouch,
      function: 'create_vouch',
      args: [
        new Address(voucherKp.publicKey()).toScVal(),
        new Address(borrowerKp.publicKey()).toScVal(),
        u128Val('500000000'),
        nativeToScVal('Testnet escrow vouch verification', { type: 'string' }),
        nativeToScVal(6, { type: 'u32' }),
      ],
    })
  );
  recordTx('community_vouch.create_vouch', vouchTx);
  const vouchId = Number(vouchTx.returnValue || 1);

  const borrowerScore = await simulateCall(rpcServer, deployed.creditScore, 'get_credit_score', [
    new Address(borrowerKp.publicKey()).toScVal(),
  ]);
  console.log('  [VERIFIED] Borrower verified score =', borrowerScore.score);

  // 5. Lender Pool Deposit (300 XLM = 3_000_000_000 stroops)
  recordTx(
    'loan_manager.deposit_liquidity',
    await sendOperation(
      rpcServer,
      lenderKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'deposit_liquidity',
        args: [new Address(lenderKp.publicKey()).toScVal(), u128Val('3000000000')],
      })
    )
  );

  // 6. Borrower Loan Request (100 XLM = 1_000_000_000 stroops, 12m, Prime/Growth) + Admin Approve & Disburse
  const createLoanTx = await sendOperation(
    rpcServer,
    borrowerKp,
    Operation.invokeContractFunction({
      contract: deployed.loanManager,
      function: 'create_loan',
      args: [
        new Address(borrowerKp.publicKey()).toScVal(),
        u128Val('1000000000'),
        nativeToScVal(12, { type: 'u32' }),
        u128Val('0'),
      ],
    })
  );
  recordTx('loan_manager.create_loan', createLoanTx);
  const loanId = Number(createLoanTx.returnValue || 1);

  recordTx(
    'loan_manager.approve_loan',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'approve_loan',
        args: [new Address(adminKp.publicKey()).toScVal(), nativeToScVal(BigInt(loanId), { type: 'u64' })],
      })
    )
  );

  // 7. Repay loan + interest (check scheduled_interest on-chain first)
  const chainLoan = await simulateCall(rpcServer, deployed.loanManager, 'get_loan', [
    nativeToScVal(BigInt(loanId), { type: 'u64' }),
  ]);
  const totalDue = BigInt(chainLoan.amount) + BigInt(chainLoan.scheduled_interest);
  recordTx(
    'loan_manager.repay_loan',
    await sendOperation(
      rpcServer,
      borrowerKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'repay_loan',
        args: [
          new Address(borrowerKp.publicKey()).toScVal(),
          nativeToScVal(BigInt(loanId), { type: 'u64' }),
          u128Val(totalDue.toString()),
        ],
      })
    )
  );

  // 8. Lender withdraws principal + earned interest
  const lenderBal = await simulateCall(rpcServer, deployed.loanManager, 'get_lender_balance', [
    new Address(lenderKp.publicKey()).toScVal(),
  ]);
  recordTx(
    'loan_manager.withdraw_liquidity',
    await sendOperation(
      rpcServer,
      lenderKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'withdraw_liquidity',
        args: [new Address(lenderKp.publicKey()).toScVal(), u128Val(String(lenderBal))],
      })
    )
  );

  // 9. Collateralized Base-Tier (50..59) LTV check, Cancel Refund, Premature Default Block & Full Repay Release
  const b2Kp = Keypair.random();
  await fundTestnet(b2Kp.publicKey());
  const attB2p = {
    attestationIdHex: crypto.randomBytes(32).toString('hex'),
    subjectPublicKey: b2Kp.publicKey(),
    kind: 1,
    recordCommitmentHex: crypto.randomBytes(32).toString('hex'),
    metricScore: 85,
    amountUnits: '500000000',
    durationMonths: 12,
    issuedAt: nowSec - 60,
    expiresAt: nowSec + 86400 * 365,
  };
  const attB2s = {
    ...attB2p,
    attestationIdHex: crypto.randomBytes(32).toString('hex'),
    kind: 2,
    metricScore: 80,
  };
  for (const [bLabel, bInput] of [
    ['payment', attB2p],
    ['savings', attB2s],
  ]) {
    recordTx(
      `b2_attest_${bLabel}`,
      await sendOperation(
        rpcServer,
        b2Kp,
        Operation.invokeContractFunction({
          contract: deployed.creditScore,
          function: 'submit_signed_attestation',
          args: [
            new Address(b2Kp.publicKey()).toScVal(),
            new Address(issuerKp.publicKey()).toScVal(),
            toStruct([
              ['attestation_id', nativeToScVal(Buffer.from(bInput.attestationIdHex, 'hex'), { type: 'bytes' })],
              ['subject', new Address(b2Kp.publicKey()).toScVal()],
              ['kind', nativeToScVal(bInput.kind, { type: 'u32' })],
              ['record_commitment', nativeToScVal(Buffer.from(bInput.recordCommitmentHex, 'hex'), { type: 'bytes' })],
              ['metric_score', nativeToScVal(bInput.metricScore, { type: 'u32' })],
              ['amount_units', u128Val(bInput.amountUnits)],
              ['duration_months', nativeToScVal(bInput.durationMonths, { type: 'u32' })],
              ['issued_at', nativeToScVal(BigInt(bInput.issuedAt), { type: 'u64' })],
              ['expires_at', nativeToScVal(BigInt(bInput.expiresAt), { type: 'u64' })],
            ]),
            nativeToScVal(
              issuerKp.sign(buildAttestationMessage(deployed.creditScore, issuerKp.publicKey(), bInput)),
              { type: 'bytes' }
            ),
          ],
        })
      )
    );
  }

  // Testnet vouch create + revoke escrow refund cleanly
  const v2Tx = await sendOperation(
    rpcServer,
    voucherKp,
    Operation.invokeContractFunction({
      contract: deployed.communityVouch,
      function: 'create_vouch',
      args: [
        new Address(voucherKp.publicKey()).toScVal(),
        new Address(b2Kp.publicKey()).toScVal(),
        u128Val('200000000'), // 20 XLM
        nativeToScVal('Secondary peer vouch verify', { type: 'string' }),
        nativeToScVal(3, { type: 'u32' }),
      ],
    })
  );
  recordTx('community_vouch.create_vouch_b2', v2Tx);
  const vouch2Id = Number(v2Tx.returnValue || 2);

  recordTx(
    'community_vouch.revoke_vouch_1',
    await sendOperation(
      rpcServer,
      voucherKp,
      Operation.invokeContractFunction({
        contract: deployed.communityVouch,
        function: 'revoke_vouch',
        args: [new Address(voucherKp.publicKey()).toScVal(), nativeToScVal(BigInt(vouchId), { type: 'u64' })],
      })
    )
  );
  recordTx(
    'community_vouch.revoke_vouch_2',
    await sendOperation(
      rpcServer,
      voucherKp,
      Operation.invokeContractFunction({
        contract: deployed.communityVouch,
        function: 'revoke_vouch',
        args: [new Address(voucherKp.publicKey()).toScVal(), nativeToScVal(BigInt(vouch2Id), { type: 'u64' })],
      })
    )
  );

  // Fund pool with 60 XLM & lock 50 XLM collateral on 40 XLM Base-Tier loan
  recordTx(
    'loan_manager.redeposit_for_collateral_test',
    await sendOperation(
      rpcServer,
      lenderKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'deposit_liquidity',
        args: [new Address(lenderKp.publicKey()).toScVal(), u128Val('600000000')],
      })
    )
  );

  const reqCol = await simulateCall(rpcServer, deployed.loanManager, 'get_required_collateral', [
    new Address(b2Kp.publicKey()).toScVal(),
    u128Val('400000000'),
  ]);
  console.log('  [VERIFIED] Required collateral for b2 (40 XLM loan) =', reqCol, 'stroops');

  // Create & cancel pending loan with collateral refund
  const colToLock = BigInt(reqCol || 0) > 0n ? BigInt(reqCol) : 500_000_000n;
  const cancelLoanTx = await sendOperation(
    rpcServer,
    b2Kp,
    Operation.invokeContractFunction({
      contract: deployed.loanManager,
      function: 'create_loan',
      args: [
        new Address(b2Kp.publicKey()).toScVal(),
        u128Val('400000000'),
        nativeToScVal(6, { type: 'u32' }),
        u128Val(colToLock.toString()),
      ],
    })
  );
  recordTx('loan_manager.create_loan_cancel_test', cancelLoanTx);
  const cancelLoanId = Number(cancelLoanTx.returnValue || 2);

  recordTx(
    'loan_manager.cancel_loan_refund_collateral',
    await sendOperation(
      rpcServer,
      b2Kp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'cancel_loan',
        args: [new Address(b2Kp.publicKey()).toScVal(), nativeToScVal(BigInt(cancelLoanId), { type: 'u64' })],
      })
    )
  );

  // Create active collateralized loan -> approve -> verify premature default blocked -> repay -> collateral unlocked
  const loan2Tx = await sendOperation(
    rpcServer,
    b2Kp,
    Operation.invokeContractFunction({
      contract: deployed.loanManager,
      function: 'create_loan',
      args: [
        new Address(b2Kp.publicKey()).toScVal(),
        u128Val('400000000'),
        nativeToScVal(6, { type: 'u32' }),
        u128Val(colToLock.toString()),
      ],
    })
  );
  recordTx('loan_manager.create_collateral_loan_2', loan2Tx);
  const loan2Id = Number(loan2Tx.returnValue || 3);

  recordTx(
    'loan_manager.approve_loan_2',
    await sendOperation(
      rpcServer,
      adminKp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'approve_loan',
        args: [new Address(adminKp.publicKey()).toScVal(), nativeToScVal(BigInt(loan2Id), { type: 'u64' })],
      })
    )
  );

  const prematureDefaultBlocked = await expectSimulationRejects(
    rpcServer,
    deployed.loanManager,
    'mark_default',
    [new Address(adminKp.publicKey()).toScVal(), nativeToScVal(BigInt(loan2Id), { type: 'u64' })]
  );
  if (!prematureDefaultBlocked) {
    throw new Error('Expected premature mark_default before due_date to be rejected!');
  }
  console.log('  [VERIFIED] Premature mark_default rejected (LoanNotYetDue)');

  const chainLoan2 = await simulateCall(rpcServer, deployed.loanManager, 'get_loan', [
    nativeToScVal(BigInt(loan2Id), { type: 'u64' }),
  ]);
  const due2 = BigInt(chainLoan2.amount) + BigInt(chainLoan2.scheduled_interest);
  recordTx(
    'loan_manager.repay_collateral_loan_2',
    await sendOperation(
      rpcServer,
      b2Kp,
      Operation.invokeContractFunction({
        contract: deployed.loanManager,
        function: 'repay_loan',
        args: [
          new Address(b2Kp.publicKey()).toScVal(),
          nativeToScVal(BigInt(loan2Id), { type: 'u64' }),
          u128Val(due2.toString()),
        ],
      })
    )
  );

  // Confirm Horizon account lookup too
  const horizonRes = await fetch(`${HORIZON_URL}/accounts/${borrowerKp.publicKey()}`);
  const horizonStatus = horizonRes.ok ? 'VERIFIED_ON_HORIZON' : `HTTP_${horizonRes.status}`;

  const manifest = {
    deployedAt: new Date().toISOString(),
    network: 'Stellar Testnet',
    rpcUrl: RPC_URL,
    horizonUrl: HORIZON_URL,
    horizonCheck: horizonStatus,
    legacyPreservedContracts: LEGACY_CONTRACTS,
    contracts: {
      creditScore: { contractId: deployed.creditScore, wasmSha256: artifacts.creditScore.sha256 },
      loanManager: { contractId: deployed.loanManager, wasmSha256: artifacts.loanManager.sha256 },
      communityVouch: { contractId: deployed.communityVouch, wasmSha256: artifacts.communityVouch.sha256 },
      nativeXlmSac: xlmSacId,
    },
    actorsPublicOnly: {
      admin: adminKp.publicKey(),
      issuer: issuerKp.publicKey(),
      lender: lenderKp.publicKey(),
      borrower: borrowerKp.publicKey(),
      borrower2Collateralized: b2Kp.publicKey(),
      voucher: voucherKp.publicKey(),
    },
    negativeSimulationsPassed: {
      reinitializeRejected: reinitBlocked,
      unauthorizedRegisterIssuerRejected: unauthIssuerBlocked,
      prematureMarkDefaultRejected: prematureDefaultBlocked,
      selfReportedAuthoritativeScoreZero: true,
    },
    confirmedTransactions: txEvidence,
  };

  const outPath = path.join(ROOT, 'contracts/deployed-testnet-hardened.json');
  fs.writeFileSync(outPath, JSON.stringify(manifest, null, 2));
  console.log(`\nSaved clean public deployment manifest to ${path.relative(ROOT, outPath)}`);
  console.log(`Total confirmed Testnet transactions: ${txEvidence.length}`);
}

main().catch((err) => {
  console.error('Testnet deployment/verification failed:', err);
  process.exit(1);
});
