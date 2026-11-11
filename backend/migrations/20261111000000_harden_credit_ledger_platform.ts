import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Extend users with explicit role support
  const hasRole = await knex.schema.hasColumn('users', 'role');
  if (!hasRole) {
    await knex.schema.alterTable('users', (table) => {
      table.string('role', 24).notNullable().defaultTo('borrower');
      table.boolean('is_active').notNullable().defaultTo(true);
    });
  }

  // Extend credit_score_cache with repayment_score and model_version
  const hasModelVersion = await knex.schema.hasColumn('credit_score_cache', 'model_version');
  if (!hasModelVersion) {
    await knex.schema.alterTable('credit_score_cache', (table) => {
      table.integer('repayment_score').notNullable().defaultTo(0);
      table.integer('model_version').notNullable().defaultTo(2);
    });
  }

  // Extend loans with collateral, principal/interest split, and on-chain tx_hash reconciliation
  const hasCollateralAmt = await knex.schema.hasColumn('loans', 'collateral_amount');
  if (!hasCollateralAmt) {
    await knex.schema.alterTable('loans', (table) => {
      table.string('collateral_amount', 40).notNullable().defaultTo('0');
      table.boolean('collateral_locked').notNullable().defaultTo(false);
      table.string('principal_repaid', 40).notNullable().defaultTo('0');
      table.string('interest_repaid', 40).notNullable().defaultTo('0');
      table.string('scheduled_interest', 40).notNullable().defaultTo('0');
      table.string('tx_hash', 64);
    });
  }

  // Extend vouches with escrow balance, slashed amount, withdrawal state, tx_hash
  const hasEscrowed = await knex.schema.hasColumn('vouches', 'escrowed_balance');
  if (!hasEscrowed) {
    await knex.schema.alterTable('vouches', (table) => {
      table.string('escrowed_balance', 40).notNullable().defaultTo('0');
      table.string('slashed_amount', 40).notNullable().defaultTo('0');
      table.boolean('withdrawn').notNullable().defaultTo(false);
      table.string('tx_hash', 64);
    });
  }

  // Session & refresh token rotation tracking
  if (!(await knex.schema.hasTable('user_sessions'))) {
    await knex.schema.createTable('user_sessions', (table) => {
      table.string('id', 64).primary();
      table.string('family_id', 64).notNullable();
      table.string('public_key', 56).notNullable().references('public_key').inTable('users').onDelete('CASCADE');
      table.string('role', 24).notNullable().defaultTo('borrower');
      table.string('refresh_token_hash', 64).notNullable().unique();
      table.string('access_jti', 64).notNullable();
      table.timestamp('expires_at', { useTz: true }).notNullable();
      table.timestamp('revoked_at', { useTz: true });
      table.string('replaced_by_session_id', 64);
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['public_key', 'family_id'], 'idx_sessions_user_family');
    });
  }

  // Encrypted off-chain financial records (AES-256-GCM at rest)
  if (!(await knex.schema.hasTable('encrypted_financial_records'))) {
    await knex.schema.createTable('encrypted_financial_records', (table) => {
      table.string('id', 64).primary();
      table.string('owner_public_key', 56).notNullable().references('public_key').inTable('users').onDelete('CASCADE');
      table.string('issuer_public_key', 56);
      table.string('attestation_id', 64);
      table.string('record_kind', 24).notNullable(); // payment | savings | supplementary
      table.string('record_commitment', 64).notNullable();
      table.text('ciphertext').notNullable();
      table.string('iv', 32).notNullable();
      table.string('auth_tag', 32).notNullable();
      table.boolean('verified').notNullable().defaultTo(false);
      table.timestamp('expires_at', { useTz: true });
      table.timestamp('deleted_at', { useTz: true });
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['owner_public_key', 'verified'], 'idx_enc_records_owner');
    });
  }

  // Selective disclosure & user consent grants
  if (!(await knex.schema.hasTable('consent_grants'))) {
    await knex.schema.createTable('consent_grants', (table) => {
      table.string('id', 64).primary();
      table.string('owner_public_key', 56).notNullable().references('public_key').inTable('users').onDelete('CASCADE');
      table.string('grantee_public_key', 56).notNullable();
      table.text('scope_json').notNullable();
      table.text('record_ids_json').notNullable();
      table.timestamp('expires_at', { useTz: true }).notNullable();
      table.timestamp('revoked_at', { useTz: true });
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['owner_public_key', 'grantee_public_key'], 'idx_consent_pair');
    });
  }

  // Financial operation idempotency registry
  if (!(await knex.schema.hasTable('idempotency_keys'))) {
    await knex.schema.createTable('idempotency_keys', (table) => {
      table.increments('id').primary();
      table.string('idempotency_key', 128).notNullable();
      table.string('actor_public_key', 56).notNullable();
      table.string('route', 128).notNullable();
      table.string('request_hash', 64).notNullable();
      table.integer('status_code').notNullable();
      table.text('response_json').notNullable();
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('expires_at', { useTz: true }).notNullable();
      table.unique(['actor_public_key', 'route', 'idempotency_key'], 'uq_idempotency_actor_route_key');
    });
  }

  // Stellar transaction reconciliation log
  if (!(await knex.schema.hasTable('stellar_transactions'))) {
    await knex.schema.createTable('stellar_transactions', (table) => {
      table.string('tx_hash', 64).primary();
      table.string('operation_type', 48).notNullable();
      table.string('actor_public_key', 56).notNullable();
      table.string('contract_id', 56);
      table.string('status', 20).notNullable().defaultTo('pending'); // pending | confirmed | failed
      table.bigInteger('ledger_sequence');
      table.string('amount_stroops', 40).notNullable().defaultTo('0');
      table.text('metadata_json');
      table.timestamp('reconciled_at', { useTz: true });
      table.integer('retry_count').notNullable().defaultTo(0);
      table.text('last_error');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['status', 'updated_at'], 'idx_stellar_tx_status');
      table.index(['actor_public_key'], 'idx_stellar_tx_actor');
    });
  }

  // Genuine credit score history snapshots for real trends
  if (!(await knex.schema.hasTable('score_snapshots'))) {
    await knex.schema.createTable('score_snapshots', (table) => {
      table.increments('id').primary();
      table.string('public_key', 56).notNullable().references('public_key').inTable('users').onDelete('CASCADE');
      table.integer('model_version').notNullable().defaultTo(2);
      table.integer('score').notNullable();
      table.integer('payment_history_score').notNullable().defaultTo(0);
      table.integer('savings_score').notNullable().defaultTo(0);
      table.integer('repayment_score').notNullable().defaultTo(0);
      table.integer('community_score').notNullable().defaultTo(0);
      table.integer('activity_score').notNullable().defaultTo(0);
      table.timestamp('recorded_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['public_key', 'recorded_at'], 'idx_score_snapshots_user_time');
    });
  }

  // Lender liquidity pool position snapshots
  if (!(await knex.schema.hasTable('lender_positions'))) {
    await knex.schema.createTable('lender_positions', (table) => {
      table.string('lender_public_key', 56).primary().references('public_key').inTable('users').onDelete('CASCADE');
      table.string('shares_stroops', 40).notNullable().defaultTo('0');
      table.string('deposited_stroops', 40).notNullable().defaultTo('0');
      table.string('withdrawn_stroops', 40).notNullable().defaultTo('0');
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    });
  }

  // Structured immutable security/financial audit logs
  if (!(await knex.schema.hasTable('audit_logs'))) {
    await knex.schema.createTable('audit_logs', (table) => {
      table.increments('id').primary();
      table.string('actor_public_key', 56);
      table.string('action', 64).notNullable();
      table.string('resource_type', 48);
      table.string('resource_id', 128);
      table.string('status', 24).notNullable();
      table.text('details_json');
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.index(['action', 'created_at'], 'idx_audit_action_time');
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
  await knex.schema.dropTableIfExists('lender_positions');
  await knex.schema.dropTableIfExists('score_snapshots');
  await knex.schema.dropTableIfExists('stellar_transactions');
  await knex.schema.dropTableIfExists('idempotency_keys');
  await knex.schema.dropTableIfExists('consent_grants');
  await knex.schema.dropTableIfExists('encrypted_financial_records');
  await knex.schema.dropTableIfExists('user_sessions');

  if (await knex.schema.hasColumn('vouches', 'escrowed_balance')) {
    await knex.schema.alterTable('vouches', (table) => {
      table.dropColumn('escrowed_balance');
      table.dropColumn('slashed_amount');
      table.dropColumn('withdrawn');
      table.dropColumn('tx_hash');
    });
  }

  if (await knex.schema.hasColumn('loans', 'collateral_amount')) {
    await knex.schema.alterTable('loans', (table) => {
      table.dropColumn('collateral_amount');
      table.dropColumn('collateral_locked');
      table.dropColumn('principal_repaid');
      table.dropColumn('interest_repaid');
      table.dropColumn('scheduled_interest');
      table.dropColumn('tx_hash');
    });
  }

  if (await knex.schema.hasColumn('credit_score_cache', 'model_version')) {
    await knex.schema.alterTable('credit_score_cache', (table) => {
      table.dropColumn('repayment_score');
      table.dropColumn('model_version');
    });
  }

  if (await knex.schema.hasColumn('users', 'role')) {
    await knex.schema.alterTable('users', (table) => {
      table.dropColumn('role');
      table.dropColumn('is_active');
    });
  }
}
